import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { stateDir, configDir } from "../shared/paths";

// Service installation for the primary targets (issue #7): systemd user units
// on Linux, launchd agents on macOS. Windows is best-effort later.
//
// Since `server run` also collects on its own machine (combined mode), the
// server machine needs exactly one service; collector-only machines install
// theirs with `burn collector install`.

const ALL_UNITS = ["burn-server", "burn-collector"] as const;
const ALL_PLISTS = ["dev.burn.server", "dev.burn.collector"] as const;

function execStart(): string {
  const exe = process.execPath;
  const isCompiled = !exe.endsWith("/bun");
  return isCompiled ? exe : `${exe} run ${join(process.cwd(), "src/index.ts")}`;
}

export async function cmdServiceInstall(role: "server" | "collector"): Promise<void> {
  const unit = role === "server" ? "burn-server" : "burn-collector";
  const plist = role === "server" ? "dev.burn.server" : "dev.burn.collector";
  const args = `${role} run`;
  const description =
    role === "server"
      ? "Burn usage observability server (collects on this machine too)"
      : "Burn usage observability collector";

  if (role === "collector" && !existsSync(join(configDir(), "credentials.json"))) {
    console.log("Tip: run `burn collector run` once first to enroll this machine —");
    console.log("the service can't answer the enrollment prompts.\n");
  }

  if (process.platform === "linux") {
    const dir = join(homedir(), ".config", "systemd", "user");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${unit}.service`),
      `[Unit]
Description=${description}
After=network.target

[Service]
ExecStart=${execStart()} ${args}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`
    );
    const reload = Bun.spawnSync(["systemctl", "--user", "daemon-reload"]);
    const enable = Bun.spawnSync(["systemctl", "--user", "enable", "--now", `${unit}.service`]);
    if (reload.exitCode === 0 && enable.exitCode === 0) {
      console.log(`✓ ${unit} installed and running (systemd user service).`);
      console.log(`  logs:   journalctl --user -u ${unit} -f`);
      console.log(`  stop:   systemctl --user disable --now ${unit}`);
    } else {
      console.log(`Wrote ${join(dir, `${unit}.service`)}, but couldn't enable it automatically.`);
      console.log(`Run:  systemctl --user daemon-reload && systemctl --user enable --now ${unit}`);
    }
    if (role === "server") console.log(`  expose: tailscale serve --bg 7337`);
    return;
  }

  if (process.platform === "darwin") {
    const dir = join(homedir(), "Library", "LaunchAgents");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${plist}.plist`);
    const argv = [...execStart().split(" "), role, "run"];
    writeFileSync(
      path,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${plist}</string>
  <key>ProgramArguments</key><array>${argv.map((a) => `<string>${a}</string>`).join("")}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
`
    );
    const load = Bun.spawnSync(["launchctl", "load", path]);
    if (load.exitCode === 0) {
      console.log(`✓ ${plist} installed and running (launchd agent).`);
      console.log(`  stop: launchctl unload ${path}`);
    } else {
      console.log(`Wrote ${path}; load it with:  launchctl load ${path}`);
    }
    return;
  }

  console.log(`Service install is not yet supported on ${process.platform}; run \`burn ${role} run\` directly.`);
}

export async function cmdUninstall(purge: boolean): Promise<void> {
  if (process.platform === "linux") {
    for (const unit of ALL_UNITS) {
      Bun.spawnSync(["systemctl", "--user", "disable", "--now", `${unit}.service`]);
      const path = join(homedir(), ".config", "systemd", "user", `${unit}.service`);
      if (existsSync(path)) rmSync(path);
    }
    console.log("Removed systemd user units.");
  } else if (process.platform === "darwin") {
    for (const name of ALL_PLISTS) {
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