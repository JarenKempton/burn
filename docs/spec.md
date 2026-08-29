# Burn v0 specification

Repository-native contracts for the initial implementation. Architecture
decisions: [#7](https://github.com/JarenKempton/burn/issues/7), tracked by map
[#1](https://github.com/JarenKempton/burn/issues/1). This document indexes the
authoritative in-repo sources; the TypeScript types are the wire schema
(TypeScript-first, per #4).

## Contracts and where they live

| Contract | Source of truth |
| --- | --- |
| CLI commands/flags/output | `src/index.ts` (help text) + `src/cli/*` |
| Wire schemas (observations, enrollment, heartbeat, errors) | `src/shared/types.ts` |
| Server SQLite migrations | `src/server/db.ts` (`MIGRATIONS`) |
| Client SQLite migrations (identity/outbox/sessions/cursors) | `src/agent/db.ts` (`MIGRATIONS`) |
| Config schema + file locations | `src/shared/config.ts`, `src/shared/paths.ts` |
| Example payload fixtures | `docs/fixtures/*.json` |
| Provider research findings | `docs/research/issue-{2,3,5,6}-*.md` |

## Versioning

- `OBSERVATION_SCHEMA_VERSION` (currently 1) versions observation envelopes;
  the server rejects unknown versions per-observation, not per-batch.
- The HTTP API is versioned by path prefix (`/v1/...`).
- These are independent: an adapter may ship a new payload schema without an
  API change and vice versa.

## HTTP API surface

```
GET  /.well-known/burn                 discovery: product, protocol, endpoints
GET  /healthz
POST /v1/enrollment/requests           device-authorization request (unauthenticated)
GET  /v1/enrollment/requests/{id}      poll status: pending|approved|denied|expired
POST /v1/enrollment/token              exchange device_code → node credential (single-use)
GET  /enroll?code=USER-CODE            browser approval page (admin)
POST /enroll/action                    approve/deny (admin token)
POST /v1/heartbeat                     node auth (Bearer node token)
POST /v1/observations                  node auth; idempotent by observation_id
GET  /v1/nodes[/{id}] PATCH DELETE     admin auth
GET  /v1/usage                         admin auth; ?since=ISO
GET  /v1/providers                     admin auth
GET  /v1/adapters/health               admin auth
```

## Authentication invariants

- Node tokens and the device code are high-entropy random values; the server
  stores only SHA-256 hashes. A leaked server database yields no usable
  credentials.
- The enrollment `user_code` (shown to humans) and `device_code` (kept by the
  enrolling client) are separate; approval in the browser never sees the
  device code, and token exchange requires both approval and the device code.
- Enrollment requests expire (10 min), are single-use, and are rate-limited
  (max 10 pending).
- Tailnet membership alone never confers admin authorization; admin surfaces
  require the application admin token (Tailscale identity headers are a
  follow-up admin path).
- Provider credentials (`credentials.json`, mode 0600) never leave the
  collecting node and are never part of any observation.

## Redaction invariants

- Adapters parse only usage/stat/rate-limit fields from provider surfaces.
  Prompt and completion content is never read into observations:
  - Claude Code: only `message.usage`, `message.model`, `timestamp`,
    `requestId` from project JSONL; only `rate_limits` from statusline JSON.
  - Codex: only `token_count` event lines from rollout files; `history.jsonl`
    (raw prompt text) is never opened.
  - LM Studio: stats fields are extracted in-process from the log stream and
    the event (which contains output text) is dropped immediately. Server
    file logs (which contain request bodies) are never parsed.
  - OpenRouter: the collection endpoints return counters only; the stored
    generation-content endpoint is never called.
- Unknown values stay null — never invented as zero.
- Currency is integer micros, never binary floating point.

## Idempotency and freshness semantics

- Server ingestion: `INSERT OR IGNORE` keyed by `observation_id`; the batch
  result reports accepted/duplicate/rejected per ID (testable from fixtures —
  see `test/e2e.test.ts`).
- Client outbox entries are deleted only after server acknowledgement
  (accepted *or* duplicate); rejected entries are dropped and logged.
- Log-file adapters use per-file byte cursors and only consume files quiesced
  for ≥120 s, so each region is read exactly once (`src/providers/jsonl.ts`).
- OpenRouter daily activity rows are final (completed UTC days) and map to
  deterministic observation IDs derived from their natural key
  (date × model × endpoint), so re-fetching the 30-day window is idempotent
  server-side.
- Node liveness derives from server receipt time only: online < 2×
  heartbeat interval, stale < 10×, else offline. Client `sent_at` is stored
  but never trusted for liveness.

## Concept separation (never conflated)

`quota_snapshot` (provider-reported window state), `consumption` (measured
tokens/requests/cost), `credit_balance` (prepaid balance), and any future
synthetic pacing budget are distinct payload types with distinct semantics.
Window kinds (`rolling|fixed|lifetime|request|unknown`) are preserved from the
provider; unknown windows stay `unknown`.

## Unknown provider fields

Normalized columns come only from the typed payloads. Anything else a
provider returns belongs in `raw_payloads` (redacted) via `raw_ref` — it can
be re-normalized later without ever having entered query columns.

## File locations

| | Linux | macOS |
| --- | --- | --- |
| config | `$XDG_CONFIG_HOME/burn/config.json` | `~/Library/Application Support/burn/config.json` |
| credentials | `$XDG_CONFIG_HOME/burn/credentials.json` (0600) | same dir as config |
| state (SQLite) | `$XDG_STATE_HOME/burn/{server,agent}.sqlite` | `~/Library/Application Support/burn/state/` |
| logs | `$XDG_STATE_HOME/burn/logs` | `~/Library/Logs/burn` |

`BURN_CONFIG_DIR`, `BURN_STATE_DIR`, `BURN_LOG_DIR` override.
