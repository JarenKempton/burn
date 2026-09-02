#!/usr/bin/env bun
// burn — local-first AI usage and limits observability.
// CLI contract per issue #7.

import { startServer } from "./server/server";
import { enroll, enrollDefault } from "./collector/enroll";
import { runCollector } from "./collector/run";
import { claudeStatuslineTee } from "./providers/claude-code";
import { cmdStatus } from "./cli/status";
import { cmdProviders } from "./cli/providers";
import { cmdConfig } from "./cli/config";
import { cmdServiceInstall, cmdUninstall } from "./cli/install";
import { DEFAULT_PORT, loadConfig } from "./shared/config";
import { VERSION } from "./shared/version";
import { backupServer, restoreServer, reidentifyCollector, retargetCollector } from "./cli/migrate";



const HELP = `burn ${VERSION} — local-first AI usage and limits observability

Usage:
  burn server run              Run the server; also collects on this machine
                               (opt out with --server-only)
  burn server install          Install + start the server as a user service
  burn server backup <dir>     Create a consistent migration backup
  burn server restore <dir>    Restore a migration backup (use --replace if needed)
  burn collector run [--once]  Collect + report; offers enrollment if needed
  burn collector install       Install + start the collector as a user service
  burn collector reidentify    Repair a machine cloned from another collector
  burn collector retarget URL  Keep this node identity but use a moved server
  burn enroll [server-url]     Enroll this machine with a Burn server (browser approval)
  burn status                  Show machines, quota, and usage
  burn usage [--days N]        Token usage and cost by provider × model
  burn providers list          List providers and detection status
  burn providers add [name]    Connect a provider (interactive without name)
  burn providers test [name]   Run one collection for a provider and show results
  burn config                  Show config, paths, and the API token
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
        console.log(`  api token:   run \`burn config\` to display`);
        console.log(`  tailscale:   tailscale serve --bg ${handle.port}   (recommended transport)`);

        {
          const { hasUsers } = await import("./server/auth");
          if (!hasUsers(handle.db)) {
            if (process.stdin.isTTY) {
              const { createAdminInteractive } = await import("./cli/admin");
              await createAdminInteractive(handle.db);
            } else {
              console.log("  ⚠ no admin account yet — run `burn server install` in a terminal to create it");
            }
          }
        }

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
      if (sub === "backup" && rest[0]) return backupServer(rest[0]);
      if (sub === "restore" && rest[0]) return restoreServer(rest[0], rest.includes("--replace"));
      break;
    }
    case "enroll": {
      const url = sub ?? loadConfig().collector?.server_url;
      // With no URL: verify the stored credential and offer repair (mDNS
      // discovery is a follow-up; explicit URL is the supported path today).
      if (!url) return enrollDefault();
      return enroll(url);
    }
    case "collector": {
      if (sub === "run") return runCollector({ once: rest.includes("--once") });
      if (sub === "install") return cmdServiceInstall("collector");
      if (sub === "reidentify") return reidentifyCollector();
      if (sub === "retarget" && rest[0]) return retargetCollector(rest[0]);
      if (sub === "enroll") return rest[0] ? enroll(rest[0]) : enrollDefault(); // common guess; alias for burn enroll
      break;
    }
    case "status":
      return cmdStatus();
    case "usage": {
      const { cmdUsage } = await import("./cli/usage");
      return cmdUsage([sub ?? "", ...rest]);
    }
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
