import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { stateDir, configDir } from "../shared/paths";

// Service installation for the primary targets (issue #7): systemd user units
// on Linux, launchd agents on macOS. Windows is best-effort later.

const UNITS = ["burn-server", "burn-collector"] as const;

export async function cmdServerInstall(): Promise<void> {
  const exe = process.execPath; // compiled binary path, or bun when run from source
  const isCompiled = !exe.endsWith("/bun");
  const execStart = isCompiled ? `${exe}` : `${exe} run ${join(process.cwd(), "src/index.ts")}`;

  if (process.platform === "linux") {
    const dir = join(homedir(), ".config", "systemd", "user");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "burn-server.service"),
      `[Unit]
Description=Burn usage observability server
After=network.target

[Service]
ExecStart=${execStart} server run
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`
    );
    writeFileSync(
      join(dir, "burn-collector.service"),
      `[Unit]
Description=Burn usage observability collector
After=network.target

[Service]
ExecStart=${execStart} collector run
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`
    );
    console.log("Installed systemd user units: burn-server.service, burn-collector.service");
    console.log("Enable with:");
    console.log("  systemctl --user daemon-reload");
    console.log("  systemctl --user enable --now burn-server   # on the server node");
    console.log("  systemctl --user enable --now burn-collector    # after `burn enroll`");
    console.log("Then expose via Tailscale:  tailscale serve --bg 7337");
    return;
  }

  if (process.platform === "darwin") {
    const dir = join(homedir(), "Library", "LaunchAgents");
    mkdirSync(dir, { recursive: true });
    for (const [name, args] of [
      ["dev.burn.server", "server run"],
      ["dev.burn.collector", "collector run"],
    ] as const) {
      const argv = [...execStart.split(" "), ...args.split(" ")];
      writeFileSync(
        join(dir, `${name}.plist`),
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${name}</string>
  <key>ProgramArguments</key><array>${argv.map((a) => `<string>${a}</string>`).join("")}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
`
      );
    }
    console.log("Installed launchd agents: dev.burn.server, dev.burn.collector");
    console.log("Load with:  launchctl load ~/Library/LaunchAgents/dev.burn.server.plist");
    return;
  }

  console.log(`Service install is not yet supported on ${process.platform}; run \`burn server run\` directly.`);
}

export async function cmdUninstall(purge: boolean): Promise<void> {
  if (process.platform === "linux") {
    for (const unit of UNITS) {
      Bun.spawnSync(["systemctl", "--user", "disable", "--now", `${unit}.service`]);
      const path = join(homedir(), ".config", "systemd", "user", `${unit}.service`);
      if (existsSync(path)) rmSync(path);
    }
    console.log("Removed systemd user units.");
  } else if (process.platform === "darwin") {
    for (const name of ["dev.burn.server", "dev.burn.collector"]) {
      const path = join(homedir(), "Library", "LaunchAgents", `${name}.plist`);
      Bun.spawnSync(["launchctl", "unload", path]);
      if (existsSync(path)) rmSync(path);
    }
    console.log("Removed launchd agents.");
  }
  if (purge) {
    rmSync(stateDir(), { recursive: true, force: true });
    rmSync(configDir(), { recursive: true, force: true });
    console.log("Purged config, credentials, and all local data.");
  } else {
    console.log(`Data kept in ${stateDir()} and ${configDir()} (use --purge to remove).`);
  }
}
