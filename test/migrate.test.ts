import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "burn-migrate-test-"));
process.env.BURN_CONFIG_DIR = join(tmp, "config");
process.env.BURN_STATE_DIR = join(tmp, "state");

const { openServerDb, setMeta } = await import("../src/server/db");
const { serverDbPath } = await import("../src/shared/paths");
const { loadCredentials, saveCredentials } = await import("../src/shared/config");
const { openCollectorDb } = await import("../src/collector/db");
const { backupServer, restoreServer, reidentifyCollector } = await import("../src/cli/migrate");

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("server migration", () => {
  test("backup and restore preserve server state without replacing local collector secrets", () => {
    const db = openServerDb();
    setMeta(db, "server_id", "server-goliath");
    db.run(
      "INSERT INTO nodes (node_id, name, platform, token_hash, created_at, approved_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["node-laptop", "laptop", "linux/x64", "hash", new Date().toISOString(), new Date().toISOString()]
    );
    db.close();
    saveCredentials({ admin_token: "goliath-admin", node: { node_id: "cheap-clone", node_token: "local-token", server_url: "old" }, providers: { openrouter: { api_key: "keep-me" } } });

    const backup = join(tmp, "backup");
    backupServer(backup);
    expect(existsSync(join(backup, "server.sqlite"))).toBe(true);
    expect(JSON.parse(readFileSync(join(backup, "manifest.json"), "utf8")).server_id).toBe("server-goliath");

    rmSync(serverDbPath());
    saveCredentials({ admin_token: "cheap-admin", node: { node_id: "cheap-clone", node_token: "local-token", server_url: "old" }, providers: { openrouter: { api_key: "keep-me" } } });
    restoreServer(backup, false);

    const restored = openServerDb();
    expect(restored.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'server_id'").get()?.value).toBe("server-goliath");
    expect(restored.query<{ name: string }, []>("SELECT name FROM nodes WHERE node_id = 'node-laptop'").get()?.name).toBe("laptop");
    restored.close();
    expect(loadCredentials()).toEqual({
      admin_token: "goliath-admin",
      node: { node_id: "cheap-clone", node_token: "local-token", server_url: "old" },
      providers: { openrouter: { api_key: "keep-me" } },
    });
  });

  test("reidentify drops cloned identity and pending data but preserves cursors and providers", () => {
    saveCredentials({ node: { node_id: "free-mini", node_token: "copied", server_url: "old" }, providers: { openrouter: { api_key: "keep-me" } } });
    const db = openCollectorDb();
    db.run("INSERT INTO cursors VALUES (?, ?, ?, ?)", ["codex", "file", "42", new Date().toISOString()]);
    db.run("INSERT INTO outbox VALUES (?, ?, ?, 0, NULL)", ["old-observation", "{}", new Date().toISOString()]);
    db.close();

    reidentifyCollector();
    expect(loadCredentials()).toEqual({ providers: { openrouter: { api_key: "keep-me" } } });
    const after = openCollectorDb();
    expect(after.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM outbox").get()?.n).toBe(0);
    expect(after.query<{ cursor_value: string }, []>("SELECT cursor_value FROM cursors").get()?.cursor_value).toBe("42");
    after.close();
  });
});
