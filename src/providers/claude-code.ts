import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { Glob } from "bun";
import type { Adapter, AdapterContext } from "./types";
import type { ConsumptionPayload, ObservationEnvelope, QuotaSnapshotPayload } from "../shared/types";
import { newId, nowIso } from "../shared/util";
import { readNewRegion, commitRegion } from "./jsonl";
import { stateDir } from "../shared/paths";
import { getCursor, setCursor } from "../agent/db";

// Claude Code adapter (research: docs/research/issue-3-claude-code.md).
//
// Consumption: ~/.claude/projects/**/*.jsonl assistant lines carry
// message.usage token counts. The JSONL schema is not a stable contract →
// source_quality local_log. Streaming writes multiple lines per requestId;
// dedup is last-entry-wins within a quiesced region.
//
// Quota: the officially documented statusline stdin JSON carries
// rate_limits.five_hour/seven_day used_percentage + resets_at. The
// `burn claude-statusline` command tees that JSON (redacted) into a state
// file this adapter reads. No credentials are touched; the undocumented
// OAuth usage endpoint is deliberately not used.

const ADAPTER_VERSION = "0.1.0";

export const RATELIMIT_STATE_FILE = () => join(stateDir(), "claude_code_rate_limits.json");

interface UsageLine {
  requestId?: string;
  timestamp?: string;
  message?: {
    model?: string;
    usage?: {
      input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      output_tokens?: number;
    };
  };
}

export const claudeCodeAdapter: Adapter = {
  providerId: "claude_code",
  adapterId: "claude_code.local_jsonl",
  adapterVersion: ADAPTER_VERSION,

  async detect() {
    return existsSync(join(homedir(), ".claude", "projects"));
  },

  async collect(ctx: AdapterContext): Promise<ObservationEnvelope[]> {
    const out: ObservationEnvelope[] = [];
    out.push(...collectConsumption(ctx));
    out.push(...collectQuota(ctx));
    return out;
  },
};

function envelope(ctx: AdapterContext, payload: ObservationEnvelope["payload"], observedAt: string, sourceQuality: ObservationEnvelope["source_quality"]): ObservationEnvelope {
  return {
    schema_version: 1,
    observation_id: newId(),
    node_id: ctx.nodeId,
    provider_id: "claude_code",
    observed_at: observedAt,
    collected_at: nowIso(),
    adapter_id: claudeCodeAdapter.adapterId,
    adapter_version: ADAPTER_VERSION,
    source_quality: sourceQuality,
    payload,
  };
}

function collectConsumption(ctx: AdapterContext): ObservationEnvelope[] {
  const projectsDir = join(homedir(), ".claude", "projects");
  const out: ObservationEnvelope[] = [];
  const glob = new Glob("**/*.jsonl");

  for (const rel of glob.scanSync({ cwd: projectsDir })) {
    const file = join(projectsDir, rel);
    const region = readNewRegion(ctx.db, "claude_code", file);
    if (!region) continue;

    // last-entry-wins per requestId: streaming rewrites usage cumulatively
    const byRequest = new Map<string, UsageLine>();
    for (const raw of region.lines) {
      const line = raw as UsageLine;
      if (!line?.message?.usage) continue;
      // "<synthetic>" lines are Claude Code placeholders with no real usage
      if (line.message.model === "<synthetic>") continue;
      byRequest.set(line.requestId ?? newId(), line);
    }

    // aggregate per model over the region; never invent zeros for absent fields
    const byModel = new Map<string, { input: number; cached: number; output: number; requests: number; first: string; last: string }>();
    for (const line of byRequest.values()) {
      const u = line.message!.usage!;
      const model = line.message!.model ?? "unknown";
      const ts = line.timestamp ?? nowIso();
      const agg = byModel.get(model) ?? { input: 0, cached: 0, output: 0, requests: 0, first: ts, last: ts };
      agg.input += u.input_tokens ?? 0;
      agg.cached += (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      agg.output += u.output_tokens ?? 0;
      agg.requests += 1;
      if (ts < agg.first) agg.first = ts;
      if (ts > agg.last) agg.last = ts;
      byModel.set(model, agg);
    }

    for (const [model, agg] of byModel) {
      const payload: ConsumptionPayload = {
        type: "consumption",
        period_start: agg.first,
        period_end: agg.last,
        model,
        input_tokens: agg.input,
        cached_input_tokens: agg.cached,
        output_tokens: agg.output,
        requests: agg.requests,
        counting: "local_log",
      };
      out.push(envelope(ctx, payload, agg.last, "local_log"));
    }
    commitRegion(ctx.db, "claude_code", region);
  }
  return out;
}

interface RateLimitState {
  captured_at?: string;
  rate_limits?: Record<string, { used_percentage?: number; resets_at?: string | number | null }>;
}

function collectQuota(ctx: AdapterContext): ObservationEnvelope[] {
  const file = RATELIMIT_STATE_FILE();
  if (!existsSync(file)) return [];
  let state: RateLimitState;
  try {
    state = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  if (!state.rate_limits) return [];

  const capturedAt = state.captured_at ?? nowIso();
  // Re-emitting an unchanged snapshot every cycle is noise; only emit when newer.
  const lastEmitted = ctxCursor(ctx, "ratelimits_captured_at");
  if (lastEmitted === capturedAt) return [];

  const windows: Record<string, { label: string; seconds: number | null }> = {
    five_hour: { label: "5h", seconds: 5 * 3600 },
    seven_day: { label: "weekly", seconds: 7 * 86400 },
  };

  const out: ObservationEnvelope[] = [];
  for (const [key, rl] of Object.entries(state.rate_limits)) {
    const w = windows[key] ?? { label: key, seconds: null };
    const resetsAt =
      typeof rl.resets_at === "number" ? new Date(rl.resets_at * 1000).toISOString() : rl.resets_at ?? null;
    const payload: QuotaSnapshotPayload = {
      type: "quota_snapshot",
      window: { kind: "rolling", label: w.label, duration_seconds: w.seconds },
      used_percent: rl.used_percentage ?? null,
      resets_at: resetsAt,
    };
    out.push(envelope(ctx, payload, capturedAt, "official_cli"));
  }
  if (out.length > 0) setCtxCursor(ctx, "ratelimits_captured_at", capturedAt);
  return out;
}

const ctxCursor = (ctx: AdapterContext, key: string) => getCursor(ctx.db, "claude_code", key);
const setCtxCursor = (ctx: AdapterContext, key: string, v: string) => setCursor(ctx.db, "claude_code", key, v);

/**
 * Entry point for the Claude Code statusline integration: reads the
 * documented statusline JSON from stdin, persists ONLY rate-limit fields
 * (never workspace paths, session ids, or cost details) and prints a short
 * statusline so it can be the user's statusline command directly.
 */
export async function claudeStatuslineTee(): Promise<void> {
  const input = await Bun.stdin.text();
  let parsed: { rate_limits?: RateLimitState["rate_limits"]; model?: { display_name?: string } };
  try {
    parsed = JSON.parse(input);
  } catch {
    console.log("burn");
    return;
  }
  if (parsed.rate_limits) {
    const file = RATELIMIT_STATE_FILE();
    await Bun.write(file, JSON.stringify({ captured_at: nowIso(), rate_limits: parsed.rate_limits }, null, 2));
  }
  const fh = parsed.rate_limits?.["five_hour"]?.used_percentage;
  const sd = parsed.rate_limits?.["seven_day"]?.used_percentage;
  const parts = [parsed.model?.display_name ?? "claude"];
  if (fh != null) parts.push(`5h ${Math.round(fh)}%`);
  if (sd != null) parts.push(`wk ${Math.round(sd)}%`);
  console.log(parts.join(" | "));
}
