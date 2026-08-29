import { Database } from "bun:sqlite";
import { agentDbPath } from "../shared/paths";
import type { ObservationEnvelope } from "../shared/types";
import { nowIso } from "../shared/util";

// Client-side identity, offline outbox, session markers, and adapter cursors.
// Outbox entries are removed only after server acknowledgement (issue #7).

const MIGRATIONS: string[] = [
  `
  CREATE TABLE kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE outbox (
    observation_id TEXT PRIMARY KEY,
    envelope_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
  );

  CREATE TABLE sessions (
    boot_id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    clean INTEGER NOT NULL DEFAULT 0
  );

  -- per-adapter incremental collection state (e.g. last file offset, last day)
  CREATE TABLE cursors (
    provider_id TEXT NOT NULL,
    cursor_key TEXT NOT NULL,
    cursor_value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (provider_id, cursor_key)
  );
  `,
];

export function openAgentDb(path = agentDbPath()): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
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
      db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [version, nowIso()]);
    })();
  });
  return db;
}

export function enqueue(db: Database, envelopes: ObservationEnvelope[]): void {
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO outbox (observation_id, envelope_json, created_at) VALUES (?, ?, ?)"
  );
  db.transaction(() => {
    for (const e of envelopes) stmt.run(e.observation_id, JSON.stringify(e), nowIso());
  })();
}

export function peekBatch(db: Database, limit = 200): ObservationEnvelope[] {
  return db
    .query<{ envelope_json: string }, [number]>(
      "SELECT envelope_json FROM outbox ORDER BY created_at LIMIT ?"
    )
    .all(limit)
    .map((r) => JSON.parse(r.envelope_json) as ObservationEnvelope);
}

export function ack(db: Database, ids: string[]): void {
  const stmt = db.prepare("DELETE FROM outbox WHERE observation_id = ?");
  db.transaction(() => {
    for (const id of ids) stmt.run(id);
  })();
}

export function markAttempt(db: Database, ids: string[], error: string): void {
  const stmt = db.prepare(
    "UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE observation_id = ?"
  );
  db.transaction(() => {
    for (const id of ids) stmt.run(error, id);
  })();
}

export function outboxDepth(db: Database): number {
  return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM outbox").get()!.n;
}

export function getCursor(db: Database, provider: string, key: string): string | null {
  const row = db
    .query<{ cursor_value: string }, [string, string]>(
      "SELECT cursor_value FROM cursors WHERE provider_id = ? AND cursor_key = ?"
    )
    .get(provider, key);
  return row?.cursor_value ?? null;
}

export function setCursor(db: Database, provider: string, key: string, value: string): void {
  db.run(
    `INSERT INTO cursors (provider_id, cursor_key, cursor_value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(provider_id, cursor_key) DO UPDATE SET cursor_value = excluded.cursor_value, updated_at = excluded.updated_at`,
    [provider, key, value, nowIso()]
  );
}

export function beginSession(db: Database, bootId: string): { previousUnclean: string | null } {
  const prev = db
    .query<{ boot_id: string }, []>(
      "SELECT boot_id FROM sessions WHERE clean = 0 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1"
    )
    .get();
  db.run("INSERT INTO sessions (boot_id, started_at) VALUES (?, ?)", [bootId, nowIso()]);
  return { previousUnclean: prev?.boot_id ?? null };
}

export function endSession(db: Database, bootId: string): void {
  db.run("UPDATE sessions SET ended_at = ?, clean = 1 WHERE boot_id = ?", [nowIso(), bootId]);
}
