import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { Database } from "bun:sqlite";
import { openServerDb, getMeta, setMeta } from "./db";
import { approvalPage, approvalResultPage } from "./pages";
import {
  API_VERSION,
  PROTOCOL_VERSION,
  OBSERVATION_SCHEMA_VERSION,
  type EnrollmentRequestCreate,
  type EnrollmentRequestCreated,
  type EnrollmentTokenExchange,
  type EnrollmentTokenIssued,
  type HeartbeatRequest,
  type ObservationBatchResult,
  type ObservationEnvelope,
  type NodeLiveness,
  type WellKnownBurn,
} from "../shared/types";
import { loadConfig, loadCredentials, saveCredentials, DEFAULT_PORT, DEFAULT_HEARTBEAT_SECONDS } from "../shared/config";
import { newId, newToken, newUserCode, nowIso, sha256Hex, timingSafeEqualStr } from "../shared/util";
import { hostname } from "node:os";

const ENROLL_TTL_MS = 10 * 60 * 1000;
const ENROLL_RATE_LIMIT = 10; // pending requests at once

const PAYLOAD_TYPES = new Set([
  "quota_snapshot",
  "consumption",
  "credit_balance",
  "inference_performance",
  "adapter_status",
]);
const SOURCE_QUALITIES = new Set([
  "official_api",
  "official_cli",
  "experimental_rpc",
  "local_log",
  "estimated",
]);

interface NodeRow {
  node_id: string;
  name: string;
  platform: string;
  collector_version: string | null;
  token_hash: string;
  created_at: string;
  approved_at: string;
  revoked_at: string | null;
  last_heartbeat_sent_at: string | null;
  last_heartbeat_received_at: string | null;
  last_boot_id: string | null;
  last_termination: string | null;
}

export interface ServerHandle {
  stop(): void;
  port: number;
  adminToken: string;
  serverId: string;
}

type Env = { Variables: { node: NodeRow } };

const apiError = (code: string, message: string) => ({ error: { code, message } });

export function startServer(opts?: { port?: number; host?: string; dbPath?: string }): ServerHandle {
  const cfg = loadConfig();
  const db = openServerDb(opts?.dbPath);
  const host = opts?.host ?? cfg.server?.host ?? "127.0.0.1";
  const port = opts?.port ?? cfg.server?.port ?? DEFAULT_PORT;
  const serverName = cfg.server?.name ?? hostname();
  const heartbeatInterval = cfg.server?.heartbeat_interval_seconds ?? DEFAULT_HEARTBEAT_SECONDS;

  let serverId = getMeta(db, "server_id");
  if (!serverId) {
    serverId = newId();
    setMeta(db, "server_id", serverId);
  }

  // Application auth for admin surfaces. Generated once; shown via `burn config`.
  const creds = loadCredentials();
  if (!creds.admin_token) {
    creds.admin_token = newToken();
    saveCredentials(creds);
  }
  const adminToken = creds.admin_token;

  const liveness = (row: NodeRow): NodeLiveness => {
    if (!row.last_heartbeat_received_at) return "offline";
    const age = (Date.now() - Date.parse(row.last_heartbeat_received_at)) / 1000;
    if (age < heartbeatInterval * 2) return "online";
    if (age < heartbeatInterval * 10) return "stale";
    return "offline";
  };

  const expireStale = () => {
    db.run("UPDATE enrollment_requests SET status = 'expired' WHERE status = 'pending' AND expires_at < ?", [
      nowIso(),
    ]);
  };

  const app = new Hono<Env>();

  // ---- Auth middleware ----

  // Nodes authenticate with their enrollment-issued token (hash stored server-side).
  app.use("/v1/heartbeat", nodeAuth);
  app.use("/v1/observations", nodeAuth);

  async function nodeAuth(c: Context<Env>, next: Next) {
    const h = c.req.header("authorization");
    const token = h?.startsWith("Bearer ") ? h.slice(7) : null;
    const row = token
      ? db.query<NodeRow, [string]>("SELECT * FROM nodes WHERE token_hash = ? AND revoked_at IS NULL").get(sha256Hex(token))
      : null;
    if (!row) return c.json(apiError("unauthorized", "Valid node token required"), 401);
    c.set("node", row);
    await next();
  }

  // Admin surfaces use the application admin token. Tailnet membership alone
  // never confers admin authorization (issue #7); Tailscale identity headers
  // are a follow-up admin path.
  app.use("/v1/nodes", adminAuth);
  app.use("/v1/nodes/*", adminAuth);
  app.use("/v1/usage", adminAuth);
  app.use("/v1/providers", adminAuth);
  app.use("/v1/adapters/*", adminAuth);

  async function adminAuth(c: Context<Env>, next: Next) {
    const h = c.req.header("authorization");
    const token = (h?.startsWith("Bearer ") ? h.slice(7) : null) ?? c.req.query("admin_token");
    if (!token || !timingSafeEqualStr(token, adminToken))
      return c.json(apiError("unauthorized", "Admin token required"), 401);
    await next();
  }

  // ---- Discovery ----

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.get("/.well-known/burn", (c) => {
    const body: WellKnownBurn = {
      product: "burn",
      protocol_version: PROTOCOL_VERSION,
      server_id: serverId!,
      server_name: serverName,
      enrollment_enabled: true,
      endpoints: {
        enrollment_requests: `/${API_VERSION}/enrollment/requests`,
        enrollment_token: `/${API_VERSION}/enrollment/token`,
        observations: `/${API_VERSION}/observations`,
        heartbeat: `/${API_VERSION}/heartbeat`,
      },
    };
    return c.json(body);
  });

  // ---- Enrollment (unauthenticated client side) ----

  app.post("/v1/enrollment/requests", async (c) => {
    expireStale();
    const pending = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM enrollment_requests WHERE status = 'pending'")
      .get()!.n;
    if (pending >= ENROLL_RATE_LIMIT)
      return c.json(apiError("rate_limited", "Too many pending enrollment requests"), 429);

    const body = await c.req.json<EnrollmentRequestCreate>();
    if (!body?.node_name || !body?.platform)
      return c.json(apiError("invalid_request", "node_name and platform are required"), 400);

    const requestId = newId();
    const userCode = newUserCode();
    const deviceCode = newToken(32);
    const expiresAt = new Date(Date.now() + ENROLL_TTL_MS).toISOString();
    db.run(
      `INSERT INTO enrollment_requests
       (request_id, user_code, device_code_hash, node_name, platform, collector_version, status, requested_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [requestId, userCode, sha256Hex(deviceCode), body.node_name, body.platform, body.collector_version ?? null, nowIso(), expiresAt]
    );
    const origin = new URL(c.req.url).origin;
    const created: EnrollmentRequestCreated = {
      request_id: requestId,
      user_code: userCode,
      device_code: deviceCode,
      verification_url: `${origin}/enroll?code=${userCode}`,
      expires_at: expiresAt,
      poll_interval_seconds: 2,
    };
    return c.json(created, 201);
  });

  app.get("/v1/enrollment/requests/:id", (c) => {
    expireStale();
    const row = db
      .query<{ status: string; expires_at: string }, [string]>(
        "SELECT status, expires_at FROM enrollment_requests WHERE request_id = ?"
      )
      .get(c.req.param("id"));
    if (!row) return c.json(apiError("not_found", "Unknown enrollment request"), 404);
    return c.json({ status: row.status, expires_at: row.expires_at });
  });

  app.post("/v1/enrollment/token", async (c) => {
    const body = await c.req.json<EnrollmentTokenExchange>();
    const row = db
      .query<
        { request_id: string; status: string; device_code_hash: string; token_issued_at: string | null; node_name: string; platform: string; collector_version: string | null },
        [string]
      >(
        "SELECT request_id, status, device_code_hash, token_issued_at, node_name, platform, collector_version FROM enrollment_requests WHERE request_id = ?"
      )
      .get(body.request_id ?? "");
    if (!row || row.device_code_hash !== sha256Hex(body.device_code ?? ""))
      return c.json(apiError("invalid_grant", "Unknown request or bad device code"), 400);
    if (row.status !== "approved") return c.json(apiError("not_approved", `Request is ${row.status}`), 400);
    if (row.token_issued_at) return c.json(apiError("already_used", "Token already issued for this request"), 400);

    const nodeId = newId();
    const nodeToken = newToken(32);
    const now = nowIso();
    db.transaction(() => {
      db.run(
        "INSERT INTO nodes (node_id, name, platform, collector_version, token_hash, created_at, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [nodeId, row.node_name, row.platform, row.collector_version, sha256Hex(nodeToken), now, now]
      );
      db.run("UPDATE enrollment_requests SET token_issued_at = ?, node_id = ? WHERE request_id = ?", [
        now,
        nodeId,
        row.request_id,
      ]);
    })();
    const issued: EnrollmentTokenIssued = {
      node_id: nodeId,
      node_token: nodeToken,
      canonical_url: new URL(c.req.url).origin,
    };
    return c.json(issued, 201);
  });

  // ---- Enrollment approval page (admin, browser) ----

  app.get("/enroll", (c) => {
    expireStale();
    const code = c.req.query("code") ?? "";
    const row = db
      .query<
        { request_id: string; user_code: string; node_name: string; platform: string; requested_at: string; status: string },
        [string]
      >(
        "SELECT request_id, user_code, node_name, platform, requested_at, status FROM enrollment_requests WHERE user_code = ? ORDER BY requested_at DESC"
      )
      .get(code);
    return c.html(approvalPage(code, row ?? null));
  });

  app.post("/enroll/action", async (c) => {
    const form = await c.req.formData();
    const token = String(form.get("admin_token") ?? "");
    if (!timingSafeEqualStr(token, adminToken))
      return c.html(approvalResultPage("Invalid admin token.", false), 403);
    const requestId = String(form.get("request_id") ?? "");
    const action = String(form.get("action") ?? "");
    const status = action === "approve" ? "approved" : "denied";
    const changed = db.run(
      "UPDATE enrollment_requests SET status = ?, decided_at = ? WHERE request_id = ? AND status = 'pending' AND expires_at >= ?",
      [status, nowIso(), requestId, nowIso()]
    ).changes;
    const msg = changed
      ? `Enrollment ${status}. You can close this tab.`
      : "Request was not pending (expired or already decided).";
    return c.html(approvalResultPage(msg, changed > 0 && status === "approved"));
  });

  // ---- Authenticated collector ingestion ----

  app.post("/v1/heartbeat", async (c) => {
    const node = c.get("node");
    const body = await c.req.json<HeartbeatRequest>();
    db.run(
      `UPDATE nodes SET last_heartbeat_sent_at = ?, last_heartbeat_received_at = ?, collector_version = ?, last_boot_id = ?,
       last_termination = COALESCE(?, last_termination) WHERE node_id = ?`,
      [
        body.sent_at ?? null,
        nowIso(),
        body.collector_version ?? node.collector_version,
        body.boot_id ?? null,
        body.previous_session?.termination ?? null,
        node.node_id,
      ]
    );
    return c.json({ ok: true, received_at: nowIso() });
  });

  app.post("/v1/observations", async (c) => {
    const node = c.get("node");
    const body = await c.req.json<{ observations: ObservationEnvelope[] }>();
    if (!Array.isArray(body?.observations))
      return c.json(apiError("invalid_request", "observations array required"), 400);

    const result: ObservationBatchResult = { accepted: [], duplicate: [], rejected: [] };
    const insert = db.prepare(
      `INSERT OR IGNORE INTO observations
       (observation_id, schema_version, node_id, provider_id, account_ref, observed_at, collected_at, received_at,
        adapter_id, adapter_version, source_quality, payload_type, payload_json, raw_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    db.transaction(() => {
      for (const obs of body.observations) {
        const reason = validateObservation(obs, node.node_id);
        if (reason) {
          result.rejected.push({ observation_id: obs?.observation_id ?? "?", reason });
          continue;
        }
        const res = insert.run(
          obs.observation_id,
          obs.schema_version,
          node.node_id,
          obs.provider_id,
          obs.account_ref ?? null,
          obs.observed_at,
          obs.collected_at,
          nowIso(),
          obs.adapter_id,
          obs.adapter_version,
          obs.source_quality,
          obs.payload.type,
          JSON.stringify(obs.payload),
          obs.raw_ref ?? null
        );
        (res.changes > 0 ? result.accepted : result.duplicate).push(obs.observation_id);
      }
    })();
    return c.json(result);
  });

  // ---- Authenticated query/admin ----

  app.get("/v1/nodes", (c) => {
    const rows = db.query<NodeRow, []>("SELECT * FROM nodes WHERE revoked_at IS NULL").all();
    return c.json({
      nodes: rows.map((r) => ({
        node_id: r.node_id,
        name: r.name,
        platform: r.platform,
        collector_version: r.collector_version,
        liveness: liveness(r),
        last_heartbeat_sent_at: r.last_heartbeat_sent_at,
        last_heartbeat_received_at: r.last_heartbeat_received_at,
        last_termination: r.last_termination,
        approved_at: r.approved_at,
      })),
    });
  });

  app.get("/v1/nodes/:id", (c) => {
    const row = db.query<NodeRow, [string]>("SELECT * FROM nodes WHERE node_id = ?").get(c.req.param("id"));
    if (!row) return c.json(apiError("not_found", "Unknown node"), 404);
    return c.json({ ...row, token_hash: undefined, liveness: liveness(row) });
  });

  app.patch("/v1/nodes/:id", async (c) => {
    const body = await c.req.json<{ name?: string }>();
    if (body.name) db.run("UPDATE nodes SET name = ? WHERE node_id = ?", [body.name, c.req.param("id")]);
    return c.json({ ok: true });
  });

  app.delete("/v1/nodes/:id", (c) => {
    db.run("UPDATE nodes SET revoked_at = ? WHERE node_id = ?", [nowIso(), c.req.param("id")]);
    return c.json({ ok: true });
  });

  app.get("/v1/usage", (c) => c.json(usageSummary(db, c.req.query("since"))));

  app.get("/v1/providers", (c) => {
    const rows = db
      .query<{ provider_id: string; n: number; last: string }, []>(
        "SELECT provider_id, COUNT(*) AS n, MAX(observed_at) AS last FROM observations GROUP BY provider_id"
      )
      .all();
    return c.json({
      providers: rows.map((r) => ({ provider_id: r.provider_id, observations: r.n, last_observed_at: r.last })),
    });
  });

  app.get("/v1/adapters/health", (c) => {
    const rows = db
      .query<{ node_id: string; provider_id: string; payload_json: string; observed_at: string }, []>(
        `SELECT node_id, provider_id, payload_json, MAX(observed_at) AS observed_at
         FROM observations WHERE payload_type = 'adapter_status'
         GROUP BY node_id, provider_id`
      )
      .all();
    return c.json({
      adapters: rows.map((r) => ({
        node_id: r.node_id,
        provider_id: r.provider_id,
        observed_at: r.observed_at,
        ...JSON.parse(r.payload_json),
      })),
    });
  });

  app.notFound((c) => c.json(apiError("not_found", `No route: ${c.req.method} ${new URL(c.req.url).pathname}`), 404));
  app.onError((err, c) => c.json(apiError("internal", String(err)), 500));

  const server = Bun.serve({ hostname: host, port, fetch: app.fetch });

  return {
    stop: () => {
      server.stop(true);
      db.close();
    },
    port: server.port!,
    adminToken,
    serverId: serverId!,
  };
}

function validateObservation(obs: ObservationEnvelope, authedNodeId: string): string | null {
  if (!obs || typeof obs !== "object") return "not an object";
  if (obs.schema_version !== OBSERVATION_SCHEMA_VERSION)
    return `unsupported schema_version ${obs.schema_version}`;
  if (!obs.observation_id) return "missing observation_id";
  if (obs.node_id !== authedNodeId) return "node_id does not match authenticated node";
  if (!obs.provider_id) return "missing provider_id";
  if (!obs.observed_at || !obs.collected_at) return "missing timestamps";
  if (!obs.adapter_id || !obs.adapter_version) return "missing adapter identity";
  if (!SOURCE_QUALITIES.has(obs.source_quality)) return `invalid source_quality`;
  if (!obs.payload || !PAYLOAD_TYPES.has(obs.payload.type)) return "invalid payload type";
  return null;
}

function usageSummary(db: Database, sinceParam?: string) {
  const since = sinceParam ?? new Date(Date.now() - 30 * 86400_000).toISOString();
  const consumption = db
    .query<
      { provider_id: string; day: string; model: string | null; input_tokens: number | null; cached: number | null; output_tokens: number | null; reasoning: number | null; requests: number | null; cost_micros: number | null },
      [string]
    >(
      `SELECT provider_id,
              substr(observed_at, 1, 10) AS day,
              json_extract(payload_json, '$.model') AS model,
              SUM(json_extract(payload_json, '$.input_tokens')) AS input_tokens,
              SUM(json_extract(payload_json, '$.cached_input_tokens')) AS cached,
              SUM(json_extract(payload_json, '$.output_tokens')) AS output_tokens,
              SUM(json_extract(payload_json, '$.reasoning_output_tokens')) AS reasoning,
              SUM(json_extract(payload_json, '$.requests')) AS requests,
              SUM(json_extract(payload_json, '$.cost_micros')) AS cost_micros
       FROM observations
       WHERE payload_type = 'consumption' AND observed_at >= ?
       GROUP BY provider_id, day, model
       ORDER BY day DESC`
    )
    .all(since);

  const quotas = db
    .query<{ node_id: string; provider_id: string; payload_json: string; observed_at: string }, []>(
      `SELECT o.node_id, o.provider_id, o.payload_json, o.observed_at
       FROM observations o
       JOIN (SELECT node_id, provider_id, json_extract(payload_json, '$.window.label') AS lbl, MAX(observed_at) AS m
             FROM observations WHERE payload_type = 'quota_snapshot'
             GROUP BY node_id, provider_id, lbl) latest
       ON o.node_id = latest.node_id AND o.provider_id = latest.provider_id AND o.observed_at = latest.m
       WHERE o.payload_type = 'quota_snapshot'`
    )
    .all();

  const credits = db
    .query<{ provider_id: string; payload_json: string; observed_at: string }, []>(
      `SELECT o.provider_id, o.payload_json, o.observed_at
       FROM observations o
       JOIN (SELECT provider_id, MAX(observed_at) AS m FROM observations
             WHERE payload_type = 'credit_balance' GROUP BY provider_id) latest
       ON o.provider_id = latest.provider_id AND o.observed_at = latest.m
       WHERE o.payload_type = 'credit_balance'`
    )
    .all();

  return {
    since,
    consumption_by_day: consumption,
    latest_quota_snapshots: quotas.map((q) => ({
      node_id: q.node_id,
      provider_id: q.provider_id,
      observed_at: q.observed_at,
      ...JSON.parse(q.payload_json),
    })),
    latest_credit_balances: credits.map((c) => ({
      provider_id: c.provider_id,
      observed_at: c.observed_at,
      ...JSON.parse(c.payload_json),
    })),
  };
}
