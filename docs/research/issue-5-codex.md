# Issue 5: Codex subscription quota and token collection surfaces

- Issue: JarenKempton/burn#5
- Date: 2026-08-28
- Investigated against: live install `codex-cli 0.150.1` (auth_mode `chatgpt`, plan `prolite`), local `~/.codex/`, and `openai/codex` source at `main` (pushed 2026-08-29).

**Recommendation.** Burn can collect both quota windows and token consumption for Codex without spending any quota. For v0, tail the session rollout JSONL files (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`) and project out only `token_count` events — each one carries authoritative per-session token totals *and* a `rate_limits` snapshot (primary/secondary windows with `used_percent`, `window_minutes`, `resets_at`) piggybacked from response headers. For live/idle quota snapshots, use the `codex app-server` JSON-RPC method `account/rateLimits/read` over stdio: it is a plain metadata GET against the ChatGPT backend (`.../wham/accounts/check` or `.../api/codex/accounts/check`), consumes zero model tokens, is documented in the app-server README with generatable JSON Schema, and is what the official VS Code extension and TUI startup prefetch use. The subcommand is still flagged `[experimental]` in `codex --help`, so treat the RPC schema as version-pinned. Do not call the ChatGPT backend endpoints directly in v0 (undocumented/reverse-engineered, and it means handling the user's OAuth tokens), and never ingest rollout lines other than `token_count`/`session_meta`/`turn_context` — the rest of the file is full prompt/output content.

## Capability matrix

| Surface | Quota windows | Token counts | Stability class | Auth needed | Quota cost to read | Privacy risk |
|---|---|---|---|---|---|---|
| Session rollout JSONL `~/.codex/sessions/**/rollout-*.jsonl` — `event_msg`/`token_count` events | Yes (as-of each turn; stale when idle) | Yes — cumulative + per-turn, all categories | `local_log` (internal format; repo ships rollout migration machinery, so shape drifts across versions) | None (filesystem read) | Zero | **High if misused**: same file holds full prompts/outputs. Project only `token_count`, `session_meta`, `turn_context` fields. |
| `codex app-server` JSON-RPC: `account/rateLimits/read`, `account/rateLimits/updated` (notify), `account/usage/read` | Yes — live, on demand, works while idle | Yes — account summary + daily buckets (`account/usage/read`); per-turn via `thread/tokenUsage/updated` | `experimental_rpc` (protocol fully documented in `codex-rs/app-server/README.md`, versioned schema via `codex app-server generate-json-schema`, powers the official VS Code extension — but the CLI labels the subcommand `[experimental]`) | Reuses `~/.codex/auth.json` (ChatGPT login) transparently; Burn never touches tokens | Zero (backend GET, no model tokens) | Low (no content in these methods) |
| ChatGPT backend HTTP direct: `GET {base}/wham/accounts/check` or `{base}/api/codex/accounts/check`; profile: `/wham/profiles/me` / `/api/codex/profiles/me` (base `https://chatgpt.com/backend-api` or configured `chatgpt_base_url`) | Yes (this is what the RPC/TUI call underneath) | Yes (`profiles/me`: `lifetime_tokens`, `daily_usage_buckets`, etc.) | `reverse-engineered` — private, undocumented backend API; only "official" in the sense that the CLI source calls it (`codex-rs/backend-client/src/client.rs`) | Bearer `access_token` + account id from `auth.json` — Burn would handle raw OAuth tokens | Zero | Medium-high: credential handling; token refresh burden; ToS gray zone for third-party callers |
| TUI `/status` command (renders cached + refreshed rate-limit snapshot; `codex-rs/tui/src/status/`) | Yes (human-readable) | Partial (context usage) | `official_cli` UX, but not machine-readable; scraping a TUI is fragile | ChatGPT login | Zero | Low |
| `~/.codex/state_5.sqlite` `threads.tokens_used` (+ `thread_history_1.sqlite`) | No | Coarse: one integer total per thread | `local_log` (schema `state_5` — the numeric suffix itself signals churn; sqlx migrations) | None | Zero | Medium: same tables hold `title`, `preview`, `first_user_message` — select only `id`, `tokens_used`, timestamps |
| `~/.codex/auth.json`, `version.json`, `history.jsonl` | No | No | `local_log` | None | Zero | `auth.json` = secrets (read field names/`auth_mode`/id-token *claims about plan* only, never token values). `history.jsonl` is `{session_id, ts, text}` — raw prompt text, no tokens: **do not ingest**. |
| OpenAI platform org usage API `GET https://api.openai.com/v1/organization/usage/*` | N/A (different meter: dollar/token billing, not subscription windows) | Yes, for **API-key** usage only | `official_api` | Org **admin** API key | Zero | Low — but it is a *separate surface*: it reports OpenAI Platform organization usage, not ChatGPT/Codex subscription quota. Only relevant when codex runs in `OPENAI_API_KEY` auth mode. |

Notes on the mechanism: the model backend returns quota state as response headers on codex's own streaming requests (`x-codex-primary-used-percent`, `{prefix}-primary-window-minutes`, `x-codex-rate-limit-reached-type`, etc. — parsed in [`codex-rs/codex-api/src/rate_limits.rs`](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/rate_limits.rs)), and the core copies the latest snapshot into every `token_count` event, which the rollout recorder persists. The standalone (no-generation) fetch path is [`codex-rs/backend-client/src/client.rs`](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client.rs) `get_rate_limits()` → `GET .../accounts/check`, exposed via app-server `account/rateLimits/read` ([`codex-rs/app-server-protocol/src/protocol/common.rs`](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/common.rs), method string `"account/rateLimits/read"`) and used by the TUI startup prefetch ([`codex-rs/tui/src/app/background_requests.rs`](https://github.com/openai/codex/blob/main/codex-rs/tui/src/app/background_requests.rs) `refresh_rate_limits`). **Reading quota never consumes quota** on any of these paths.

## Recommended v0 adapter strategy

1. **Consumption + passive quota: rollout JSONL tailer** (primary). Watch `~/.codex/sessions/` recursively; for each line, parse JSON and keep only `type=="session_meta"` (session id, `cli_version`, `cwd`, git metadata for attribution) and `payload.type=="token_count"`. Emit `consumption` from `info.last_token_usage` (per-turn delta) or diffs of `info.total_token_usage`, and `quota_snapshot` from `rate_limits`. Discard everything else unparsed.
   - Confidence/stability per field: `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`, `total_tokens` — **high confidence, local_log stability** (values originate from API usage objects; field names verified on 0.150.1). `rate_limits.primary/secondary.{used_percent, window_minutes, resets_at}` — **high confidence while a session is active, local_log stability**; snapshot goes stale when codex is idle. `plan_type`, `credits`, `limit_id` — present on 0.150.1, **medium stability** (enum grows; observed `prolite`).
2. **Live quota: app-server RPC poller** (secondary, optional in v0). Spawn `codex app-server` (stdio JSONL transport), initialize, then call `account/rateLimits/read` on Burn's poll interval and/or subscribe to `account/rateLimits/updated`. Merge sparse updates per the README rules (null never clears a previously observed value). Optionally `account/usage/read` for daily token buckets that survive session-file pruning.
   - Stability: **experimental_rpc**. Pin per version: record `codex --version` in `adapter_status`, regenerate/vendor the schema with `codex app-server generate-json-schema`, and fail soft on unknown fields.
3. **Do not** call `chatgpt.com/backend-api/wham/*` directly in v0 (reverse-engineered; requires lifting `auth.json` tokens). Keep it documented as a fallback if app-server churns.
4. **adapter_status**: `codex --version` (parse `codex-cli X.Y.Z`), `~/.codex/version.json` (`latest_version`, `last_checked_at`), `auth.json` → `auth_mode` (`chatgpt` vs `apikey` — quota windows only exist for `chatgpt`), and id-token claim `https://api.openai.com/auth.chatgpt_plan_type` if plan detection without a session is wanted (claim names verified locally; never log token values).

## Sample REDACTED payloads (structure only, fake values)

### Source: rollout `token_count` event (verbatim shape from 0.150.1, values faked)

```json
{"timestamp":"2026-08-28T00:00:00.000Z","type":"event_msg","payload":{
  "type": "token_count",
  "info": {
    "total_token_usage": {
      "input_tokens": 1000000, "cached_input_tokens": 900000,
      "cache_write_input_tokens": 0, "output_tokens": 50000,
      "reasoning_output_tokens": 18000, "total_tokens": 1050000
    },
    "last_token_usage": {
      "input_tokens": 12000, "cached_input_tokens": 11000,
      "cache_write_input_tokens": 0, "output_tokens": 500,
      "reasoning_output_tokens": 300, "total_tokens": 12500
    },
    "model_context_window": 258400
  },
  "rate_limits": {
    "limit_id": "codex", "limit_name": null,
    "primary":   { "used_percent": 28.0, "window_minutes": 300,   "resets_at": 1788272597 },
    "secondary": { "used_percent": 11.0, "window_minutes": 10080, "resets_at": 1788700000 },
    "credits": { "has_credits": false, "unlimited": false, "balance": "0" },
    "individual_limit": null, "spend_control_reached": null,
    "plan_type": "prolite", "rate_limit_reached_type": null
  }
}}
```

(On the observed `prolite` account, `primary` is the weekly window — `window_minutes: 10080` — and `secondary` is `null`; window layout varies by plan.)

### Source: app-server `account/rateLimits/read` (camelCase; from README example)

```json
{ "id": 7, "result": {
  "rateLimits": {
    "primary":   { "usedPercent": 25, "windowDurationMins": 300,   "resetsAt": 1730947200 },
    "secondary": { "usedPercent": 5,  "windowDurationMins": 10080, "resetsAt": 1731500000 },
    "planType": "plus", "limitId": "codex"
  },
  "rateLimitsByLimitId": { "codex": { "...": "same shape" } },
  "rateLimitResetCredits": { "availableCount": 0, "credits": null }
}}
```

### Burn observation mappings

```json
{ "type": "quota_snapshot", "provider": "codex", "observed_at": "2026-08-28T12:00:00Z",
  "source": "rollout_jsonl | app_server_rpc",
  "plan_type": "prolite",
  "windows": [
    { "id": "primary",   "used_percent": 28.0, "window_minutes": 300,
      "resets_at": "2026-08-30T18:23:17Z" },
    { "id": "secondary", "used_percent": 11.0, "window_minutes": 10080,
      "resets_at": "2026-09-04T00:00:00Z" }
  ],
  "limit_reached": null, "credits": { "has_credits": false, "balance": "0" } }
```

```json
{ "type": "consumption", "provider": "codex", "observed_at": "2026-08-28T12:00:00Z",
  "session_id": "01a0....-....", "turn_scope": "turn_delta",
  "tokens": { "input": 12000, "cached_input": 11000, "cache_write_input": 0,
              "output": 500, "reasoning_output": 300, "total": 12500 },
  "model_context_window": 258400 }
```

```json
{ "type": "adapter_status", "provider": "codex", "observed_at": "2026-08-28T12:00:00Z",
  "cli_version": "0.150.1", "auth_mode": "chatgpt",
  "surfaces": { "rollout_jsonl": "ok", "app_server_rpc": "ok|unavailable|schema_mismatch" },
  "notes": [] }
```

## Window semantics: known vs unknown

**Known (documented):**
- `usedPercent` = current usage within the OpenAI quota window; `windowDurationMins` = window length; `resetsAt` = Unix seconds of next reset ([app-server README field notes](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)).
- OpenAI describes the metering as a rolling ~5-hour window plus, on some plans, an additional weekly limit; both local CLI and cloud tasks draw from one shared pool; since April 2026 metering is by tokens, not messages ([Codex pricing](https://chatgpt.com/codex/pricing/), [Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)).
- `account/rateLimits/updated` is a *sparse* rolling update: merge non-null values onto the last full read; `null` metadata must not clear observed values (README).
- Earned rate-limit reset credits (`account/rateLimitResetCredit/consume`) can reset windows out-of-band — `resets_at` can jump; always refetch after a consume (README). Plans can also buy credits, which changes `credits`/`rate_limit_reached_type` behavior.
- Multi-bucket future-proofing exists: `rateLimitsByLimitId` keyed by metered `limit_id` (e.g. `"codex"`); the top-level `rateLimits` is the backward-compatible single-bucket view (schema: [`GetAccountRateLimitsResponse.json`](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/json/v2/GetAccountRateLimitsResponse.json)).
- Which window is "primary" is **plan-dependent**, verified locally: on `prolite`, primary = 10080 min (weekly) with `secondary: null`; community/docs descriptions of "primary = 5h, secondary = weekly" hold for Plus/Pro but must not be hard-coded. Burn should key off `window_minutes`, not position.

**Unknown (do not invent):**
- Whether `resets_at` for a "rolling" window means the window truly slides continuously or the backend materializes discrete reset points; the exact server-side accounting granularity is not documented. Treat `used_percent` + `resets_at` as opaque backend truth.
- The exact token-to-percent conversion (limits vary by plan and model and are adjusted over time; OpenAI does not publish the divisor).
- Precise reset behavior at plan changes, credit purchase, or the documented promo removals/restorations of the 5h window.

## Version detection and failure modes

- Detect: `codex --version` → `codex-cli 0.150.1`; per-file `session_meta.payload.cli_version`; `~/.codex/version.json`.
- Known drift: older CLI releases reported relative `resets_in_seconds`; current protocol uses absolute `resets_at` (the only remaining `resets_in_seconds` hit in the repo is a websocket test fixture, `codex-rs/core/tests/suite/client_websockets.rs`). The rollout format has an in-repo migration parser (`codex-rs/thread-store/src/local/rollout_migration/line_parser.rs`) — expect line-shape changes between versions; parse defensively, skip unknown lines, and record `schema_mismatch` in `adapter_status` rather than failing.
- Failure modes to handle: `auth_mode: "apikey"` (no subscription windows; org usage API is the only meter, and it needs an admin key Burn likely won't have); logged-out state (`auth.json` absent); `secondary: null` / `resets_at: null` (schema allows null); app-server `[experimental]` flag or method rename; sqlite files WAL-locked (open read-only with `mode=ro`); sessions pruned/archived (account-level backfill via `account/usage/read` daily buckets covers gaps).

## Follow-up prototype work

- Build the rollout tailer: inotify on `~/.codex/sessions/`, line-filtered projection, dedupe by (session_id, cumulative totals), turn-delta derivation from `last_token_usage` vs. total diffs across `context_compacted` events.
- Prototype the app-server stdio client: spawn, `initialize` handshake, `account/rateLimits/read`, subscribe `account/rateLimits/updated`; measure process cost of keeping it resident vs. spawn-per-poll; confirm it does not interfere with a concurrently running interactive codex (shared daemon via `app-server-control.sock` exists — investigate attaching to the running daemon instead of spawning).
- Vendor/regen protocol schema per supported codex version (`codex app-server generate-json-schema --out DIR`) and add a CI check against new releases.
- Decide plan-aware window labeling: map `window_minutes` 300 → "5h", 10080 → "weekly", else pass through raw.
- Verify `account/usage/read` daily-bucket semantics (timezone, whether buckets are subscription-scoped) on a live call before relying on it for backfill.
- Confirm behavior in `OPENAI_API_KEY` mode and design the explicit "no quota surface" adapter_status for it; document the org usage API as a separate, opt-in surface requiring an admin key.
- Privacy review: enforce an allowlist projection at the parser boundary (no raw line ever leaves the adapter) and never open `history.jsonl` or select content columns from the sqlite stores.

## Primary sources

- Local: `~/.codex/sessions/2026/08/28/rollout-*.jsonl`, `~/.codex/auth.json` (field names only), `~/.codex/config.toml`, `~/.codex/version.json`, `~/.codex/state_5.sqlite`, `~/.codex/history.jsonl`, `codex --version`, `codex app-server --help`.
- https://github.com/openai/codex — specifically:
  - `codex-rs/backend-client/src/client.rs` (`get_rate_limits` → `GET {base}/api/codex/accounts/check` | `{base}/wham/accounts/check`; `get_token_usage_profile` → `/api/codex/profiles/me` | `/wham/profiles/me`)
  - `codex-rs/app-server/README.md` (methods, transports, field notes, experimental opt-in)
  - `codex-rs/app-server-protocol/src/protocol/common.rs` (`account/rateLimits/read`, `account/usage/read`, `account/rateLimits/updated`, `thread/tokenUsage/updated`)
  - `codex-rs/app-server-protocol/schema/json/v2/GetAccountRateLimitsResponse.json` (RateLimitWindow/RateLimitSnapshot/PlanType schema)
  - `codex-rs/codex-api/src/rate_limits.rs` (header family `x-codex-*` parsing)
  - `codex-rs/tui/src/app/background_requests.rs` (startup prefetch), `codex-rs/tui/src/status/` (`/status`)
  - `codex-rs/backend-client/src/types.rs` (`TokenUsageProfile` daily buckets)
- https://chatgpt.com/codex/pricing/ and https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan (window semantics, shared pool, token metering)
- Platform (separate surface): https://platform.openai.com/docs/api-reference/usage (`/v1/organization/usage`, admin key required)
