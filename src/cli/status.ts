import { loadConfig, loadCredentials } from "../shared/config";
import { openCollectorDb, outboxDepth } from "../collector/db";

// `burn status` — node, quota, and usage at a glance. Talks to the server
// with the admin token when available locally, else shows local collector state.

export async function cmdStatus(): Promise<void> {
  const creds = loadCredentials();
  const cfg = loadConfig();

  if (!creds.node) {
    console.log("Not enrolled. Run: burn enroll <server-url>");
    return;
  }
  console.log(`Node:    ${creds.node.node_id}`);
  console.log(`Server:  ${creds.node.server_url}`);
  const db = openCollectorDb();
  console.log(`Outbox:  ${outboxDepth(db)} observation(s) pending delivery`);
  db.close();

  const adminToken = creds.admin_token;
  if (!adminToken) {
    console.log("(no local admin token — server-side summaries unavailable from this node)");
    return;
  }

  const base = cfg.collector?.server_url ?? creds.node.server_url;
  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${adminToken}` } });
    if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
    return res.json() as Promise<any>;
  };

  try {
    const [nodes, usage, health] = await Promise.all([
      get("/v1/nodes"),
      get("/v1/usage"),
      get("/v1/adapters/health"),
    ]);

    console.log("\nNodes:");
    for (const n of nodes.nodes) {
      console.log(`  ${icon(n.liveness)} ${n.name} (${n.platform}) — ${n.liveness}, last heartbeat ${n.last_heartbeat_received_at ?? "never"}`);
    }

    if (usage.latest_quota_snapshots.length > 0) {
      console.log("\nQuota windows:");
      for (const q of usage.latest_quota_snapshots) {
        const pct = q.used_percent != null ? `${Math.round(q.used_percent)}% used` : "usage unknown";
        const resets = q.resets_at ? `, resets ${q.resets_at}` : "";
        console.log(`  ${q.provider_id} [${q.window?.label ?? q.window?.kind}] ${pct}${resets}`);
      }
    }

    if (usage.latest_credit_balances.length > 0) {
      console.log("\nCredits:");
      for (const c of usage.latest_credit_balances) {
        const rem = c.remaining_micros != null ? `$${(c.remaining_micros / 1_000_000).toFixed(2)} remaining` : "balance unknown";
        console.log(`  ${c.provider_id}: ${rem}`);
      }
    }

    const byProvider = new Map<string, { input: number; output: number; requests: number }>();
    for (const row of usage.consumption_by_day) {
      const agg = byProvider.get(row.provider_id) ?? { input: 0, output: 0, requests: 0 };
      agg.input += row.input_tokens ?? 0;
      agg.output += row.output_tokens ?? 0;
      agg.requests += row.requests ?? 0;
      byProvider.set(row.provider_id, agg);
    }
    if (byProvider.size > 0) {
      console.log(`\nConsumption since ${usage.since.slice(0, 10)}:`);
      for (const [provider, agg] of byProvider) {
        console.log(
          `  ${provider}: ${fmt(agg.input)} in / ${fmt(agg.output)} out tokens` +
            (agg.requests ? ` across ${fmt(agg.requests)} requests` : "")
        );
      }
    }

    if (health.adapters.length > 0) {
      console.log("\nAdapters:");
      for (const a of health.adapters) {
        console.log(`  ${a.provider_id}@${a.node_id.slice(0, 8)}: ${a.status}${a.message ? ` — ${a.message}` : ""}`);
      }
    }
  } catch (err) {
    console.log(`\nServer summaries unavailable: ${err instanceof Error ? err.message : err}`);
  }
}

const icon = (liveness: string) => (liveness === "online" ? "●" : liveness === "stale" ? "◐" : "○");
const fmt = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
