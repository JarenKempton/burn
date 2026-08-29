import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { configPath, credentialsPath } from "./paths";
import type { ProviderId } from "./types";

export interface ProviderConfig {
  enabled: boolean;
  /** provider-specific settings, e.g. { base_url } for lmstudio */
  settings?: Record<string, unknown>;
}

export interface BurnConfig {
  server?: {
    /** bind host; default 127.0.0.1 (Tailscale Serve proxies to localhost) */
    host?: string;
    port?: number;
    name?: string;
    /** allow direct LAN binding (explicit opt-in per issue #7) */
    lan?: boolean;
    heartbeat_interval_seconds?: number;
  };
  collector?: {
    server_url?: string;
    collect_interval_seconds?: number;
    heartbeat_interval_seconds?: number;
  };
  providers?: Partial<Record<ProviderId, ProviderConfig>>;
}

export function loadConfig(): BurnConfig {
  const p = configPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as BurnConfig;
  } catch (err) {
    throw new Error(`Invalid config at ${p}: ${err}`);
  }
}

export function saveConfig(cfg: BurnConfig): void {
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

export interface Credentials {
  /** admin token for the local server's application auth */
  admin_token?: string;
  /** node credential issued by enrollment */
  node?: { node_id: string; node_token: string; server_url: string };
  /** provider API credentials keyed by provider id; never leave this node */
  providers?: Partial<Record<ProviderId, Record<string, string>>>;
}

export function loadCredentials(): Credentials {
  const p = credentialsPath();
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, "utf8")) as Credentials;
}

export function saveCredentials(creds: Credentials): void {
  writeFileSync(credentialsPath(), JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
}

export const DEFAULT_PORT = 7337;
export const DEFAULT_HEARTBEAT_SECONDS = 60;
export const DEFAULT_COLLECT_SECONDS = 300;
