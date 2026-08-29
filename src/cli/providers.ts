import { loadConfig, saveConfig, loadCredentials, saveCredentials } from "../shared/config";
import { ALL_ADAPTERS, adapterFor } from "../providers/registry";
import type { AdapterContext } from "../providers/types";
import { openAgentDb } from "../agent/db";
import { RATELIMIT_STATE_FILE } from "../providers/claude-code";
import { stopLmStudioStream } from "../providers/lmstudio";
import type { ProviderId } from "../shared/types";

function buildCtx(providerId: ProviderId, opts?: { ephemeral?: boolean }): AdapterContext {
  const cfg = loadConfig();
  const creds = loadCredentials();
  return {
    nodeId: creds.node?.node_id ?? "unenrolled",
    // ephemeral: an in-memory db so `providers test` never advances the real
    // collection cursors (the agent must still see everything later)
    db: openAgentDb(opts?.ephemeral ? ":memory:" : undefined),
    settings: cfg.providers?.[providerId]?.settings ?? {},
    credentials: creds.providers?.[providerId] ?? {},
  };
}

async function prompt(question: string): Promise<string> {
  process.stdout.write(question);
  for await (const line of console) return line.trim();
  return "";
}

export async function cmdProviders(sub: string | undefined, rest: string[]): Promise<void> {
  if (sub === "list") return list();
  if (sub === "add") return add(rest[0]);
  if (sub === "test") return test(rest[0]);
  console.log("Usage: burn providers <list|add|test> [provider]");
  process.exit(1);
}

async function list(): Promise<void> {
  const cfg = loadConfig();
  for (const adapter of ALL_ADAPTERS) {
    const ctx = buildCtx(adapter.providerId);
    const detected = await adapter.detect(ctx).catch(() => false);
    ctx.db.close();
    const enabled = cfg.providers?.[adapter.providerId]?.enabled !== false;
    console.log(
      `${detected ? "●" : "○"} ${adapter.providerId.padEnd(12)} ${detected ? "detected" : "not detected"}${enabled ? "" : " (disabled)"}  [${adapter.adapterId}]`
    );
  }
}

async function add(name: string | undefined): Promise<void> {
  let providerId = name as ProviderId | undefined;
  if (!providerId) {
    console.log("Supported providers:");
    ALL_ADAPTERS.forEach((a, i) => console.log(`  ${i + 1}. ${a.providerId}`));
    const pick = await prompt("Which provider? ");
    providerId = (ALL_ADAPTERS[Number(pick) - 1]?.providerId ?? pick) as ProviderId;
  }
  const adapter = adapterFor(providerId);
  if (!adapter) {
    console.error(`Unknown provider: ${providerId}`);
    process.exit(1);
  }

  const cfg = loadConfig();
  cfg.providers ??= {};
  cfg.providers[providerId] = { ...cfg.providers[providerId], enabled: true };

  switch (providerId) {
    case "claude_code": {
      // Reuses the existing installation read-only; quota needs the statusline tee.
      console.log("Claude Code consumption is read from local session logs automatically.");
      console.log("For 5h/weekly quota windows, set Burn as your Claude Code statusline:");
      console.log(`  in ~/.claude/settings.json:  "statusLine": {"type": "command", "command": "burn claude-statusline"}`);
      console.log(`Rate limits will be captured to ${RATELIMIT_STATE_FILE()} as you use Claude Code.`);
      break;
    }
    case "codex":
      console.log("Codex usage and rate limits are read from local session logs automatically.");
      console.log("No credentials are required or stored.");
      break;
    case "openrouter": {
      console.log("OpenRouter needs an API key. A MANAGEMENT key (openrouter.ai/settings/management-keys)");
      console.log("unlocks credits + daily activity; a regular key only reports per-key limits.");
      const key = await prompt("Paste key (input hidden is not supported; key is stored 0600 locally): ");
      if (!key) {
        console.error("No key provided; aborting.");
        process.exit(1);
      }
      const creds = loadCredentials();
      creds.providers ??= {};
      creds.providers.openrouter = { api_key: key };
      saveCredentials(creds);
      break;
    }
    case "lmstudio": {
      const url = await prompt("LM Studio base URL [http://127.0.0.1:1234]: ");
      cfg.providers[providerId]!.settings = { base_url: url || "http://127.0.0.1:1234" };
      console.log("Note: LM Studio has no history API — usage is only captured while the agent runs.");
      break;
    }
  }

  saveConfig(cfg);
  console.log(`✅ ${providerId} configured. Verify with: burn providers test ${providerId}`);
}

async function test(name: string | undefined): Promise<void> {
  if (!name) {
    console.error("Usage: burn providers test <provider>");
    process.exit(1);
  }
  const adapter = adapterFor(name);
  if (!adapter) {
    console.error(`Unknown provider: ${name}`);
    process.exit(1);
  }
  const ctx = buildCtx(adapter.providerId, { ephemeral: true });
  try {
    const detected = await adapter.detect(ctx);
    console.log(`detect: ${detected ? "ok" : "NOT DETECTED"}`);
    if (!detected) return;
    const observations = await adapter.collect(ctx);
    console.log(`collect: ${observations.length} observation(s)`);
    for (const obs of observations.slice(0, 10)) {
      console.log(`  [${obs.payload.type}] ${JSON.stringify(obs.payload).slice(0, 160)}`);
    }
    if (observations.length > 10) console.log(`  ... and ${observations.length - 10} more`);
    console.log("(test mode: nothing was queued or sent)");
  } finally {
    ctx.db.close();
    stopLmStudioStream();
  }
}
