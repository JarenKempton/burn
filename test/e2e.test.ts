import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate all config/state before importing anything that resolves paths.
const tmp = mkdtempSync(join(tmpdir(), "burn-test-"));
process.env.BURN_CONFIG_DIR = join(tmp, "config");
process.env.BURN_STATE_DIR = join(tmp, "state");

const { startServer } = await import("../src/server/server");
const { BurnClient } = await import("../src/collector/client");
const { loadCredentials } = await import("../src/shared/config");
const { newId, nowIso } = await import("../src/shared/util");
import type { ObservationEnvelope } from "../src/shared/types";

let handle: ReturnType<typeof startServer>;
let base: string;

beforeAll(() => {
  handle = startServer({ port: 0, dbPath: join(tmp, "server.sqlite") });
  base = `http://127.0.0.1:${handle.port}`;
});

afterAll(() => {
  handle.stop();
  rmSync(tmp, { recursive: true, force: true });
});

function consumption(nodeId: string, id = newId()): ObservationEnvelope {
  return {
    schema_version: 1,
    observation_id: id,
    node_id: nodeId,
    provider_id: "claude_code",
    observed_at: nowIso(),
    collected_at: nowIso(),
    adapter_id: "test",
    adapter_version: "0.0.0",
    source_quality: "local_log",
    payload: {
      type: "consumption",
      period_start: "2026-08-28T00:00:00Z",
      period_end: "2026-08-28T01:00:00Z",
      model: "claude-fable-5",
      input_tokens: 1000,
      cached_input_tokens: 500,
      output_tokens: 200,
      requests: 3,
      counting: "local_log",
    },
  };
}

describe("burn end to end", () => {
  let nodeId: string;
  let nodeToken: string;

  test("discovery", async () => {
    const wk = await new BurnClient(base).wellKnown();
    expect(wk.product).toBe("burn");
    expect(wk.enrollment_enabled).toBe(true);
    expect(wk.server_id).toBe(handle.serverId);
  });

  test("device-authorization enrollment with browser approval", async () => {
    const client = new BurnClient(base);
    const created = await client.createEnrollment({
      node_name: "test-node",
      platform: "linux/x64",
      collector_version: "0.1.0",
    });
    expect(created.user_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    // Token exchange before approval must fail.
    await expect(client.exchangeToken(created.request_id, created.device_code)).rejects.toThrow(/not_approved/);

    // Approving requires a signed-in session; no session → login page, not details.
    const noSession = await fetch(`${base}/enroll/action`, {
      method: "POST",
      body: new URLSearchParams({ request_id: created.request_id, action: "approve" }),
    });
    expect(noSession.status).toBe(403);

    // Before login, the page must not leak the pending request's details.
    const anonymousPage = await fetch(`${base}/enroll?code=${created.user_code}`).then((r) => r.text());
    expect(anonymousPage).not.toContain("test-node");

    const { createUser } = await import("../src/server/auth");
    await createUser(handle.db, "admin", "correct-horse-battery");

    const badLogin = await fetch(`${base}/login`, {
      method: "POST",
      body: new URLSearchParams({ username: "admin", password: "wrong-password", next: "/enroll" }),
    });
    expect(badLogin.status).toBe(403);

    const login = await fetch(`${base}/login`, {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams({
        username: "admin",
        password: "correct-horse-battery",
        next: `/enroll?code=${created.user_code}`,
      }),
    });
    expect(login.status).toBe(302);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;

    const page = await fetch(`${base}/enroll?code=${created.user_code}`, { headers: { cookie } }).then((r) =>
      r.text()
    );
    expect(page).toContain("test-node");

    const approve = await fetch(`${base}/enroll/action`, {
      method: "POST",
      headers: { cookie },
      body: new URLSearchParams({ request_id: created.request_id, action: "approve" }),
    });
    expect(approve.status).toBe(200);

    expect((await client.pollEnrollment(created.request_id)).status).toBe("approved");
    const issued = await client.exchangeToken(created.request_id, created.device_code);
    expect(issued.node_id).toBeTruthy();
    nodeId = issued.node_id;
    nodeToken = issued.node_token;

    // Device codes are single-use.
    await expect(client.exchangeToken(created.request_id, created.device_code)).rejects.toThrow(/already_used/);
  });

  test("enrollment URLs honor reverse-proxy forwarded headers", async () => {
    // Behind Tailscale Serve the local hop is http; returned URLs must use
    // the proxy's advertised scheme/host or collectors save a dead URL.
    const res = await fetch(`${base}/v1/enrollment/requests`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "goliath.tail-example.ts.net",
      },
      body: JSON.stringify({ node_name: "proxy-node", platform: "linux/x64", collector_version: "0.1.0" }),
    });
    const created = await res.json();
    expect(created.verification_url).toStartWith("https://goliath.tail-example.ts.net/enroll?code=");
  });

  test("whoami verifies a node credential without side effects", async () => {
    const client = new BurnClient(base, nodeToken);
    const me = await client.whoami();
    expect(me.node_id).toBe(nodeId);
    await expect(new BurnClient(base, "bad-token").whoami()).rejects.toThrow(/401/);
  });

  test("heartbeat makes the node online", async () => {
    const client = new BurnClient(base, nodeToken);
    const res = await client.heartbeat({ sent_at: nowIso(), boot_id: newId(), collector_version: "0.1.0" });
    expect(res.ok).toBe(true);

    const nodes = await fetch(`${base}/v1/nodes`, {
      headers: { authorization: `Bearer ${handle.adminToken}` },
    }).then((r) => r.json());
    expect(nodes.nodes).toHaveLength(1);
    expect(nodes.nodes[0].liveness).toBe("online");
  });

  test("observation ingestion is idempotent by observation id", async () => {
    const client = new BurnClient(base, nodeToken);
    const obs = consumption(nodeId);
    const first = await client.sendObservations([obs]);
    expect(first.accepted).toEqual([obs.observation_id]);

    const again = await client.sendObservations([obs]);
    expect(again.accepted).toEqual([]);
    expect(again.duplicate).toEqual([obs.observation_id]);
  });

  test("observations are stamped with the authenticated node id", async () => {
    // The envelope's node_id is advisory (an outbox can survive
    // re-enrollment); storage always uses the authenticated identity.
    const client = new BurnClient(base, nodeToken);
    const forged = consumption("some-other-node");
    const res = await client.sendObservations([forged]);
    expect(res.accepted).toEqual([forged.observation_id]);
    const row = handle.db
      .query<{ node_id: string }, [string]>("SELECT node_id FROM observations WHERE observation_id = ?")
      .get(forged.observation_id);
    expect(row?.node_id).toBe(nodeId);
  });

  test("unauthenticated ingestion and queries are rejected", async () => {
    const anon = new BurnClient(base);
    await expect(anon.sendObservations([consumption(nodeId)])).rejects.toThrow(/401/);
    const res = await fetch(`${base}/v1/usage`);
    expect(res.status).toBe(401);
  });

  test("admin API accepts username/password via Basic auth", async () => {
    const ok = await fetch(`${base}/v1/usage`, {
      headers: { authorization: "Basic " + btoa("admin:correct-horse-battery") },
    });
    expect(ok.status).toBe(200);
    const bad = await fetch(`${base}/v1/usage`, {
      headers: { authorization: "Basic " + btoa("admin:nope") },
    });
    expect(bad.status).toBe(401);
  });

  test("usage summary aggregates consumption and surfaces quota snapshots", async () => {
    const client = new BurnClient(base, nodeToken);
    await client.sendObservations([
      {
        ...consumption(nodeId),
        payload: {
          type: "quota_snapshot",
          window: { kind: "rolling", label: "5h", duration_seconds: 18000 },
          used_percent: 42,
          resets_at: "2026-08-28T12:00:00Z",
        },
      },
    ]);

    const usage = await fetch(`${base}/v1/usage`, {
      headers: { authorization: `Bearer ${handle.adminToken}` },
    }).then((r) => r.json());

    // Two consumption observations delivered by earlier tests (1000/200 each).
    const day = usage.consumption_by_day.find((r: any) => r.provider_id === "claude_code");
    expect(day.input_tokens).toBe(2000);
    expect(day.output_tokens).toBe(400);

    const quota = usage.latest_quota_snapshots.find((q: any) => q.provider_id === "claude_code");
    expect(quota.used_percent).toBe(42);
    expect(quota.window.label).toBe("5h");
  });

  test("admin can revoke a node, which cuts off ingestion", async () => {
    const del = await fetch(`${base}/v1/nodes/${nodeId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${handle.adminToken}` },
    });
    expect(del.status).toBe(200);
    const client = new BurnClient(base, nodeToken);
    await expect(client.sendObservations([consumption(nodeId)])).rejects.toThrow(/401/);
  });
});
