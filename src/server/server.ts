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

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function apiError(code: string, message: string, status: number): Response {
  return json({ error: { code, message } }, status);
}

interface NodeRow {
  node_id: string;
  name: string;
  platform: string;
  agent_version: string | null;
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

  const bearerToken = (req: Request): string | null => {
    const h = req.headers.get("authorization");
    if (!h?.startsWith("Bearer ")) return null;
    return h.slice(7);
  };

  // Tailnet membership alone does not confer admin authorization (issue #7):
  // Tailscale-identity admin requires explicit config; v0 uses the app token.
  const isAdmin = (req: Request, url: URL): boolean => {
    const token = bearerToken(req) ?? url.searchParams.get("admin_token");
    return token !== null && timingSafeEqualStr(token, adminToken);
  };

  const authNode = (req: Request): NodeRow | null => {
    const token = bearerToken(req);
    if (!token) return null;
    const row = db
      .query<NodeRow, [string]>("SELECT * FROM nodes WHERE token_hash = ? AND revoked_at IS NULL")
      .get(sha256Hex(token));
    return row ?? null;
  };

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

  const server = Bun.serve({
    hostname: host,
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      try {
        // ---- Discovery ----
        if (method === "GET" && path === "/healthz") return json({ ok: true });
        if (method === "GET" && path === "/.well-known/burn") {
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
          return json(body);
        }

        // ---- Enrollment (unauthenticated client side) ----
        if (method === "POST" && path === "/v1/enrollment/requests") {
          expireStale();
          const pending = db
            .query<{ n: number }, []>(
              "SELECT COUNT(*) AS n FROM enrollment_requests WHERE status = 'pending'"
            )
            .get()!.n;
          if (pending >= ENROLL_RATE_LIMIT)
            return apiError("rate_limited", "Too many pending enrollment requests", 429);

          const body = (await req.json()) as EnrollmentRequestCreate;
          if (!body?.node_name || !body?.platform)
            return apiError("invalid_request", "node_name and platform are required", 400);

          const requestId = newId();
          const userCode = newUserCode();
          const deviceCode = newToken(32);
          const expiresAt = new Date(Date.now() + ENROLL_TTL_MS).toISOString();
          db.run(
            `INSERT INTO enrollment_requests
             (request_id, user_code, device_code_hash, node_name, platform, agent_version, status, requested_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
            [requestId, userCode, sha256Hex(deviceCode), body.node_name, body.platform, body.agent_version ?? null, nowIso(), expiresAt]
          );
          const created: EnrollmentRequestCreated = {
            request_id: requestId,
            user_code: userCode,
            device_code: deviceCode,
            verification_url: `${url.origin}/enroll?code=${userCode}`,
            expires_at: expiresAt,
            poll_interval_seconds: 2,
          };
          return json(created, 201);
        }

        const pollMatch = path.match(/^\/v1\/enrollment\/requests\/([\w-]+)$/);
        if (method === "GET" && pollMatch) {
          expireStale();
          const row = db
            .query<{ status: string; expires_at: string }, [string]>(
              "SELECT status, expires_at FROM enrollment_requests WHERE request_id = ?"
            )
            .get(pollMatch[1]!);
          if (!row) return apiError("not_found", "Unknown enrollment request", 404);
          return json({ status: row.status, expires_at: row.expires_at });
        }

        if (method === "POST" && path === "/v1/enrollment/token") {
          const body = (await req.json()) as EnrollmentTokenExchange;
          const row = db
            .query<
              { request_id: string; status: string; device_code_hash: string; token_issued_at: string | null; node_name: string; platform: string; agent_version: string | null },
              [string]
            >("SELECT request_id, status, device_code_hash, token_issued_at, node_name, platform, agent_version FROM enrollment_requests WHERE request_id = ?")
            .get(body.request_id ?? "");
          if (!row || row.device_code_hash !== sha256Hex(body.device_code ?? ""))
            return apiError("invalid_grant", "Unknown request or bad device code", 400);
          if (row.status !== "approved") return apiError("not_approved", `Request is ${row.status}`, 400);
          if (row.token_issued_at) return apiError("already_used", "Token already issued for this request", 400);

          const nodeId = newId();
          const nodeToken = newToken(32);
          const now = nowIso();
          db.transaction(() => {
            db.run(
              "INSERT INTO nodes (node_id, name, platform, agent_version, token_hash, created_at, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
              [nodeId, row.node_name, row.platform, row.agent_version, sha256Hex(nodeToken), now, now]
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
            canonical_url: url.origin,
          };
          return json(issued, 201);
        }

        // ---- Enrollment approval page (admin, browser) ----
        if (method === "GET" && path === "/enroll") {
          expireStale();
          const code = url.searchParams.get("code") ?? "";
          const row = db
            .query<
              { request_id: string; user_code: string; node_name: string; platform: string; requested_at: string; status: string },
              [string]
            >(
              "SELECT request_id, user_code, node_name, platform, requested_at, status FROM enrollment_requests WHERE user_code = ? ORDER BY requested_at DESC"
            )
            .get(code);
          return new Response(approvalPage(code, row ?? null), {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }

        if (method === "POST" && path === "/enroll/action") {
          const form = await req.formData();
          const token = String(form.get("admin_token") ?? "");
          if (!timingSafeEqualStr(token, adminToken))
            return new Response(approvalResultPage("Invalid admin token.", false), {
              status: 403,
              headers: { "content-type": "text/html; charset=utf-8" },
            });
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
          return new Response(approvalResultPage(msg, changed > 0 && status === "approved"), {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }

        // ---- Authenticated agent ingestion ----
        if (method === "POST" && path === "/v1/heartbeat") {
          const node = authNode(req);
          if (!node) return apiError("unauthorized", "Valid node token required", 401);
          const body = (await req.json()) as HeartbeatRequest;
          db.run(
            `UPDATE nodes SET last_heartbeat_sent_at = ?, last_heartbeat_received_at = ?, agent_version = ?, last_boot_id = ?,
             last_termination = COALESCE(?, last_termination) WHERE node_id = ?`,
            [
              body.sent_at ?? null,
              nowIso(),
              body.agent_version ?? node.agent_version,
              body.boot_id ?? null,
              body.previous_session?.termination ?? null,
              node.node_id,
            ]
          );
          return json({ ok: true, received_at: nowIso() });
        }

        if (method === "POST" && path === "/v1/observations") {
          const node = authNode(req);
          if (!node) return apiError("unauthorized", "Valid node token required", 401);
          const body = (await req.json()) as { observations: ObservationEnvelope[] };
          if (!Array.isArray(body?.observations))
            return apiError("invalid_request", "observations array required", 400);

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
          return json(result);
        }

        // ---- Authenticated query/admin ----
        if (path.startsWith("/v1/nodes") || path === "/v1/usage" || path === "/v1/providers" || path === "/v1/adapters/health") {
          if (!isAdmin(req, url)) return apiError("unauthorized", "Admin token required", 401);
        }

        if (method === "GET" && path === "/v1/nodes") {
          const rows = db.query<NodeRow, []>("SELECT * FROM nodes WHERE revoked_at IS NULL").all();
          return json({
            nodes: rows.map((r) => ({
              node_id: r.node_id,
              name: r.name,
              platform: r.platform,
              agent_version: r.agent_version,
              liveness: liveness(r),
              last_heartbeat_sent_at: r.last_heartbeat_sent_at,
              last_heartbeat_received_at: r.last_heartbeat_received_at,
              last_termination: r.last_termination,
              approved_at: r.approved_at,
            })),
          });
        }

        const nodeMatch = path.match(/^\/v1\/nodes\/([\w-]+)$/);
        if (nodeMatch) {
          const nodeId = nodeMatch[1]!;
          const row = db.query<NodeRow, [string]>("SELECT * FROM nodes WHERE node_id = ?").get(nodeId);
          if (!row) return apiError("not_found", "Unknown node", 404);
          if (method === "GET") return json({ ...row, token_hash: undefined, liveness: liveness(row) });
          if (method === "PATCH") {
            const body = (await req.json()) as { name?: string };
            if (body.name) db.run("UPDATE nodes SET name = ? WHERE node_id = ?", [body.name, nodeId]);
            return json({ ok: true });
          }
          if (method === "DELETE") {
            db.run("UPDATE nodes SET revoked_at = ? WHERE node_id = ?", [nowIso(), nodeId]);
            return json({ ok: true });
          }
        }

        if (method === "GET" && path === "/v1/usage") {
          return json(usageSummary(db, url));
        }

        if (method === "GET" && path === "/v1/providers") {
          const rows = db
            .query<{ provider_id: string; n: number; last: string }, []>(
              "SELECT provider_id, COUNT(*) AS n, MAX(observed_at) AS last FROM observations GROUP BY provider_id"
            )
            .all();
          return json({ providers: rows.map((r) => ({ provider_id: r.provider_id, observations: r.n, last_observed_at: r.last })) });
        }

        if (method === "GET" && path === "/v1/adapters/health") {
          const rows = db
            .query<{ node_id: string; provider_id: string; payload_json: string; observed_at: string }, []>(
              `SELECT node_id, provider_id, payload_json, MAX(observed_at) AS observed_at
               FROM observations WHERE payload_type = 'adapter_status'
               GROUP BY node_id, provider_id`
            )
            .all();
          return json({
            adapters: rows.map((r) => ({
              node_id: r.node_id,
              provider_id: r.provider_id,
              observed_at: r.observed_at,
              ...JSON.parse(r.payload_json),
            })),
          });
        }

        return apiError("not_found", `No route: ${method} ${path}`, 404);
      } catch (err) {
        return apiError("internal", String(err), 500);
      }
    },
  });

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

function usageSummary(db: Database, url: URL) {
  const since = url.searchParams.get("since") ?? new Date(Date.now() - 30 * 86400_000).toISOString();
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
