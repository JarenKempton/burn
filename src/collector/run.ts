import { BurnClient } from "./client";
import {
  openCollectorDb,
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

import { VERSION as COLLECTOR_VERSION } from "../shared/version";

/** Interactive enrollment when the machine isn't connected yet. Used by
 * `collector run` and `collector install` so neither dead-ends. */
export async function ensureEnrolled(): Promise<void> {
  if (loadCredentials().node) return;
  console.log("This machine isn't connected to a Burn server yet.");
  const url = (globalThis.prompt("Server URL (e.g. https://yourserver.ts.net):") ?? "").trim();
  if (!url) {
    console.error("No server URL given. Set up later with: burn enroll <server-url>");
    process.exit(1);
  }
  const { enroll } = await import("./enroll");
  await enroll(url);
  if (!loadCredentials().node) process.exit(1);
}

export async function runCollector(opts?: { once?: boolean; banner?: boolean }): Promise<void> {
  await ensureEnrolled();
  const creds = loadCredentials();
  if (!creds.node) process.exit(1);
  const cfg = loadConfig();
  const client = new BurnClient(cfg.collector?.server_url ?? creds.node.server_url, creds.node.node_token);
  const db = openCollectorDb();
  const nodeId = creds.node.node_id;

  const bootId = newId();
  const { previousUnclean } = beginSession(db, bootId);
  let previousSession = previousUnclean
    ? { boot_id: previousUnclean, termination: "unclean_or_unknown" as const }
    : null;

  const heartbeatSeconds = cfg.collector?.heartbeat_interval_seconds ?? DEFAULT_HEARTBEAT_SECONDS;
  const collectSeconds = cfg.collector?.collect_interval_seconds ?? DEFAULT_COLLECT_SECONDS;

  const heartbeat = async () => {
    try {
      await client.heartbeat({
        sent_at: nowIso(),
        boot_id: bootId,
        collector_version: COLLECTOR_VERSION,
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

  if (!opts?.once && opts?.banner !== false) {
    console.log(
      `burn collector running (node ${nodeId} → ${client.baseUrl}); heartbeat ${heartbeatSeconds}s, collect ${collectSeconds}s`
    );
  }
  await heartbeat();
  await cycle();
  if (opts?.once) {
    stopLmStudioStream();
    endSession(db, bootId);
    console.log(`Done. Outbox depth: ${outboxDepth(db)}`);
    process.exit(0);
  }
  const hbTimer = setInterval(heartbeat, heartbeatSeconds * 1000);
  const collectTimer = setInterval(cycle, collectSeconds * 1000);

  const shutdown = () => {
    clearInterval(hbTimer);
    clearInterval(collectTimer);
    stopLmStudioStream();
    endSession(db, bootId);
    console.log("burn collector stopped");
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
