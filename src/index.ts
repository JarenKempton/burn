#!/usr/bin/env bun
// burn — local-first AI usage and limits observability.
// CLI contract per issue #7.

import { startServer } from "./server/server";
import { enroll } from "./collector/enroll";
import { runCollector } from "./collector/run";
import { claudeStatuslineTee } from "./providers/claude-code";
import { cmdStatus } from "./cli/status";
import { cmdProviders } from "./cli/providers";
import { cmdConfig } from "./cli/config";
import { cmdServiceInstall, cmdUninstall } from "./cli/install";
import { DEFAULT_PORT, loadConfig } from "./shared/config";

const VERSION = "0.1.0";

const HELP = `burn ${VERSION} — local-first AI usage and limits observability

Usage:
  burn server run              Run the server; also collects on this machine
                               (opt out with --server-only)
  burn server install          Install + start the server as a user service
  burn collector run [--once]  Collect + report; offers enrollment if needed
  burn collector install       Install + start the collector as a user service
  burn enroll [server-url]     Enroll this machine with a Burn server (browser approval)
  burn status                  Show machines, quota, and usage
  burn providers list          List providers and detection status
  burn providers add [name]    Connect a provider (interactive without name)
  burn providers test [name]   Run one collection for a provider and show results
  burn config                  Show config, paths, and the admin token
  burn update                  Self-update the compiled binary from GitHub releases
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

        // Combined role (issue #7): the server machine collects too, without
        // enrolling to itself through the browser. Opt out with --server-only.
        if (!rest.includes("--server-only")) {
          const { loadCredentials, saveCredentials } = await import("./shared/config");
          const creds = loadCredentials();
          if (!creds.node) {
            const { enrollLocalNode } = await import("./server/server");
            const { hostname } = await import("node:os");
            const issued = enrollLocalNode(handle.db, hostname(), `${process.platform}/${process.arch}`);
            creds.node = {
              node_id: issued.node_id,
              node_token: issued.node_token,
              server_url: `http://127.0.0.1:${handle.port}`,
            };
            saveCredentials(creds);
            console.log(`  local node:  enrolled this machine automatically (${issued.node_id})`);
          }
          console.log("  collecting on this machine too (disable with --server-only)");
          runCollector({ banner: false }); // shares this process; never resolves
        }
        await new Promise(() => {});
        return;
      }
      if (sub === "install") return cmdServiceInstall("server");
      break;
    }
    case "enroll": {
      const url = sub ?? loadConfig().collector?.server_url;
      if (!url) {
        const { loadCredentials } = await import("./shared/config");
        const node = loadCredentials().node;
        if (node) {
          console.log(`Already enrolled to ${node.server_url} (node ${node.node_id}).`);
          console.log("To enroll with a different server: burn enroll <server-url>");
          return;
        }
        // mDNS discovery is a follow-up; explicit URL is the supported path today.
        console.error("Usage: burn enroll <server-url>   (e.g. burn enroll http://server:7337)");
        process.exit(1);
      }
      return enroll(url);
    }
    case "collector": {
      if (sub === "run") return runCollector({ once: rest.includes("--once") });
      if (sub === "install") return cmdServiceInstall("collector");
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
    case "update": {
      const { cmdUpdate } = await import("./cli/update");
      return cmdUpdate(VERSION);
    }
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
