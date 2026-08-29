import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadConfig, saveConfig, loadCredentials, saveCredentials } from "../shared/config";
import { ALL_ADAPTERS, adapterFor, isEnabled } from "../providers/registry";
import type { AdapterContext } from "../providers/types";
import { openCollectorDb } from "../collector/db";
import { RATELIMIT_STATE_FILE } from "../providers/claude-code";
import { stopLmStudioStream } from "../providers/lmstudio";
import type { ProviderId } from "../shared/types";

function buildCtx(providerId: ProviderId, opts?: { ephemeral?: boolean }): AdapterContext {
  const cfg = loadConfig();
  const creds = loadCredentials();
  return {
    nodeId: creds.node?.node_id ?? "unenrolled",
    // ephemeral: an in-memory db so `providers test` never advances the real
    // collection cursors (the collector must still see everything later)
    db: openCollectorDb(opts?.ephemeral ? ":memory:" : undefined),
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
    const enabled = isEnabled(cfg, adapter.providerId);
    const note = enabled ? "" : " (off — enable with: burn providers add " + adapter.providerId + ")";
    console.log(
      `${detected ? "●" : "○"} ${adapter.providerId.padEnd(12)} ${detected ? "detected" : "not detected"}${note}  [${adapter.adapterId}]`
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
      console.log("5h/weekly quota windows use Claude Code's official statusline JSON;");
      console.log("Burn can register itself as your statusline command to capture them.");
      await offerStatuslineInstall();
      break;
    }
    case "codex":
      console.log("Codex usage and rate limits are read from local session logs automatically.");
      console.log("No credentials are required or stored.");
      break;
    case "openrouter": {
      // Decision (issue #1 thread): management key only. OpenRouter's OAuth
      // PKCE yields a regular key that cannot read /credits or /activity.
      console.log("OpenRouter needs a MANAGEMENT key — create one at:");
      console.log("  https://openrouter.ai/settings/management-keys");
      console.log("(OAuth login can't work here: it issues a regular key, and OpenRouter");
      console.log(" locks the credits and activity endpoints to management keys.)");
      const key = await prompt("Paste management key (stored locally, mode 0600, never sent to the Burn server): ");
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
      console.log("Note: LM Studio support is early and off by default — it has no history");
      console.log("API, so usage is only captured while the collector is running.");
      const url = await prompt("LM Studio base URL [http://127.0.0.1:1234]: ");
      cfg.providers[providerId]!.settings = { base_url: url || "http://127.0.0.1:1234" };
      break;
    }
  }

  saveConfig(cfg);
  console.log(`✅ ${providerId} configured. Verify with: burn providers test ${providerId}`);
}

/**
 * Offer to register Burn as the Claude Code statusline command in
 * ~/.claude/settings.json. The statusline is the officially documented
 * delivery surface for rate-limit data; this keeps onboarding to the same
 * "run one command, answer prompts" shape as every other provider.
 */
async function offerStatuslineInstall(): Promise<void> {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  let settings: Record<string, any> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch {
      console.log(`⚠️  ${settingsPath} is not valid JSON — not touching it. Configure the statusline manually.`);
      return;
    }
  }

  // Invoke burn the same way it is running right now, so the written command
  // works for both the compiled binary and source checkouts.
  const command = process.execPath.endsWith("/bun")
    ? `${process.execPath} run ${join(process.cwd(), "src/index.ts")} claude-statusline`
    : `${process.execPath} claude-statusline`;

  const current = settings["statusLine"];
  if (current?.command?.includes("claude-statusline")) {
    console.log("✓ Burn is already your Claude Code statusline.");
    return;
  }
  if (current) {
    console.log(`You already have a statusline configured: ${JSON.stringify(current)}`);
    console.log("Not replacing it. To capture quota, chain Burn into your existing script:");
    console.log(`  your script should also pipe its stdin JSON to: ${command}`);
    return;
  }

  const answer = await prompt(`Write statusline into ${settingsPath}? [Y/n] `);
  if (answer.toLowerCase() === "n") {
    console.log("Skipped. Add it later with:");
    console.log(`  "statusLine": {"type": "command", "command": ${JSON.stringify(command)}}`);
    return;
  }
  settings["statusLine"] = { type: "command", command };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  console.log(`✓ Statusline installed. Quota windows will be captured to`);
  console.log(`  ${RATELIMIT_STATE_FILE()} as you use Claude Code.`);
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
