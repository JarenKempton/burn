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

    const nodeName = new Map<string, string>(nodes.nodes.map((n: any) => [n.node_id, n.name]));

    console.log("\nMachines:");
    for (const n of nodes.nodes) {
      const self = n.node_id === creds.node.node_id ? ", this machine" : "";
      const hint = n.liveness === "offline" ? " — is `burn collector run` (or the server) running there?" : "";
      console.log(
        `  ${icon(n.liveness)} ${n.name} (${n.platform}${self}) — ${n.liveness}, last heartbeat ${ago(n.last_heartbeat_received_at)}${hint}`
      );
    }

    // Quota windows are account-level (a subscription is shared by every
    // machine on that account); the server returns one snapshot per
    // provider+account+window. Rows with nothing measurable are hidden.
    const quotaRows = usage.latest_quota_snapshots.filter(
      (q: any) => q.used_percent != null || (q.used != null && q.used !== 0) || q.remaining != null
    );
    if (quotaRows.length > 0) {
      console.log("\nQuota windows:");
      for (const q of quotaRows) {
        const where = nodeName.get(q.node_id) ?? q.node_id.slice(0, 8);
        const label = `${q.provider_id} ${q.window?.label ?? q.window?.kind}`.padEnd(22);
        const via = q.account_ref
          ? `${q.account_ref} · via ${where} ${ago(q.observed_at)}`
          : `on ${where} · ${ago(q.observed_at)}`;
        if (q.used_percent != null) {
          const pct = `${Math.round(q.used_percent)}%`.padStart(4);
          const resets = q.resets_at ? `resets ${until(q.resets_at)}` : "";
          console.log(`  ${label} ${bar(q.used_percent)} ${pct}  ${resets.padEnd(19)} ${via}`);
        } else {
          const rem = q.remaining != null ? `${q.remaining} ${q.unit ?? ""} remaining` : `${q.used} ${q.unit ?? ""} used`;
          console.log(`  ${label} ${rem}  (${via})`);
        }
      }
    }

    if (usage.latest_credit_balances.length > 0) {
      console.log("\nCredits:");
      for (const c of usage.latest_credit_balances) {
        const rem = c.remaining_micros != null ? `$${(c.remaining_micros / 1_000_000).toFixed(2)} remaining` : "balance unknown";
        console.log(`  ${c.provider_id}: ${rem}`);
      }
    }

    // Consumption is per-machine work: break it down by provider × machine.
    const byProviderNode = new Map<string, { provider: string; node: string; input: number; output: number; requests: number; cost: number }>();
    for (const row of usage.consumption_by_day) {
      const key = `${row.provider_id}|${row.node_id}`;
      const agg =
        byProviderNode.get(key) ??
        { provider: row.provider_id, node: nodeName.get(row.node_id) ?? row.node_id.slice(0, 8), input: 0, output: 0, requests: 0, cost: 0 };
      agg.input += row.input_tokens ?? 0;
      agg.output += row.output_tokens ?? 0;
      agg.requests += row.requests ?? 0;
      agg.cost += row.cost_micros ?? 0;
      byProviderNode.set(key, agg);
    }
    if (byProviderNode.size > 0) {
      const days = Math.round((Date.now() - Date.parse(usage.since)) / 86400_000);
      console.log(`\nConsumption (last ${days} days):`);
      const byProvider = new Map<string, { rows: { node: string; input: number; output: number; requests: number; cost: number }[]; input: number; output: number; requests: number; cost: number }>();
      for (const r of byProviderNode.values()) {
        const p = byProvider.get(r.provider) ?? { rows: [], input: 0, output: 0, requests: 0, cost: 0 };
        p.rows.push(r);
        p.input += r.input;
        p.output += r.output;
        p.requests += r.requests;
        p.cost += r.cost;
        byProvider.set(r.provider, p);
      }
      const line = (label: string, v: { input: number; output: number; requests: number; cost: number }, indent = "") => {
        const cost = v.cost > 0 ? ` · $${(v.cost / 1_000_000).toFixed(2)}` : "";
        console.log(
          `  ${indent}${label.padEnd(16 - indent.length)}${fmt(v.input).padStart(8)} in · ${fmt(v.output).padStart(7)} out · ${fmt(v.requests).padStart(6)} req${cost}`
        );
      };
      for (const [provider, p] of [...byProvider].sort((a, b) => b[1].input - a[1].input)) {
        line(provider, p);
        if (p.rows.length > 1)
          for (const r of p.rows.sort((a, b) => b.input - a.input)) line(r.node, r, "  ");
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

/** usage bar, colored by pressure when the terminal supports it */
function bar(pct: number, width = 20): string {
  const clamped = Math.min(100, Math.max(0, pct));
  const filled = Math.round((clamped / 100) * width);
  const s = "█".repeat(filled) + "░".repeat(width - filled);
  if (!process.stdout.isTTY) return s;
  const color = clamped >= 90 ? "\x1b[31m" : clamped >= 70 ? "\x1b[33m" : "\x1b[32m";
  return `${color}${s}\x1b[0m`;
}

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago", "July 23, 2026" */
function ago(iso: string | null): string {
  if (!iso) return "never";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 45) return "just now";
  if (s < 60 * 90) return plural(Math.round(s / 60), "minute") + " ago";
  if (s < 3600 * 36) return plural(Math.round(s / 3600), "hour") + " ago";
  if (s < 86400 * 8) return plural(Math.round(s / 86400), "day") + " ago";
  return longDate(iso);
}

/** "in 12 minutes", "in 3 hours", "in 5 days", "on September 3" */
function until(iso: string | null): string {
  if (!iso) return "at an unknown time";
  const s = (Date.parse(iso) - Date.now()) / 1000;
  if (s <= 0) return "now";
  if (s < 60 * 90) return "in " + plural(Math.max(1, Math.round(s / 60)), "minute");
  if (s < 3600 * 36) return "in " + plural(Math.round(s / 3600), "hour");
  if (s < 86400 * 8) return "in " + plural(Math.round(s / 86400), "day");
  return "on " + longDate(iso);
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
const longDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
const fmt = (n: number) =>
  n >= 1_000_000_000
    ? `${(n / 1_000_000_000).toFixed(1)}B`
    : n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(1)}M`
      : n >= 1000
        ? `${(n / 1000).toFixed(1)}k`
        : String(n);
