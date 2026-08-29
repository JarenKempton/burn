# Issue 3: Claude Code subscription quota and token collection surfaces

- Issue: JarenKempton/burn#3
- Date: 2026-08-28
- Investigated against: live local install Claude Code v2.1.251 (`claude --version`), Linux, subscription (claude.ai OAuth) auth; official docs at code.claude.com/docs (docs.anthropic.com/en/docs/claude-code/* now 301-redirects there); ccusage docs; anthropics/claude-code GitHub issues.

**Recommendation.** Burn v0 should collect from two surfaces: (1) an **official statusline hook** registered in `~/.claude/settings.json`, whose stdin JSON includes a documented `rate_limits` object with `five_hour` and `seven_day` `used_percentage` + `resets_at` — this is the only *officially supported* subscription-quota surface and requires no credential handling at all; and (2) **read-only parsing of `~/.claude/projects/**/*.jsonl`** transcripts for per-message token consumption (input / cache-write / cache-read / output / thinking tokens, model, timestamps), which is unofficial but practically stable (the entire ccusage ecosystem depends on it) provided Burn deduplicates by `requestId`/`message.id` with last-entry-wins. Do **not** call the undocumented `api.anthropic.com/api/oauth/usage` endpoint in v0: it requires reusing the OAuth token from `~/.claude/.credentials.json` with a spoofed `User-Agent: claude-code/<version>` header, is aggressively rate-limited, and is reverse-engineered rather than sanctioned — keep it as an explicitly opt-in, clearly-labeled experimental adapter at most. OpenTelemetry export (`CLAUDE_CODE_ENABLE_TELEMETRY=1`) is the officially supported path for token/cost metrics but carries no quota data and requires an OTLP receiver, so it is a good v1 upgrade, not a v0 requirement.

## Capability matrix

| Surface | Quota windows (5h/weekly) | Token counts | Cost | Stability class | Auth needed | Privacy risk |
|---|---|---|---|---|---|---|
| Statusline stdin JSON (`rate_limits`, `cost`, `context_window`) — [docs](https://code.claude.com/docs/en/statusline) | Yes: `five_hour`/`seven_day` `used_percentage` + `resets_at` (Pro/Max only, after first API response in a session) | Session-scoped only (`context_window.current_usage`) | Session `total_cost_usd` (list-price estimate) | official_cli | None (Claude Code pushes JSON to a script we register) | Low — includes cwd, git branch, session id; no prompt text |
| `~/.claude/projects/**/*.jsonl` transcripts | No | Yes: per-message `usage` with all 4 token categories + `thinking_tokens` | No (must be computed from pricing tables) | local_log (undocumented schema; de-facto stable, versioned per line) | None (filesystem read) | **High** — files contain full prompts/completions; Burn must read only `usage`/metadata fields and never persist content |
| OpenTelemetry metrics (`CLAUDE_CODE_ENABLE_TELEMETRY=1`) — [docs](https://code.claude.com/docs/en/monitoring-usage) | No (explicitly absent; closest signal is `claude_code.api_error` status_code=429) | Yes: `claude_code.token.usage` with `type` = input/output/cacheRead/cacheCreation, per model | Yes: `claude_code.cost.usage` (USD, estimate) | official_api (documented, supported) | None beyond env vars, but needs an OTLP/Prometheus receiver | Low-medium — prompt/response content gated off by default; `user.email`, `user.account_uuid` in attributes |
| `/usage`, `/cost` in-app commands — [docs](https://code.claude.com/docs/en/costs) | Yes (plan usage bars) but interactive TUI only — not scriptable output | Yes (session block) | Yes (estimate) | official_cli (human-facing; no machine-readable output) | Existing login | Low |
| `api.anthropic.com/api/oauth/usage` (undocumented; powers `/usage`) | Yes: `five_hour`, `seven_day`, `seven_day_opus`/`seven_day_sonnet`, `extra_usage` — `utilization` + `resets_at` | No | No | estimated/reverse-engineered (no contract; per-token 429 lockouts; requires spoofed `User-Agent: claude-code/<v>`) — see [claude-code#31637](https://github.com/anthropics/claude-code/issues/31637), [#45392](https://github.com/anthropics/claude-code/issues/45392) | OAuth access token from `~/.claude/.credentials.json` | Medium — handles a live bearer credential; ToS gray area |
| Anthropic Admin API `/v1/organizations/usage_report` + Claude Code Analytics API | No (API rate limits, not subscription windows) | Yes (org-wide API usage) | Yes | official_api | Admin API key (`sk-ant-admin…`) — org owners only | Low |
| ccusage-style local reconstruction of 5h "blocks" — [docs](https://ccusage.com/guide/blocks-reports) | Estimated only: block = 5h from first activity; limits are user-supplied or "max of past blocks", never authoritative | Yes (from JSONL) | Yes (LiteLLM pricing, estimate) | estimated | None | High (same JSONL exposure) |
| `~/.claude/history.jsonl`, `~/.claude.json` | No (`.claude.json` has account/plan metadata: `oauthAccount.organizationRateLimitTier`, `subscriptionType`; no live window state) | No | No | local_log | None | Medium — history.jsonl contains raw prompt text (`display`, `pastedContents`); avoid |

Notes on separation: the Admin API usage report is an **API-organization billing** surface and says nothing about Pro/Max subscription windows. The Enterprise Analytics API and Teams spend-report CSV are likewise org-plan surfaces ([costs docs](https://code.claude.com/docs/en/costs)). Subscription quota state lives only behind the OAuth usage endpoint and the statusline/`/usage` UI fed by it.

## What the live install shows (Linux, v2.1.251)

Layout of `~/.claude/` (i.e. `/home/jaren/.claude/`, observed 2026-08-28):

- `projects/<escaped-cwd>/<session-uuid>.jsonl` — transcripts, one JSON object per line. Per-session sibling directory `<session-uuid>/` holds `tool-results/`, `memory`, etc.
- `.credentials.json` (mode `0600`) — `claudeAiOauth: { accessToken, refreshToken, expiresAt, refreshTokenExpiresAt, scopes[], subscriptionType, rateLimitTier }` plus `mcpOAuth` entries. On macOS this lives in the Keychain instead; on Linux it is this plaintext file.
- `history.jsonl` — prompt history: `display`, `pastedContents`, `project`, `sessionId`, `timestamp`. Contains raw prompt text; no token data.
- `~/.claude.json` (home dir, not inside `.claude/`) — installer/state: `oauthAccount` (accountUuid, organizationUuid, billingType, organizationRateLimitTier, hasExtraUsageEnabled), caches (`modelAccessCache`, `cachedExtraUsageDisabledReason`), `machineID`, `numStartups`. Useful for **adapter_status** (plan tier detection) but holds no live window percentages.
- No `statsig/` directory and no `usage-data/` in this install (statsig files existed in older versions; `usage-data/` is created by `/insights`). Do not depend on either.
- `settings.json` — where Burn would register a `statusLine` command (and optionally `refreshInterval`).

Transcript line structure (assistant lines; field names verified with jq, values redacted):

- Top-level: `type` (`assistant`|`user`|`queue-operation`|`attachment`|`ai-title`|`last-prompt`|`atis-latch`…), `uuid`, `parentUuid`, `sessionId`, `timestamp` (ISO 8601 UTC), `cwd`, `gitBranch`, `version` (Claude Code version, per line), `requestId`, `isSidechain` (subagent traffic), `entrypoint`, `userType`, `effort`.
- `message.model` (e.g. `claude-fable-5`), `message.id`, `message.usage`:
  - `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`
  - `output_tokens_details.thinking_tokens` (present on current versions)
  - `cache_creation.ephemeral_1h_input_tokens` / `.ephemeral_5m_input_tokens`
  - `service_tier`, `speed`, `inference_geo`, `server_tool_use.web_search_requests`/`.web_fetch_requests`, `iterations[]`
- Only `type == "assistant"` lines carry `usage`. `user` lines carry tool results/metadata, no tokens.

**Dedup requirement (load-bearing):** Claude Code writes multiple JSONL entries per API response while streaming — same `requestId`, incrementally growing `output_tokens` (observed locally: identical usage repeated across consecutive lines). Summing naively overcounts ~2x; taking the first entry undercounts. Community consensus is last-entry-wins (or max-usage) per `requestId` (fallback `message.id`), per [ccusage#888](https://github.com/ryoppippi/ccusage/issues/888), [ccusage#835](https://github.com/ryoppippi/ccusage/issues/835), [claude-devtools#74](https://github.com/matt1398/claude-devtools/issues/74), [claude-code#5034](https://github.com/anthropics/claude-code/issues/5034).

## Recommended v0 adapter strategy (smallest reliable mode)

Two collectors, both zero-credential:

1. **Quota via statusline shim (official_cli).** Install a tiny script as the `statusLine` command (or wrap the user's existing one so we don't destroy their statusline) that tees the stdin JSON's non-content fields to Burn's local ingestion socket/spool, then renders as before. Claude Code invokes it on every conversation event and optionally every `refreshInterval` seconds. Documented contract ([statusline docs](https://code.claude.com/docs/en/statusline)): `rate_limits.five_hour.{used_percentage,resets_at}`, `rate_limits.seven_day.{...}`, `rate_limits.spend_limit.{...}` (gateway spend limits, v2.1.251+). Caveats from the docs, which Burn must honor: `rate_limits` appears **only for claude.ai Pro/Max subscribers** (and Teams/Enterprise seats), only **after the first API response in a session**, each window may be independently absent, and Claude Code **drops a window once its `resets_at` passes**. This surface delivers no data while Claude Code is not running — Burn should model quota as snapshots with staleness, not a continuous series.
2. **Consumption via JSONL tail (local_log).** Watch `~/.claude/projects/**/*.jsonl` (inotify + periodic rescan), parse only assistant lines, extract `usage` + `model` + `timestamp` + `sessionId` + `requestId` + `isSidechain` + `version`, dedupe last-entry-wins per (`sessionId`,`requestId`). Never read or store `message.content`. This is the same surface ccusage/claude-monitor use, and it works retroactively (backfill from existing files).
3. **adapter_status** from cheap official probes: `claude --version` (exits 0, prints `2.1.251 (Claude Code)`); existence/mtime of `~/.claude/projects`; plan metadata from `~/.claude.json` `oauthAccount` (read-only, no token fields touched).

Per-field confidence/stability classification:

| Burn field | Source | Stability | Confidence |
|---|---|---|---|
| `quota_snapshot.five_hour.used_pct`, `.resets_at` | statusline `rate_limits.five_hour` | official_cli, documented | High (authoritative server-side value; same feed as `/usage`) |
| `quota_snapshot.weekly.used_pct`, `.resets_at` | statusline `rate_limits.seven_day` | official_cli, documented | High; note it is a 7-day window, docs call it `seven_day` |
| `quota_snapshot` model-family splits (Opus/Sonnet weekly) | only via undocumented OAuth endpoint (`seven_day_opus`, `seven_day_sonnet`) | reverse-engineered | Low — v0 should omit |
| `consumption.input_tokens` / `.cache_creation_tokens` / `.cache_read_tokens` / `.output_tokens` | JSONL `message.usage` | local_log; values are verbatim API usage objects, so the *inner* shape tracks the public Messages API `usage` schema | High for values, Medium for file/envelope schema across versions |
| `consumption.thinking_tokens` | JSONL `output_tokens_details.thinking_tokens` | local_log, newer field — treat as optional | Medium |
| `consumption.model`, `.timestamp`, `.session_id` | JSONL top level | local_log | High |
| `consumption.cost_usd` | computed (pricing table) | estimated — always label as estimate; subscription usage has no billing meaning ([costs docs](https://code.claude.com/docs/en/costs): "session cost figure isn't relevant for billing" for subscribers) | Low-Medium |
| `adapter_status.cc_version` | `claude --version` | official_cli | High |
| `adapter_status.plan` | `~/.claude.json` `oauthAccount` / `.credentials.json` `subscriptionType` | local_log | Medium |

## Sample REDACTED payloads → Burn observation types

`quota_snapshot` (from statusline stdin; fake values):

```json
{
  "observation": "quota_snapshot",
  "source": "claude_code.statusline",
  "captured_at": "2026-08-28T21:00:00Z",
  "windows": {
    "five_hour": { "used_percentage": 23.5, "resets_at": 1738425600 },
    "seven_day": { "used_percentage": 41.2, "resets_at": 1738857600 }
  },
  "session_id": "REDACTED-UUID",
  "cc_version": "2.1.251"
}
```

`consumption` (from one deduped JSONL assistant line; fake values):

```json
{
  "observation": "consumption",
  "source": "claude_code.jsonl",
  "timestamp": "2026-08-28T21:00:05.000Z",
  "session_id": "REDACTED-UUID",
  "request_id": "REDACTED",
  "model": "claude-fable-5",
  "is_sidechain": false,
  "tokens": {
    "input": 2,
    "cache_creation_input": 8525,
    "cache_read_input": 82750,
    "output": 390,
    "thinking": 77
  },
  "cache_ttl_split": { "ephemeral_1h": 8525, "ephemeral_5m": 0 },
  "cc_version": "2.1.251",
  "cost_usd_estimate": null
}
```

`adapter_status`:

```json
{
  "observation": "adapter_status",
  "adapter": "claude_code",
  "cc_version": "2.1.251",
  "auth_kind": "subscription_oauth",
  "plan_hint": "REDACTED (from ~/.claude.json oauthAccount)",
  "surfaces": { "statusline": "ok", "jsonl": "ok", "oauth_usage_endpoint": "disabled" },
  "last_jsonl_event_at": "2026-08-28T21:00:05Z"
}
```

## Five-hour / weekly window semantics

**Known (official):**
- Pro/Max/Team/Enterprise seat allowances reset on "a rolling five-hour window and a weekly window", shared across Claude chat, Claude Code, and Cowork ([costs docs](https://code.claude.com/docs/en/costs#claude-for-teams-and-enterprise)). Limit messages in-product: "You've hit your session limit" (5h) / "You've hit your weekly limit", plus model-family messages ("You've hit your Opus limit") implying per-family weekly sub-limits.
- Statusline exposes `used_percentage` (0-100) and `resets_at` (Unix epoch seconds) per window; a window object disappears after its `resets_at` passes and reappears with new usage ([statusline docs](https://code.claude.com/docs/en/statusline)).
- `/usage` fetches these bars from a server endpoint; the docs acknowledge that endpoint gets rate-limited and that Claude Code then falls back to a ≤60-minute-old cached snapshot ("Showing last-known usage") — so even first-party data can be stale.
- Community observation (consistent, but not an official contract): the 5-hour window starts at the first message after the previous window expires; ccusage models blocks as "first activity starts a block; lasts exactly 5 hours; new block on next activity after expiry" ([ccusage blocks](https://ccusage.com/guide/blocks-reports)).

**Unknown — do not invent:**
- The unit being metered (tokens? weighted tokens? dollars-equivalent? messages?) and how cache-read vs cache-write vs output tokens are weighted against the allowance: **unknown/unpublished**.
- Model weighting (how much faster Opus/Fable consume the window than Sonnet/Haiku): **unknown**; only the existence of separate Opus/Sonnet weekly buckets is evidenced (limit messages; `seven_day_opus`/`seven_day_sonnet` in the undocumented endpoint response).
- Absolute allowance sizes per plan tier, and whether Anthropic adjusts them dynamically: **unknown** (docs and support articles give no numbers; community tools explicitly guess).
- Rounding/anchor of window start (whether the 5h anchor floors to the hour): **unknown**; ccusage's example table shows non-hour-aligned starts, and Burn should treat `resets_at` from the statusline as the only authoritative anchor.
- Whether weekly is a rolling 7-day window vs fixed anchor from first use: `resets_at` observations are the only ground truth; **semantics unpublished**.

Consequence: Burn should store quota as *percent-of-window + reset time* verbatim, and never attempt to derive absolute token allowances from it.

## Credential reuse and safety

- Linux stores the live OAuth bearer + refresh token in plaintext `~/.claude/.credentials.json` (0600); macOS uses the Keychain. Reading local transcripts/settings does not touch credentials and is unambiguously safe.
- The `/api/oauth/usage` endpoint is undocumented, was discovered by decompiling `cli.js`, requires the `anthropic-beta: oauth-2025-04-20` header and a spoofed `User-Agent: claude-code/<version>` to avoid a punitive per-token 429 bucket ([claude-code#31021](https://github.com/anthropics/claude-code/issues/31021), [#31637](https://github.com/anthropics/claude-code/issues/31637)). Impersonating the first-party client with a user's consumer OAuth token is exactly the pattern Anthropic's consumer ToS "no unauthorized access methods" language covers; there is an open feature request for an official API ([claude-code#45392](https://github.com/anthropics/claude-code/issues/45392)). Risk profile: token lockout (429s persist for hours per token) at minimum, account action at worst. If Burn ever ships this adapter it must be off by default, labeled experimental/unsupported, read the token without ever writing the file, and back off hard on 429.
- The statusline path gets the *same numbers* pushed to us by the first-party client, so it captures the value of the endpoint without touching the credential.

## Version detection and failure modes

- `claude --version` → `2.1.251 (Claude Code)`; every JSONL line also embeds `version`, so Burn can tag observations per-line and detect schema-era boundaries retroactively.
- **JSONL is not a stable contract.** Evidence of churn within recent versions alone: `output_tokens_details`, `cache_creation` TTL split, `iterations[]`, `stop_details` are all newer additions; event `type` vocabulary includes undocumented values (`atis-latch`, `queue-operation`, `ai-title`); docs history on the costs page shows behavior changes gated by minor versions (e.g. `/clear` reset semantics changed in v2.1.211). Parser must: ignore unknown `type`s, treat all usage subfields as optional, and never fail a whole file on one bad line.
- Statusline contract failure modes: `rate_limits` absent on API-key auth, absent before first response, windows independently absent/dropped after reset; script must emit `quota_snapshot` only when fields exist. If the user already has a statusline, Burn must chain, not replace. If Claude Code isn't running, no quota data flows (staleness must be first-class in Burn's model).
- OTel alternative failure mode: silently no data unless `CLAUDE_CODE_ENABLE_TELEMETRY=1` and exporter env vars are set in the user's environment/settings before session start.
- Directory-shape drift: project-dir escaping (`/var/home/jaren/Development/burn` → `-var-home-jaren-Development-burn`) is convention, not contract; per-session subdirectories (tool-results, memory) sit beside the `.jsonl` and must be ignored by the globber. `statsig/` no longer exists in current installs.

## Follow-up prototype work

- Build the JSONL tailer with (`sessionId`,`requestId`) last-entry-wins dedup; validate totals against `/usage`'s Session block on a fresh session (manual comparison, no generative calls needed beyond normal use).
- Build the statusline tee shim; verify `rate_limits` capture cadence, behavior with `refreshInterval`, and chaining with a pre-existing user statusline command.
- Empirically log `resets_at` transitions over a week to characterize 5h anchor behavior and weekly reset semantics (fills the "unknown" boxes with observed data, clearly labeled as observed-not-documented).
- Decide Burn's staleness model for `quota_snapshot` (last-known-at timestamps, mirroring Claude Code's own 60-minute fallback behavior).
- Prototype pricing-table cost estimation (LiteLLM-style, offline-cached) and label all cost fields as estimates; skip entirely for subscription-auth users by default since cost has no billing meaning there.
- Evaluate OTel adapter for v1: local OTLP receiver embedded in Burn, `claude_code.token.usage`/`claude_code.cost.usage` ingestion, and cardinality env recommendations.
- Track anthropics/claude-code#45392 for an official usage API; revisit the OAuth-endpoint decision if one ships.
- Test macOS: confirm Keychain (no `.credentials.json`) does not affect the two v0 surfaces (it shouldn't — neither touches credentials).
