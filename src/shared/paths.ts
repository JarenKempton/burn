// Standard config/state/log locations (issue #4 deliverable).
// Linux follows XDG; macOS uses ~/Library. Overridable via BURN_* env vars.

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync, renameSync } from "node:fs";

const home = homedir();
const isMac = process.platform === "darwin";

function xdg(envVar: string, fallback: string): string {
  const v = process.env[envVar];
  return v && v.length > 0 ? v : fallback;
}

export function configDir(): string {
  if (process.env.BURN_CONFIG_DIR) return process.env.BURN_CONFIG_DIR;
  return isMac
    ? join(home, "Library", "Application Support", "burn")
    : join(xdg("XDG_CONFIG_HOME", join(home, ".config")), "burn");
}

export function stateDir(): string {
  if (process.env.BURN_STATE_DIR) return process.env.BURN_STATE_DIR;
  return isMac
    ? join(home, "Library", "Application Support", "burn", "state")
    : join(xdg("XDG_STATE_HOME", join(home, ".local", "state")), "burn");
}

export function logDir(): string {
  if (process.env.BURN_LOG_DIR) return process.env.BURN_LOG_DIR;
  return isMac ? join(home, "Library", "Logs", "burn") : join(stateDir(), "logs");
}

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export const serverDbPath = () => join(ensureDir(stateDir()), "server.sqlite");

// The collector role was called "agent" pre-rename; adopt an existing
// agent.sqlite so cursors/outbox survive (re-reading old cursors would
// double-count history on the server).
export function collectorDbPath(): string {
  const dir = ensureDir(stateDir());
  const current = join(dir, "collector.sqlite");
  const legacy = join(dir, "agent.sqlite");
  if (!existsSync(current) && existsSync(legacy)) {
    for (const suffix of ["", "-shm", "-wal"]) {
      if (existsSync(legacy + suffix)) renameSync(legacy + suffix, current + suffix);
    }
  }
  return current;
}
export const configPath = () => join(ensureDir(configDir()), "config.json");
// v0 credential storage: 0600 file. OS keychain integration is a follow-up;
// the server only ever stores a hash, so exposure is limited to this node.
export const credentialsPath = () => join(ensureDir(configDir()), "credentials.json");
