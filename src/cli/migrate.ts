import { Database } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BurnClient } from "../collector/client";
import { openCollectorDb } from "../collector/db";
import { loadConfig, loadCredentials, saveConfig, saveCredentials } from "../shared/config";
import { serverDbPath } from "../shared/paths";
import { VERSION } from "../shared/version";

interface BackupManifest {
  format: 1;
  product: "burn";
  created_at: string;
  burn_version: string;
  server_id: string;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function readManifest(dir: string): BackupManifest {
  const path = join(dir, "manifest.json");
  if (!existsSync(path)) throw new Error(`Not a Burn server backup: missing ${path}`);
  const manifest = JSON.parse(readFileSync(path, "utf8")) as BackupManifest;
  if (manifest.product !== "burn" || manifest.format !== 1 || !manifest.server_id) {
    throw new Error(`Unsupported or invalid Burn backup manifest at ${path}`);
  }
  return manifest;
}

/** Create a consistent, single-file SQLite snapshot while the server is live. */
export function backupServer(destination: string): void {
  const dir = resolve(destination);
  if (existsSync(dir) && (!statSync(dir).isDirectory() || readdirSync(dir).length > 0)) {
    throw new Error(`Backup destination already exists or is not empty: ${dir}`);
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const outputDb = join(dir, "server.sqlite");
  if (existsSync(outputDb)) throw new Error(`Refusing to overwrite ${outputDb}`);

  const source = new Database(serverDbPath(), { readonly: true });
  const integrity = source.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get();
  if (integrity?.integrity_check !== "ok") {
    source.close();
    throw new Error(`Source server database failed integrity check: ${integrity?.integrity_check ?? "unknown"}`);
  }
  const serverId = source.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'server_id'").get()?.value;
  if (!serverId) {
    source.close();
    throw new Error("No initialized Burn server database found on this machine");
  }
  source.exec(`VACUUM INTO ${sqlString(outputDb)}`);
  source.close();

  const manifest: BackupManifest = {
    format: 1,
    product: "burn",
    created_at: new Date().toISOString(),
    burn_version: VERSION,
    server_id: serverId,
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });

  // The database contains browser users, but the API token lives in the local
  // credential file. Export only that server credential; never node/provider secrets.
  const adminToken = loadCredentials().admin_token;
  if (adminToken) {
    writeFileSync(join(dir, "server-credentials.json"), JSON.stringify({ admin_token: adminToken }, null, 2) + "\n", {
      mode: 0o600,
    });
  }
  console.log(`✓ Consistent server backup created at ${dir}`);
  console.log(`  server id: ${serverId}`);
  console.log("  Copy this directory to the destination machine, then run `burn server restore <directory>`.");
}

export function restoreServer(sourceDirectory: string, replace: boolean): void {
  const dir = resolve(sourceDirectory);
  const manifest = readManifest(dir);
  const sourceDb = join(dir, "server.sqlite");
  if (!existsSync(sourceDb)) throw new Error(`Backup is missing ${sourceDb}`);

  const check = new Database(sourceDb, { readonly: true });
  const integrity = check.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get();
  const dbServerId = check.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'server_id'").get()?.value;
  check.close();
  if (integrity?.integrity_check !== "ok") throw new Error(`Backup database failed integrity check: ${integrity?.integrity_check}`);
  if (dbServerId !== manifest.server_id) throw new Error("Backup manifest and database server IDs do not match");

  const destination = serverDbPath();
  if (existsSync(destination) && !replace) {
    throw new Error(`A server database already exists at ${destination}; stop Burn and retry with --replace`);
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const incoming = `${destination}.incoming-${process.pid}`;
  copyFileSync(sourceDb, incoming);
  if (existsSync(destination)) {
    // Keep the replaced database and any WAL files recoverable. The service
    // must be stopped: a running SQLite process can recreate sidecars here.
    const stamp = new Date().toISOString().replaceAll(":", "-");
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(destination + suffix)) renameSync(destination + suffix, `${destination}.pre-restore-${stamp}${suffix}`);
    }
  }
  renameSync(incoming, destination);

  const exportedCredentials = join(dir, "server-credentials.json");
  if (existsSync(exportedCredentials)) {
    const imported = JSON.parse(readFileSync(exportedCredentials, "utf8")) as { admin_token?: string };
    if (imported.admin_token) {
      const local = loadCredentials();
      local.admin_token = imported.admin_token;
      saveCredentials(local); // preserves this machine's node and provider credentials
    }
  }
  console.log(`✓ Restored Burn server ${manifest.server_id} to ${destination}`);
  console.log("  Local collector identity and provider credentials were preserved.");
  if (replace) console.log("  The replaced database was retained beside it as server.sqlite.pre-restore-<timestamp>.");
  console.log("  Start it with: burn server install");
}

/** Repair a cloned machine without replaying the source machine's old logs. */
export function reidentifyCollector(): void {
  const creds = loadCredentials();
  if (!creds.node) throw new Error("This machine has no collector identity to reset");
  const oldNode = creds.node.node_id;
  delete creds.node;
  saveCredentials(creds);

  const cfg = loadConfig();
  if (cfg.collector?.server_url) {
    delete cfg.collector.server_url;
    saveConfig(cfg);
  }

  const db = openCollectorDb();
  db.run("DELETE FROM outbox");
  db.run("DELETE FROM sessions");
  db.close();
  console.log(`✓ Removed cloned collector identity ${oldNode}`);
  console.log("  Provider credentials and collection cursors were preserved; pending cloned observations were discarded.");
  console.log("  Run `burn server install` for a server machine, or `burn enroll <server-url>` for a collector.");
}

/** Keep a node ID/history and only change the server address. */
export async function retargetCollector(serverUrl: string): Promise<void> {
  const url = serverUrl.replace(/\/+$/, "");
  const creds = loadCredentials();
  if (!creds.node) throw new Error("This machine is not enrolled; use `burn enroll <server-url>` instead");
  const discovery = await new BurnClient(url).wellKnown();
  if (discovery.product !== "burn") throw new Error(`${url} is not a Burn server`);
  const who = await new BurnClient(url, creds.node.node_token).whoami();
  if (who.node_id !== creds.node.node_id) throw new Error("The destination mapped this credential to a different node ID");

  creds.node.server_url = url;
  saveCredentials(creds);
  const cfg = loadConfig();
  if (cfg.collector?.server_url) {
    cfg.collector.server_url = url;
    saveConfig(cfg);
  }
  console.log(`✓ Retargeted node ${who.node_id} to ${url}`);
  console.log("  Restart the collector service so it picks up the new address.");
}
