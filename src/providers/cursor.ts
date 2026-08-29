import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Adapter, AdapterContext } from "./types";
import type { ConsumptionPayload, ObservationEnvelope, QuotaSnapshotPayload } from "../shared/types";
import { newId, nowIso } from "../shared/util";
import { getCursor, setCursor } from "../collector/db";

// Cursor adapter (research: docs/research/issue-8-cursor.md).
//
// Cursor's local files contain no token counts, and the official Admin API
// is Enterprise-team-only — so this adapter uses the internal ConnectRPC
// service Cursor's own dashboard uses (aiserver.v1.DashboardService at
// api2.cursor.sh), authenticated with the OAuth access token the Cursor CLI
// already stores. That surface has no stability contract → experimental_rpc,
// with a shape canary that reports incompatible_version instead of
// ingesting nulls. Cost cents are zeroed by Cursor for self-serve plans
// (since 2026-07-31); tokens remain, so cost_micros is nullable. Account
// email/user fields in responses are never read into observations.

const ADAPTER_VERSION = "0.1.0";
const BASE = "https://api2.cursor.sh/aiserver.v1.DashboardService";
const PAGE_SIZE = 100;
const MAX_PAGES = 20; // per cycle; backfill continues next cycle
const OVERLAP_MS = 24 * 3600_000; // re-fetch window; deterministic IDs dedupe

const AUTH_PATH = () => join(homedir(), ".config", "cursor", "auth.json");

function deterministicId(...parts: string[]): string {
  const h = createHash("sha256").update(parts.join("|")).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

interface UsageEvent {
  timestamp?: string; // epoch ms as string
  model?: string;
  conversationId?: string;
  chargedCents?: number;
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    totalCents?: number;
  };
}

function accessToken(): string | null {
  try {
    const auth = JSON.parse(readFileSync(AUTH_PATH(), "utf8"));
    return typeof auth?.accessToken === "string" ? auth.accessToken : null;
  } catch {
    return null;
  }
}

export const cursorAdapter: Adapter = {
  providerId: "cursor",
  adapterId: "cursor.dashboard_rpc",
  adapterVersion: ADAPTER_VERSION,

  async detect() {
    return existsSync(AUTH_PATH());
  },

  async collect(ctx: AdapterContext): Promise<ObservationEnvelope[]> {
    const token = accessToken();
    if (!token) {
      return [
        env(ctx, newId(), {
          type: "adapter_status",
          status: "authentication_required",
          message: "Cursor login not found or unreadable — run: cursor-agent login",
        }),
      ];
    }

    const rpc = async (method: string, body: unknown): Promise<{ status: number; data: any }> => {
      const res = await fetch(`${BASE}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      return { status: res.status, data: res.ok ? await res.json() : null };
    };

    const out: ObservationEnvelope[] = [];

    // ---- Quota: current billing period ----
    const period = await rpc("GetCurrentPeriodUsage", {});
    if (period.status === 401) {
      out.push(
        env(ctx, newId(), {
          type: "adapter_status",
          status: "authentication_required",
          message: "Cursor rejected the stored token — run: cursor-agent login",
        })
      );
      return out;
    }
    if (period.status === 200 && period.data) {
      const d = period.data;
      const pct = d?.planUsage?.totalPercentUsed;
      const start = Number(d?.billingCycleStart);
      const end = Number(d?.billingCycleEnd);
      if (pct != null || Number.isFinite(end)) {
        const payload: QuotaSnapshotPayload = {
          type: "quota_snapshot",
          window: {
            kind: "fixed",
            label: "billing_cycle",
            duration_seconds:
              Number.isFinite(start) && Number.isFinite(end) ? Math.round((end - start) / 1000) : null,
          },
          used_percent: pct ?? null,
          resets_at: Number.isFinite(end) ? new Date(end).toISOString() : null,
        };
        out.push(env(ctx, newId(), payload));
      }
    }

    // ---- Consumption: per-request events since the high-water mark ----
    const highWater = Number(getCursor(ctx.db, "cursor", "events_high_water_ms") ?? 0);
    const startDate = highWater > 0 ? highWater - OVERLAP_MS : Date.now() - 30 * 86400_000;
    const endDate = Date.now();
    let newHighWater = highWater;
    let sawShape = false;

    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await rpc("GetFilteredUsageEvents", {
        startDate: String(startDate),
        endDate: String(endDate),
        page,
        pageSize: PAGE_SIZE,
      });
      if (res.status !== 200 || !res.data) break;
      const events: UsageEvent[] = res.data.usageEventsDisplay ?? [];
      if (page === 1 && !Array.isArray(res.data.usageEventsDisplay)) {
        // Shape canary: internal proto changed — say so rather than ingest nulls.
        out.push(
          env(ctx, newId(), {
            type: "adapter_status",
            status: "incompatible_version",
            message: "GetFilteredUsageEvents response shape changed (no usageEventsDisplay)",
          })
        );
        return out;
      }
      sawShape = true;

      for (const ev of events) {
        const ts = Number(ev.timestamp);
        if (!Number.isFinite(ts) || !ev.tokenUsage) continue;
        if (ts > newHighWater) newHighWater = ts;
        const observedAt = new Date(ts).toISOString();
        const u = ev.tokenUsage;
        const cents = ev.chargedCents || u.totalCents || 0;
        const payload: ConsumptionPayload = {
          type: "consumption",
          period_start: observedAt,
          period_end: observedAt,
          model: ev.model ?? null,
          input_tokens: u.inputTokens ?? null,
          // cache reads + writes both count as cached input (same treatment
          // as the Claude Code adapter); neither is silently dropped
          cached_input_tokens: (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0) || null,
          output_tokens: u.outputTokens ?? null,
          requests: 1,
          // Zeroed for self-serve plans since 2026-07-31; null rather than $0
          cost_micros: cents > 0 ? Math.round(cents * 10_000) : null,
          currency: cents > 0 ? "USD" : null,
          counting: "provider_reported",
        };
        // No event ID exists; synthesize idempotency from the natural key.
        out.push(
          env(ctx, deterministicId("cursor", String(ts), ev.conversationId ?? "", ev.model ?? ""), payload)
        );
      }
      if (events.length < PAGE_SIZE) break;
    }

    if (sawShape && newHighWater > highWater)
      setCursor(ctx.db, "cursor", "events_high_water_ms", String(newHighWater));
    return out;
  },
};

function env(ctx: AdapterContext, id: string, payload: ObservationEnvelope["payload"]): ObservationEnvelope {
  return {
    schema_version: 1,
    observation_id: id,
    node_id: ctx.nodeId,
    provider_id: "cursor",
    observed_at: payload.type === "consumption" ? payload.period_end : nowIso(),
    collected_at: nowIso(),
    adapter_id: cursorAdapter.adapterId,
    adapter_version: ADAPTER_VERSION,
    source_quality: "experimental_rpc",
    payload,
  };
}
