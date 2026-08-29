#!/usr/bin/env bun
// burn — local-first AI usage and limits observability.
// CLI contract per issue #7.

import { startServer } from "./server/server";
import { enroll } from "./agent/enroll";
import { runAgent } from "./agent/run";
import { claudeStatuslineTee } from "./providers/claude-code";
import { cmdStatus } from "./cli/status";
import { cmdProviders } from "./cli/providers";
import { cmdConfig } from "./cli/config";
import { cmdServerInstall, cmdUninstall } from "./cli/install";
import { DEFAULT_PORT, loadConfig } from "./shared/config";

const VERSION = "0.1.0";

const HELP = `burn ${VERSION} — local-first AI usage and limits observability

Usage:
  burn server install          Install the server as a user service (systemd/launchd)
  burn server run              Run the server in the foreground
  burn enroll [server-url]     Enroll this node with a Burn server (browser approval)
  burn agent run [--once]      Run the collection agent
  burn status                  Show node, quota, and usage status
  burn providers list          List providers and detection status
  burn providers add [name]    Configure a provider (interactive without name)
  burn providers test [name]   Run one collection for a provider and show results
  burn config                  Show config, paths, and the admin token
  burn uninstall               Remove services; keeps data unless --purge

Environment:
  BURN_CONFIG_DIR, BURN_STATE_DIR, BURN_LOG_DIR override standard locations.
`;

async function main(): Promise<void> {
  const [cmd, sub, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case "server": {
      if (sub === "run") {
        const cfg = loadConfig();
        const handle = startServer();
        console.log(`burn server listening on http://${cfg.server?.host ?? "127.0.0.1"}:${handle.port}`);
        console.log(`  server id:   ${handle.serverId}`);
        console.log(`  admin token: run \`burn config\` to display`);
        console.log(`  tailscale:   tailscale serve --bg ${handle.port}   (recommended transport)`);
        await new Promise(() => {});
        return;
      }
      if (sub === "install") return cmdServerInstall();
      break;
    }
    case "enroll": {
      const url = sub ?? loadConfig().agent?.server_url;
      if (!url) {
        // mDNS discovery is a follow-up; explicit URL is the supported path today.
        console.error("Usage: burn enroll <server-url>   (e.g. burn enroll http://server:7337)");
        process.exit(1);
      }
      return enroll(url);
    }
    case "agent": {
      if (sub === "run") return runAgent({ once: rest.includes("--once") });
      break;
    }
    case "status":
      return cmdStatus();
    case "providers":
      return cmdProviders(sub, rest);
    case "config":
      return cmdConfig();
    case "uninstall":
      return cmdUninstall(rest.includes("--purge"));
    case "claude-statusline":
      // Internal: Claude Code statusline command that tees rate limits.
      return claudeStatuslineTee();
    case "--version":
    case "-v":
      console.log(VERSION);
      return;
  }
  console.log(HELP);
  if (cmd && cmd !== "help" && cmd !== "--help" && cmd !== "-h") process.exit(1);
}

main().catch((err) => {
  console.error(`error: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
