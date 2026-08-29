import type { Adapter, AdapterContext } from "./types";
import type { ConsumptionPayload, InferencePerformancePayload, ObservationEnvelope } from "../shared/types";
import { newId, nowIso } from "../shared/util";

// LM Studio adapter (research: docs/research/issue-2-lmstudio.md).
//
// LM Studio has NO historical usage surface — stats exist only per-response.
// v0 passively taps `lms log stream --source model --filter output --stats
// --json`: each llm.prediction.output event carries a typed stats object
// (promptTokensCount, predictedTokensCount, tokensPerSecond,
// timeToFirstTokenSec, ...). Events also carry completion text, which is
// dropped in-process and never persisted. Requests made while the agent is
// down are permanently unobservable; that is inherent to the provider.

const ADAPTER_VERSION = "0.1.0";
const DEFAULT_BASE_URL = "http://127.0.0.1:1234";

interface PredictionStats {
  promptTokensCount?: number;
  predictedTokensCount?: number;
  totalTokensCount?: number;
  tokensPerSecond?: number;
  timeToFirstTokenSec?: number;
  totalTimeSec?: number;
  stopReason?: string;
}

interface CapturedEvent {
  ts: string;
  model: string | null;
  stats: PredictionStats;
}

// Singleton stream state: the lms subprocess outlives individual collect()
// calls; collect() drains what accumulated since the last cycle.
let streamProc: ReturnType<typeof Bun.spawn> | null = null;
let captured: CapturedEvent[] = [];
let streamError: string | null = null;

function extractStats(obj: unknown): { stats: PredictionStats; model: string | null } | null {
  // Defensive: the event shape comes from an RPC named unstable_streamLogs.
  // Find a stats-shaped object at any of the known nesting points; ignore
  // (and thereby drop) all text/content fields.
  const candidates: unknown[] = [];
  const push = (v: unknown) => v && typeof v === "object" && candidates.push(v);
  const o = obj as Record<string, any>;
  push(o?.stats);
  push(o?.data?.stats);
  push(o?.log?.stats);
  push(o?.data?.log?.stats);
  let model: string | null =
    o?.modelIdentifier ?? o?.data?.modelIdentifier ?? o?.log?.modelIdentifier ?? o?.data?.log?.modelIdentifier ?? null;
  for (const c of candidates) {
    const s = c as PredictionStats;
    if (s.predictedTokensCount != null || s.promptTokensCount != null || s.tokensPerSecond != null) {
      return { stats: s, model };
    }
  }
  return null;
}

async function ensureStream(): Promise<void> {
  if (streamProc && streamProc.exitCode === null) return;
  streamError = null;
  try {
    streamProc = Bun.spawn(["lms", "log", "stream", "--source", "model", "--filter", "output", "--stats", "--json"], {
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch (err) {
    streamError = `failed to start lms log stream: ${err}`;
    streamProc = null;
    return;
  }
  const proc = streamProc;
  (async () => {
    const reader = proc.stdout as ReadableStream<Uint8Array>;
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of reader) {
        buf += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const found = extractStats(JSON.parse(line));
            if (found) captured.push({ ts: nowIso(), model: found.model, stats: found.stats });
          } catch {
            // non-JSON output line; ignore
          }
        }
      }
    } catch {
      // stream ended; next collect() restarts it
    }
  })();
}

/** kill the lms subprocess so short-lived commands (tests) can exit */
export function stopLmStudioStream(): void {
  streamProc?.kill();
  streamProc = null;
}

export const lmStudioAdapter: Adapter = {
  providerId: "lmstudio",
  adapterId: "lmstudio.log_stream",
  adapterVersion: ADAPTER_VERSION,

  async detect(ctx) {
    const baseUrl = (ctx.settings["base_url"] as string) ?? DEFAULT_BASE_URL;
    try {
      const res = await fetch(`${baseUrl}/api/v0/models`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  },

  async collect(ctx: AdapterContext): Promise<ObservationEnvelope[]> {
    await ensureStream();
    const out: ObservationEnvelope[] = [];

    if (streamError) {
      out.push(
        env(ctx, { type: "adapter_status", status: "temporarily_failed", message: streamError }, nowIso())
      );
      return out;
    }

    const drained = captured;
    captured = [];
    for (const ev of drained) {
      const s = ev.stats;
      const consumption: ConsumptionPayload = {
        type: "consumption",
        period_start: ev.ts,
        period_end: ev.ts,
        model: ev.model,
        input_tokens: s.promptTokensCount ?? null,
        output_tokens: s.predictedTokensCount ?? null,
        total_tokens: s.totalTokensCount ?? null,
        requests: 1,
        counting: "provider_reported",
      };
      out.push(env(ctx, consumption, ev.ts));

      if (s.tokensPerSecond != null || s.timeToFirstTokenSec != null) {
        const perf: InferencePerformancePayload = {
          type: "inference_performance",
          model: ev.model,
          time_to_first_token_ms: s.timeToFirstTokenSec != null ? Math.round(s.timeToFirstTokenSec * 1000) : null,
          tokens_per_second: s.tokensPerSecond ?? null,
          duration_ms: s.totalTimeSec != null ? Math.round(s.totalTimeSec * 1000) : null,
          input_tokens: s.promptTokensCount ?? null,
          output_tokens: s.predictedTokensCount ?? null,
        };
        out.push(env(ctx, perf, ev.ts));
      }
    }
    return out;
  },
};

function env(ctx: AdapterContext, payload: ObservationEnvelope["payload"], observedAt: string): ObservationEnvelope {
  return {
    schema_version: 1,
    observation_id: newId(),
    node_id: ctx.nodeId,
    provider_id: "lmstudio",
    observed_at: observedAt,
    collected_at: nowIso(),
    adapter_id: lmStudioAdapter.adapterId,
    adapter_version: ADAPTER_VERSION,
    source_quality: "official_cli",
    payload,
  };
}
