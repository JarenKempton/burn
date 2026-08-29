import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadConfig, saveConfig, loadCredentials, saveCredentials } from "../shared/config";
import { openBrowser } from "../shared/util";
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

// Bun's global prompt() reads one line synchronously; unlike iterating the
// `console` async iterator, it works for any number of sequential questions.
async function prompt(question: string): Promise<string> {
  return (globalThis.prompt(question.trimEnd()) ?? "").trim();
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

async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const answer = (await prompt(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `)).toLowerCase();
  if (!answer) return defaultYes;
  return answer.startsWith("y");
}

async function add(name: string | undefined): Promise<void> {
  let providerId = name as ProviderId | undefined;
  if (!providerId) {
    console.log("Which provider do you want to connect?\n");
    for (const [i, a] of ALL_ADAPTERS.entries()) {
      const ctx = buildCtx(a.providerId, { ephemeral: true });
      const detected = await a.detect(ctx).catch(() => false);
      ctx.db.close();
      console.log(`  ${i + 1}. ${a.providerId.padEnd(12)} ${detected ? "(detected on this machine)" : ""}`);
    }
    stopLmStudioStream();
    const pick = await prompt("\nEnter a number: ");
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
      console.log("✓ Usage history: read automatically from your Claude Code sessions.");
      // The mechanism (statusline registration) is an implementation detail;
      // users just decide whether they want quota tracking.
      await offerStatuslineInstall();
      break;
    }
    case "codex":
      console.log("✓ Nothing to configure — usage and rate limits are read automatically");
      console.log("  from your Codex sessions. No credentials are stored.");
      break;
    case "openrouter": {
      // Decision (issue #1 thread): management key only. OpenRouter's OAuth
      // PKCE yields a regular key that cannot read /credits or /activity.
      const keysUrl = "https://openrouter.ai/settings/management-keys";
      console.log("OpenRouter needs a management key so Burn can read your credits and");
      console.log("daily usage. Opening your browser to create one:");
      console.log(`  ${keysUrl}`);
      openBrowser(keysUrl);
      const key = await prompt("\nPaste the key here: ");
      if (!key) {
        console.error("No key provided; aborting.");
        process.exit(1);
      }
      console.log("Checking the key against OpenRouter...");
      const check = await validateOpenRouterKey(key);
      if (!check.valid) {
        console.error(`✗ OpenRouter rejected that key (${check.detail}). Nothing was saved.`);
        process.exit(1);
      }
      const creds = loadCredentials();
      creds.providers ??= {};
      creds.providers.openrouter = { api_key: key };
      saveCredentials(creds);
      console.log(`✓ Key verified (${check.detail}). Stored locally with 0600 permissions;`);
      console.log("  it never leaves this machine.");
      break;
    }
    case "lmstudio": {
      console.log("Heads up: LM Studio support is early. It has no usage history API, so");
      console.log("Burn only captures requests made while the collector is running.");
      const url = await prompt("LM Studio server URL [http://127.0.0.1:1234]: ");
      cfg.providers[providerId]!.settings = { base_url: url || "http://127.0.0.1:1234" };
      break;
    }
  }

  saveConfig(cfg);
  console.log(`\n✅ ${providerId} is set up. Check it with: burn providers test ${providerId}`);
}

async function validateOpenRouterKey(
  key: string
): Promise<{ valid: boolean; detail: string }> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { valid: false, detail: `HTTP ${res.status}` };
    const data = (await res.json()) as { data?: { is_management_key?: boolean; is_provisioning_key?: boolean; label?: string } };
    const management = data.data?.is_management_key ?? data.data?.is_provisioning_key ?? false;
    return {
      valid: true,
      detail: management
        ? "management key — full access: credits, daily usage, limits"
        : "regular key — limits only; a management key would add credits + daily usage",
    };
  } catch (err) {
    return { valid: false, detail: `network error: ${err}` };
  }
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
      console.log(`⚠ Can't enable quota tracking: ${settingsPath} is not valid JSON.`);
      console.log("  Fix that file and re-run this command.");
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
    console.log("✓ Quota tracking: already enabled.");
    return;
  }
  if (current) {
    // Conflict is the one case where the mechanism has to surface.
    console.log("⚠ Quota tracking needs Claude Code's statusline hook, but you already");
    console.log(`  have a statusline configured: ${JSON.stringify(current.command ?? current)}`);
    console.log("  Keeping yours. To get quota too, have your script also pipe its stdin to:");
    console.log(`    ${command}`);
    return;
  }

  if (!(await confirm("Track your 5-hour/weekly rate limits live? (adds a hook to Claude Code)"))) {
    console.log("Skipped — usage history still works. Re-run this command to enable it later.");
    return;
  }
  settings["statusLine"] = { type: "command", command };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  console.log("✓ Quota tracking enabled. Windows appear after your next Claude Code response.");
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
