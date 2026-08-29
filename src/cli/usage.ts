import { loadConfig, loadCredentials } from "../shared/config";
import { estimateCostMicros } from "../shared/prices";

// `burn usage` — token consumption broken down by provider × model, with
// cost: provider-reported where it exists (OpenRouter), otherwise an
// API-equivalent estimate from shared/prices.ts. Subscription usage is not
// billed per token, so estimates are marked with ~.

export async function cmdUsage(args: string[]): Promise<void> {
  const daysFlag = args.indexOf("--days");
  const days = daysFlag >= 0 ? Number(args[daysFlag + 1]) || 30 : 30;

  const creds = loadCredentials();
  const cfg = loadConfig();
  if (!creds.node || !creds.admin_token) {
    console.error("Needs a server connection and the API token (run on the server machine).");
    process.exit(1);
  }
  const base = cfg.collector?.server_url ?? creds.node.server_url;
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const res = await fetch(`${base}/v1/usage?since=${encodeURIComponent(since)}`, {
    headers: { authorization: `Bearer ${creds.admin_token}` },
  });
  if (!res.ok) throw new Error(`GET /v1/usage: HTTP ${res.status}`);
  const usage = (await res.json()) as any;

  interface Row {
    provider: string;
    model: string | null;
    input: number;
    cached: number;
    output: number;
    requests: number;
    actualCost: number;
  }
  const byModel = new Map<string, Row>();
  for (const r of usage.consumption_by_day) {
    const key = `${r.provider_id}|${r.model ?? ""}`;
    const agg = byModel.get(key) ?? {
      provider: r.provider_id,
      model: r.model ?? null,
      input: 0,
      cached: 0,
      output: 0,
      requests: 0,
      actualCost: 0,
    };
    agg.input += r.input_tokens ?? 0;
    agg.cached += r.cached ?? 0;
    agg.output += r.output_tokens ?? 0;
    agg.requests += r.requests ?? 0;
    agg.actualCost += r.cost_micros ?? 0;
    byModel.set(key, agg);
  }

  if (byModel.size === 0) {
    console.log("No consumption recorded yet.");
    return;
  }

  const rows = [...byModel.values()].map((r) => {
    const estimate = r.actualCost > 0 ? null : estimateCostMicros(r.model, r.input, r.cached, r.output);
    return { ...r, cost: r.actualCost > 0 ? r.actualCost : (estimate ?? 0), estimated: r.actualCost === 0 && estimate != null };
  });
  rows.sort((a, b) => a.provider.localeCompare(b.provider) || b.cost - a.cost || b.input - a.input);

  console.log(`Usage by model (last ${days} days):\n`);
  console.log(
    `  ${"provider".padEnd(13)}${"model".padEnd(28)}${"input".padStart(9)}${"cached".padStart(9)}${"output".padStart(9)}${"req".padStart(8)}  cost`
  );
  let lastProvider = "";
  let totalCost = 0;
  let anyEstimate = false;
  for (const r of rows) {
    const provider = r.provider === lastProvider ? "" : r.provider;
    lastProvider = r.provider;
    let cost = "";
    if (r.actualCost > 0) cost = `$${(r.actualCost / 1_000_000).toFixed(2)}`;
    else if (r.estimated) {
      cost = `~$${(r.cost / 1_000_000).toFixed(2)}`;
      anyEstimate = true;
    }
    totalCost += r.cost;
    console.log(
      `  ${provider.padEnd(13)}${(r.model ?? "(unknown model)").padEnd(28)}${fmt(r.input).padStart(9)}${fmt(r.cached).padStart(9)}${fmt(r.output).padStart(9)}${fmt(r.requests).padStart(8)}  ${cost}`
    );
  }
  console.log(`\n  total: $${(totalCost / 1_000_000).toFixed(2)}`);
  if (anyEstimate) {
    console.log("  ~ = API-equivalent estimate (subscription usage isn't billed per token);");
    console.log("      prices live in src/shared/prices.ts — unknown models show no cost.");
  }
}

const fmt = (n: number) =>
  n >= 1_000_000_000
    ? `${(n / 1_000_000_000).toFixed(1)}B`
    : n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(1)}M`
      : n >= 1000
        ? `${(n / 1000).toFixed(1)}k`
        : String(n);
