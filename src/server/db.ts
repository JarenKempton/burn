import { Database } from "bun:sqlite";
import { serverDbPath } from "../shared/paths";

// Append-only normalized observations with WAL (issue #7). Migrations are
// sequential and recorded in schema_migrations.

const MIGRATIONS: string[] = [
  `
  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE nodes (
    node_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    platform TEXT NOT NULL,
    agent_version TEXT,
    token_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    approved_at TEXT NOT NULL,
    revoked_at TEXT,
    last_heartbeat_sent_at TEXT,
    last_heartbeat_received_at TEXT,
    last_boot_id TEXT,
    last_termination TEXT
  );

  CREATE TABLE enrollment_requests (
    request_id TEXT PRIMARY KEY,
    user_code TEXT NOT NULL,
    device_code_hash TEXT NOT NULL,
    node_name TEXT NOT NULL,
    platform TEXT NOT NULL,
    agent_version TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    requested_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    decided_at TEXT,
    token_issued_at TEXT,
    node_id TEXT
  );
  CREATE INDEX idx_enroll_user_code ON enrollment_requests(user_code);

  CREATE TABLE observations (
    observation_id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL,
    node_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    account_ref TEXT,
    observed_at TEXT NOT NULL,
    collected_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    adapter_id TEXT NOT NULL,
    adapter_version TEXT NOT NULL,
    source_quality TEXT NOT NULL,
    payload_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    raw_ref TEXT
  );
  CREATE INDEX idx_obs_provider_time ON observations(provider_id, observed_at);
  CREATE INDEX idx_obs_node_time ON observations(node_id, observed_at);
  CREATE INDEX idx_obs_type ON observations(payload_type, observed_at);

  CREATE TABLE raw_payloads (
    raw_ref TEXT PRIMARY KEY,
    node_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
  );

  CREATE TABLE adapter_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    adapter_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,
    message TEXT
  );
  `,
  // The collecting role was renamed agent → collector.
  `
  ALTER TABLE nodes RENAME COLUMN agent_version TO collector_version;
  ALTER TABLE enrollment_requests RENAME COLUMN agent_version TO collector_version;
  `,
  // Admin accounts for browser surfaces (username/password, argon2id hash).
  `
  CREATE TABLE users (
    username TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
];

export function openServerDb(path = serverDbPath()): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);"
  );
  const applied = db
    .query<{ version: number }, []>("SELECT version FROM schema_migrations")
    .all()
    .map((r) => r.version);
  MIGRATIONS.forEach((sql, i) => {
    const version = i + 1;
    if (applied.includes(version)) return;
    db.transaction(() => {
      db.exec(sql);
      db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [
        version,
        new Date().toISOString(),
      ]);
    })();
  });
  return db;
}

export function getMeta(db: Database, key: string): string | null {
  const row = db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key);
  return row?.value ?? null;
}

export function setMeta(db: Database, key: string, value: string): void {
  db.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [
    key,
    value,
  ]);
}
