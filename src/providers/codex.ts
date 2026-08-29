import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { Glob } from "bun";
import type { Adapter, AdapterContext } from "./types";
import type { ConsumptionPayload, ObservationEnvelope, QuotaSnapshotPayload } from "../shared/types";
import { newId, nowIso } from "../shared/util";
import { readNewRegion, commitRegion } from "./jsonl";

// Codex adapter (research: docs/research/issue-5-codex.md).
//
// Session rollout files (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) carry
// `token_count` events with per-turn token usage AND a full rate_limits
// snapshot — zero quota cost, no auth. ONLY token_count events are parsed;
// every other line type may contain prompt/output content and is never read
// into observations. Window layout is plan-dependent, so windows are keyed
// off window_minutes rather than assuming primary=5h. Schema may drift
// between CLI versions → source_quality local_log.

const ADAPTER_VERSION = "0.1.0";

interface TokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

interface RateWindow {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number; // unix seconds (older CLIs used resets_in_seconds)
  resets_in_seconds?: number;
}

interface TokenCountLine {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    info?: { total_token_usage?: TokenUsage; last_token_usage?: TokenUsage; model?: string } | null;
    rate_limits?: { primary?: RateWindow | null; secondary?: RateWindow | null } | null;
  };
}

/** Account identity for quota dedup across machines: the same subscription
 * window is shared by every machine logged into the same account. Read-only
 * peek at auth.json's id_token claims; never touches token values beyond
 * decoding the (non-secret) JWT payload locally. */
let cachedAccountRef: string | null | undefined;
function codexAccountRef(): string | null {
  if (cachedAccountRef !== undefined) return cachedAccountRef;
  cachedAccountRef = null;
  try {
    const auth = JSON.parse(readFileSync(join(homedir(), ".codex", "auth.json"), "utf8"));
    const idToken: string | undefined = auth?.tokens?.id_token;
    if (typeof idToken === "string") {
      const payload = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8"));
      cachedAccountRef = (payload?.email ?? payload?.preferred_username ?? payload?.sub ?? null) as string | null;
    }
  } catch {
    // stays null: quota dedup falls back to per-node
  }
  return cachedAccountRef;
}

export const codexAdapter: Adapter = {
  providerId: "codex",
  adapterId: "codex.session_rollout",
  adapterVersion: ADAPTER_VERSION,

  async detect() {
    return existsSync(join(homedir(), ".codex", "sessions"));
  },

  async collect(ctx: AdapterContext): Promise<ObservationEnvelope[]> {
    const sessionsDir = join(homedir(), ".codex", "sessions");
    const out: ObservationEnvelope[] = [];
    const glob = new Glob("**/rollout-*.jsonl");

    let latestRateLimits: { line: TokenCountLine; ts: string } | null = null;

    for (const rel of glob.scanSync({ cwd: sessionsDir })) {
      const file = join(sessionsDir, rel);
      const region = readNewRegion(ctx.db, "codex", file);
      if (!region) continue;

      // Track per model so usage/cost can be broken down. token_count lines
      // don't name the model; the session's turn_context does — apply the
      // most recent one seen (sessions rarely switch models mid-stream).
      const byModel = new Map<string, { input: number; cached: number; output: number; reasoning: number; requests: number; first: string; last: string }>();
      let currentModel = "unknown";

      for (const raw of region.lines) {
        const line = raw as TokenCountLine;
        const model = (line as any)?.payload?.model ?? (line as any)?.model;
        if (typeof model === "string" && model) currentModel = model;

        const isTokenCount =
          line?.type === "event_msg"
            ? line.payload?.type === "token_count"
            : line?.type === "token_count";
        if (!isTokenCount) continue;

        const ts = line.timestamp ?? nowIso();
        const lastUsage = line.payload?.info?.last_token_usage;
        if (lastUsage) {
          const agg = byModel.get(currentModel) ?? { input: 0, cached: 0, output: 0, reasoning: 0, requests: 0, first: ts, last: ts };
          agg.input += lastUsage.input_tokens ?? 0;
          agg.cached += lastUsage.cached_input_tokens ?? 0;
          agg.output += lastUsage.output_tokens ?? 0;
          agg.reasoning += lastUsage.reasoning_output_tokens ?? 0;
          agg.requests += 1;
          if (ts < agg.first) agg.first = ts;
          if (ts > agg.last) agg.last = ts;
          byModel.set(currentModel, agg);
        }
        // Many token_count lines carry an empty rate_limits shell (both
        // windows null); only a line with at least one real window counts.
        const rl = line.payload?.rate_limits;
        if ((rl?.primary || rl?.secondary) && (!latestRateLimits || ts > latestRateLimits.ts)) {
          latestRateLimits = { line, ts };
        }
      }

      for (const [model, agg] of byModel) {
        const payload: ConsumptionPayload = {
          type: "consumption",
          period_start: agg.first,
          period_end: agg.last,
          model: model === "unknown" ? null : model,
          input_tokens: agg.input,
          cached_input_tokens: agg.cached,
          output_tokens: agg.output,
          reasoning_output_tokens: agg.reasoning,
          requests: agg.requests,
          counting: "local_log",
        };
        out.push(envelope(ctx, payload, agg.last));
      }
      commitRegion(ctx.db, "codex", region);
    }

    if (latestRateLimits) out.push(...quotaSnapshots(ctx, latestRateLimits.line, latestRateLimits.ts));
    return out;
  },
};

function envelope(ctx: AdapterContext, payload: ObservationEnvelope["payload"], observedAt: string): ObservationEnvelope {
  return {
    schema_version: 1,
    observation_id: newId(),
    node_id: ctx.nodeId,
    account_ref: codexAccountRef(),
    provider_id: "codex",
    observed_at: observedAt,
    collected_at: nowIso(),
    adapter_id: codexAdapter.adapterId,
    adapter_version: ADAPTER_VERSION,
    source_quality: "local_log",
    payload,
  };
}

function quotaSnapshots(ctx: AdapterContext, line: TokenCountLine, ts: string): ObservationEnvelope[] {
  const rl = line.payload?.rate_limits;
  if (!rl) return [];
  const out: ObservationEnvelope[] = [];
  for (const [slot, w] of Object.entries({ primary: rl.primary, secondary: rl.secondary })) {
    if (!w) continue;
    const minutes = w.window_minutes ?? null;
    // Label from actual window size; never hard-code primary=5h (plan-dependent).
    const label =
      minutes === 300 ? "5h" : minutes === 10080 ? "weekly" : minutes != null ? `${minutes}m` : slot;
    const resetsAt =
      w.resets_at != null
        ? new Date(w.resets_at * 1000).toISOString()
        : w.resets_in_seconds != null
          ? new Date(Date.parse(ts) + w.resets_in_seconds * 1000).toISOString()
          : null;
    const payload: QuotaSnapshotPayload = {
      type: "quota_snapshot",
      window: { kind: "rolling", label, duration_seconds: minutes != null ? minutes * 60 : null },
      used_percent: w.used_percent ?? null,
      resets_at: resetsAt,
    };
    out.push(envelope(ctx, payload, ts));
  }
  return out;
}
