import { BurnClient } from "./client";
import {
  openAgentDb,
  enqueue,
  peekBatch,
  ack,
  markAttempt,
  outboxDepth,
  beginSession,
  endSession,
} from "./db";
import { loadConfig, loadCredentials, DEFAULT_COLLECT_SECONDS, DEFAULT_HEARTBEAT_SECONDS } from "../shared/config";
import { newId, nowIso } from "../shared/util";
import { enabledAdapters } from "../providers/registry";
import { stopLmStudioStream } from "../providers/lmstudio";
import type { AdapterContext } from "../providers/types";
import type { ObservationEnvelope } from "../shared/types";

const AGENT_VERSION = "0.1.0";

export async function runAgent(opts?: { once?: boolean }): Promise<void> {
  const creds = loadCredentials();
  if (!creds.node) {
    console.error("This node is not enrolled. Run: burn enroll [server-url]");
    process.exit(1);
  }
  const cfg = loadConfig();
  const client = new BurnClient(cfg.agent?.server_url ?? creds.node.server_url, creds.node.node_token);
  const db = openAgentDb();
  const nodeId = creds.node.node_id;

  const bootId = newId();
  const { previousUnclean } = beginSession(db, bootId);
  let previousSession = previousUnclean
    ? { boot_id: previousUnclean, termination: "unclean_or_unknown" as const }
    : null;

  const heartbeatSeconds = cfg.agent?.heartbeat_interval_seconds ?? DEFAULT_HEARTBEAT_SECONDS;
  const collectSeconds = cfg.agent?.collect_interval_seconds ?? DEFAULT_COLLECT_SECONDS;

  const heartbeat = async () => {
    try {
      await client.heartbeat({
        sent_at: nowIso(),
        boot_id: bootId,
        agent_version: AGENT_VERSION,
        previous_session: previousSession,
      });
      previousSession = null; // report prior unclean termination once
    } catch (err) {
      console.error(`[heartbeat] ${err}`);
    }
  };

  // Adapter failure cannot prevent heartbeats or other adapters (issue #7).
  const collect = async () => {
    for (const adapter of enabledAdapters(cfg)) {
      const providerCfg = cfg.providers?.[adapter.providerId];
      const ctx: AdapterContext = {
        nodeId,
        db,
        settings: providerCfg?.settings ?? {},
        credentials: creds.providers?.[adapter.providerId] ?? {},
      };
      try {
        if (!(await adapter.detect(ctx))) continue;
        const observations = await adapter.collect(ctx);
        if (observations.length > 0) {
          enqueue(db, observations);
          console.log(`[${adapter.providerId}] queued ${observations.length} observation(s)`);
        }
      } catch (err) {
        console.error(`[${adapter.providerId}] collect failed: ${err}`);
        enqueue(db, [statusObservation(adapter.providerId, adapter.adapterId, adapter.adapterVersion, nodeId, String(err))]);
      }
    }
  };

  const flush = async () => {
    while (true) {
      const batch = peekBatch(db);
      if (batch.length === 0) return;
      try {
        const result = await client.sendObservations(batch);
        ack(db, [...result.accepted, ...result.duplicate]);
        for (const r of result.rejected) {
          // Rejected observations would retry forever; drop them loudly.
          console.error(`[flush] rejected ${r.observation_id}: ${r.reason}`);
          ack(db, [r.observation_id]);
        }
        if (batch.length < 200) return;
      } catch (err) {
        markAttempt(db, batch.map((b) => b.observation_id), String(err));
        console.error(`[flush] delivery failed (${outboxDepth(db)} queued): ${err}`);
        return; // retry next cycle; outbox preserves everything
      }
    }
  };

  const cycle = async () => {
    await collect();
    await flush();
  };

  await heartbeat();
  await cycle();
  if (opts?.once) {
    stopLmStudioStream();
    endSession(db, bootId);
    console.log(`Done. Outbox depth: ${outboxDepth(db)}`);
    process.exit(0);
  }

  console.log(
    `burn agent running (node ${nodeId}); heartbeat ${heartbeatSeconds}s, collect ${collectSeconds}s`
  );
  const hbTimer = setInterval(heartbeat, heartbeatSeconds * 1000);
  const collectTimer = setInterval(cycle, collectSeconds * 1000);

  const shutdown = () => {
    clearInterval(hbTimer);
    clearInterval(collectTimer);
    stopLmStudioStream();
    endSession(db, bootId);
    console.log("burn agent stopped");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await new Promise(() => {}); // run until signaled
}

function statusObservation(
  providerId: ObservationEnvelope["provider_id"],
  adapterId: string,
  adapterVersion: string,
  nodeId: string,
  message: string
): ObservationEnvelope {
  return {
    schema_version: 1,
    observation_id: newId(),
    node_id: nodeId,
    provider_id: providerId,
    observed_at: nowIso(),
    collected_at: nowIso(),
    adapter_id: adapterId,
    adapter_version: adapterVersion,
    source_quality: "official_cli",
    payload: { type: "adapter_status", status: "temporarily_failed", message },
  };
}
