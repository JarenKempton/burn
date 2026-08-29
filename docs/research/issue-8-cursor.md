# Issue #8 — Cursor usage collection surfaces

- Issue: JarenKempton/burn#8
- Date: 2026-08-29
- Method: live inspection of the local Cursor CLI installation on this machine (`~/.cursor/`, `~/.config/cursor/`, `~/.local/share/cursor-agent/versions/2026.08.25-3e8eec8/`), read-only probes of Cursor's own RPC endpoints using the CLI's already-stored credential, and live fetches of cursor.com docs (URLs inline). No prompt/completion content was read into findings; all payload samples below use fake or redacted values.

**Recommendation.** There IS a reliable per-request surface for individual accounts, but it is not an official API: Cursor's own clients (CLI and cursor.com dashboard) fetch usage through the internal ConnectRPC service `aiserver.v1.DashboardService` at `https://api2.cursor.sh`, authenticated by the OAuth access token the Cursor CLI already stores at `~/.config/cursor/auth.json` (no team admin key, no browser cookie). Verified live on this machine: `GetFilteredUsageEvents` returns per-request `{timestamp, model, tokenUsage{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalCents}, chargedCents, kind, conversationId}`, `GetAggregatedUsageEvents` returns per-model rollups, and `GetCurrentPeriodUsage` returns billing-cycle window + percent-used — a direct `quota_snapshot`. Burn's v0 Cursor adapter should poll these three RPCs, classified `experimental_rpc`, with the explicit caveat that cost cents are **zeroed by Cursor for self-serve (Pro/Pro+/Ultra/Teams) plans since 2026-07-31** (tokens remain) — so `cost_micros` must be nullable with an `estimated` fallback computed from tokens × published API prices. The official Admin API (`api.cursor.com`) is real and well-documented but requires a team API key and is positioned Enterprise-only in current docs — useless for individual accounts. Local files under `~/.cursor/` contain **no token counts at all** (only model name + request/conversation IDs), so a local-log-only adapter cannot meet the issue's bar.

---

## 1. Capability matrix

| Surface | Yields | Stability class | Auth | Individual accounts? | Privacy risk |
|---|---|---|---|---|---|
| **`POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetFilteredUsageEvents`** (ConnectRPC, JSON accepted) | Per-request events: `timestamp`, `model`, `kind` (enum incl. `INCLUDED_IN_PRO/PRO_PLUS/ULTRA/BUSINESS`, `USAGE_BASED`, `ERRORED_NOT_CHARGED`, `ABORTED_NOT_CHARGED`), `tokenUsage{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalCents}`, `chargedCents`, `cursorTokenFee`, `isTokenBasedCall`, `maxMode`, `conversationId`, `owningUser`, `userEmail`, `subscriptionProductId`; paginated (`page`, `pageSize`), `totalUsageEventsCount` | `experimental_rpc` — internal, unversioned-in-practice proto (`aiserver.v1`), no compatibility promise | Bearer = `accessToken` from `~/.config/cursor/auth.json` (CLI OAuth token; JWT, scope `openid profile email offline_access`, ~60-day expiry, refreshed by the CLI) | **Yes** — `team_id` is optional in the request proto; verified live with no `team_id`; event-kind enum has individual-plan values. Cost cents zeroed for self-serve plans since 2026-07-31 (tokens intact) | Low-medium: returns account email + user/team IDs (metadata, never content). Burn must drop/hash `userEmail`/`owningUser` at ingest |
| **`.../DashboardService/GetAggregatedUsageEvents`** | Per-model rollup for a date range: `aggregations[]{modelIntent, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, totalCents, tier}` + `totalInputTokens/OutputTokens/CacheWriteTokens/CacheReadTokens/totalCostCents`, `percentOfBurstUsed` | `experimental_rpc` | same | **Yes** (same optionality); same self-serve cents caveat | Low: aggregate only |
| **`.../DashboardService/GetCurrentPeriodUsage`** | Quota: `billingCycleStart/End` (epoch ms), `planUsage{totalSpend, includedSpend, remaining, limit, autoPercentUsed, apiPercentUsed, totalPercentUsed}` (cents), `spendLimitUsage{totalSpend, pooledLimit, pooledUsed, pooledRemaining, limitType}`, `autoBucketModels[]`, display messages | `experimental_rpc` | same | **Yes** — user-scoped; verified live | Low |
| **Admin API `https://api.cursor.com`** — `POST /teams/filtered-usage-events`, `/teams/daily-usage-data`, `/teams/spend`, `GET /teams/members` ([docs](https://cursor.com/docs/account/teams/admin-api)) | Same per-event shape as the RPC (per-user, per-model, `tokenUsage`, `chargedCents`), per-user daily rollups (request counts, lines, `mostUsedModel`), per-member `spendCents`; documented rate limits (usage events 60 req/min, pageSize ≤ 1000) | `official_api` | Basic auth with team API key (`crsr_...`), created by team admins in dashboard | **No.** Team-scoped by design; the [APIs overview](https://cursor.com/docs/api) lists Admin/Analytics/AI-Code-Tracking APIs as Enterprise-team-only (403 "Enterprise access required"). No officially documented individual-account usage API exists | Low (official, documented) |
| **`https://cursor.com/api/dashboard/get-filtered-usage-events`** (+ `get-usage`, `get-monthly-invoice`, `get-aggregated-usage-events`) — the web dashboard's own JSON endpoints | Same data as the RPCs (they are HTTP front-ends over the same DashboardService) | reverse-engineered (`experimental_rpc` at best, session-cookie variant is worse) | `WorkosCursorSessionToken` browser session cookie, or the IDE's JWT extracted from `state.vscdb` — used by community tools ([alextra-lab/cursor_usage](https://github.com/alextra-lab/cursor_usage), the abandoned [Dwtexe/cursor-stats](https://github.com/Dwtexe/cursor-stats)) | Yes, but requires stealing a session credential from browser/IDE storage — fragile and invasive | Medium-high: handling a full web session credential (can do account actions, not just read usage). Not recommended when the CLI token path exists |
| **Local: `~/.cursor/chats/<hash>/<uuid>/store.db`** and **`~/.cursor/acp-sessions/<uuid>/store.db`** (SQLite, `blobs` table: JSON messages + protobuf frames) | Per-message `providerOptions.cursor.modelName`, `providerOptions.cursor.requestId`, timestamps, conversation ID. **No token counts, no cost anywhere** (verified: all `token`/`cost` string hits were transcript *content*, not metadata) | `local_log` | none (filesystem) | Yes (whoever runs the CLI) | High if mishandled: blobs contain full prompt/completion content. An adapter must read only metadata keys, never content |
| **Local: `~/.cursor/ai-tracking/ai-code-tracking.db`** | AI-authored-code attribution: `ai_code_hashes(model, requestId, conversationId, timestamp, fileName)`, `scored_commits(tabLinesAdded, composerLinesAdded, ...)`, `conversation_summaries(model, mode)`. No tokens, no cost | `local_log` | none | Yes | Medium (file names, conversation summaries) |
| **`cursor-agent` CLI** (`~/.local/bin/cursor-agent`) | `status` → login state; `about` → version + subscription tier; `models` → model list. **No usage/quota subcommand** (there is an in-TUI `/usage` command backed by `GetCurrentPeriodUsage`, but it is not scriptable). `--print` mode emits no usage metadata | `official_cli` | CLI login | Yes | Low |
| **Quota/plan model** ([pricing docs](https://cursor.com/docs/account/pricing)) | Two monthly pools ("Cursor Models" vs "Other Models"), token-metered at API prices; included-usage dollar amounts not published; on-demand usage continues at API rates past the limit. Dashboard + editor show pool percent. Programmatic mirror = `GetCurrentPeriodUsage` percent fields | n/a (context) | n/a | Yes | n/a |

## 2. Recommended v0 adapter strategy

**Mode: poll `aiserver.v1.DashboardService` over ConnectRPC-JSON with the CLI's stored OAuth token.** Smallest reliable loop:

1. Read `~/.config/cursor/auth.json` (mode 0600) fresh on every poll; use `accessToken` as `Authorization: Bearer`. Never persist or log the token. If the file is missing or the JWT `exp` has passed and no refresh happened (user hasn't run the CLI in ~60 days), emit `adapter_status: authentication_required` with the remedy "run `cursor-agent login`". Do not implement the refresh flow in v0 — the CLI owns it.
2. Per poll (suggest 15 min, matching community practice):
   - `GetCurrentPeriodUsage` `{}` → one `quota_snapshot` (fixed window = billing cycle) and optionally a second snapshot for the team pooled spend limit.
   - `GetFilteredUsageEvents` `{startDate, endDate, page, pageSize}` (epoch-ms strings; walk pages until previously-seen timestamp) → one `consumption` observation per event. Natural idempotency key: `(timestamp, conversationId, model)` — there is no event ID field; persist a high-water timestamp and re-fetch a trailing overlap window defensively.
   - Optional cheap cross-check: `GetAggregatedUsageEvents` for the same range → daily per-model rollup `consumption` (or use it *instead* of per-event collection if event volume is a concern; it loses per-request granularity).
3. Cost handling: if `tokenUsage.totalCents`/`chargedCents` are present and nonzero, map to `cost_micros = round(cents * 10_000)`, `counting: "provider_reported"`. On self-serve plans these fields are deliberately zeroed by Cursor (change of 2026-07-31, [confirmed by staff](https://www.developersdigest.tech/blog/cursor-removes-dollar-costs-usage-page); enterprise plans still get real values — verified live on this Team/`enterprise-legacy` account, which returns real cents). When zeroed, either leave `cost_micros` null or compute an `estimated`-quality figure from tokens × the per-model API prices on the [pricing page](https://cursor.com/docs/account/pricing) — flag clearly as estimated.
4. Redaction at ingest: drop `userEmail`; hash `owningUser` into `account_ref`; keep `conversationId` (useful join key to local `~/.cursor/chats/` metadata later); never touch chat blob content.
5. Source quality: `experimental_rpc` for all three RPCs. `adapter_status.provider_version` = CLI version from `cursor-agent about` or the versions dir name.

Per-field confidence:

| Burn field | Source field | Confidence |
|---|---|---|
| `model` | `usageEventsDisplay[].model` / `aggregations[].modelIntent` | High (verified live) |
| `input_tokens` | `tokenUsage.inputTokens` | High |
| `cached_input_tokens` | `tokenUsage.cacheReadTokens` (cache **writes** have no Burn field today — either add one or fold into `input_tokens`; do not silently drop) | High for the value; Medium for the mapping decision |
| `output_tokens` | `tokenUsage.outputTokens` | High |
| `reasoning_output_tokens` | not exposed anywhere | n/a — always null |
| `requests` | 1 per event (or event count in rollup) | High |
| `cost_micros` | `chargedCents`/`totalCents` ×10 000 | High on enterprise plans; **zeroed on self-serve** → null or `estimated` |
| `quota_snapshot.used_percent` | `planUsage.totalPercentUsed` (also `autoPercentUsed`, `apiPercentUsed` for the two pools) | High (verified live) |
| `quota_snapshot.resets_at` | `billingCycleEnd` (epoch ms) | High |
| `quota_snapshot.window` | `kind: "fixed"`, label "billing-cycle" | High |

Ranked alternatives (if the RPC path is rejected or breaks):
1. **Admin API for teams** (`official_api`) — best data quality but only for team admins with a `crsr_` key, and docs now gate usage endpoints to Enterprise. Worth supporting later as an *additional* credential tier, like OpenRouter's management key.
2. **Dashboard session-cookie scraping** — same data, worse credential (full web session), extraction from browser or IDE `state.vscdb` required, and precedent of breakage: [Dwtexe/cursor-stats](https://github.com/Dwtexe/cursor-stats) (the most popular tool in this space) is archived, its author citing "constant changes in Cursor's pricing policy". Do not build this.
3. **Local-log-only** — honest but crippled: model + request counts per conversation, zero tokens, zero cost. Only acceptable as a supplemental join source, not a primary.

## 3. Sample REDACTED payloads → Burn observation types

`consumption` — from one `GetFilteredUsageEvents` event (fake values):

```json
{
  "type": "consumption",
  "period_start": "2026-08-28T15:41:48.075Z",
  "period_end": "2026-08-28T15:41:48.075Z",
  "model": "cursor-grok-4.6-high",
  "input_tokens": 9771,
  "cached_input_tokens": 5760,
  "output_tokens": 542,
  "reasoning_output_tokens": null,
  "requests": 1,
  "cost_micros": 25674,
  "currency": "USD",
  "counting": "provider_reported"
}
```
(Source event: `{"timestamp":"1788027708075","model":"cursor-grok-4.6-high","kind":"USAGE_EVENT_KIND_INCLUDED_IN_BUSINESS","tokenUsage":{"inputTokens":9771,"outputTokens":542,"cacheReadTokens":5760,"totalCents":2.5674},"chargedCents":2.5674,"conversationId":"<uuid>","subscriptionProductId":"enterprise-legacy"}` — email/user fields redacted. On a self-serve plan expect `chargedCents: 0`.)

`consumption` (daily rollup) — from `GetAggregatedUsageEvents` (fake values):

```json
{
  "type": "consumption",
  "period_start": "2026-08-28T00:00:00Z",
  "period_end": "2026-08-29T00:00:00Z",
  "model": "claude-opus-4-8-thinking-high",
  "input_tokens": 380,
  "cached_input_tokens": 31661463,
  "output_tokens": 163594,
  "requests": null,
  "cost_micros": 34997088,
  "currency": "USD",
  "counting": "provider_reported"
}
```
(Note: rollup also carries `cacheWriteTokens` — 1 095 115 in the live probe — which currently has no Burn field.)

`quota_snapshot` — from `GetCurrentPeriodUsage` (fake values):

```json
{
  "type": "quota_snapshot",
  "window": { "kind": "fixed", "label": "billing-cycle", "duration_seconds": 2678400 },
  "used_percent": 1.2,
  "used": 30000,
  "limit": 20000000,
  "remaining": 19970000,
  "unit": "usd_micros",
  "resets_at": "2026-09-24T05:28:06Z"
}
```
(Source: `planUsage{totalSpend:3, includedSpend:3, remaining:1997, limit:2000, totalPercentUsed:0.012}` in cents, `billingCycleStart/End` epoch-ms. A second snapshot can carry `spendLimitUsage{pooledUsed:1695, pooledLimit:490000, limitType:"team"}`.)

`adapter_status` (auth lapse):

```json
{
  "type": "adapter_status",
  "status": "authentication_required",
  "message": "Cursor CLI token expired; run `cursor-agent login`",
  "provider_version": "2026.08.25-3e8eec8"
}
```

## 4. Impossible / unknown — stated explicitly

- **No official individual-account usage API exists.** The [APIs overview](https://cursor.com/docs/api) gates Admin/Analytics/AI-Code-Tracking APIs to Enterprise teams; nothing is documented for Pro/Ultra individuals. Any individual-account collection is therefore unofficial by definition.
- **Per-request cost on self-serve plans is deliberately withheld** (zeroed at read time, including historical records) since 2026-07-31. Tokens are unaffected. Only estimation can fill the gap, and estimates will overstate real out-of-pocket cost for plan-covered usage.
- **No reasoning-token breakdown** anywhere (RPC, Admin API, local files).
- **No stable per-event ID** in `GetFilteredUsageEvents` — dedup must be synthesized from `(timestamp, conversationId, model)`.
- **Local files contain zero token counts.** Verified across `~/.cursor/chats/*/store.db`, `~/.cursor/acp-sessions/*/store.db` (JSON key-path sweep + protobuf field walk), and `~/.cursor/ai-tracking/ai-code-tracking.db`. Only `modelName`, `requestId`, `conversationId`, timestamps.
- **`aiserver.v1` has no stability contract.** Field numbers observed in CLI bundle `index.js` (e.g. `GetFilteredUsageEventsRequest` fields 1–12, `TokenUsage` fields 1–7) can change with any release; the `cursor-stats` abandonment shows Cursor changes these surfaces without notice. Pin per-CLI-version expectations and fail soft (`adapter_status: incompatible_version`).
- **Unknown:** whether the api2.cursor.sh Bearer path is rate-limited (dashboard-doc limits — 60 req/min on the Admin API equivalent — are a sensible self-imposed cap); whether the IDE (not installed on this machine) stores an equally usable token in `~/.config/Cursor/User/globalStorage/state.vscdb` (community tools say yes — `cursorAuth/accessToken` keys — but unverified here); retention window of usage events (probe returned 56 events over 7 days; older-range retention untested); ToS posture on third-party tools calling internal endpoints with the user's own token (undocumented; classify as user's-own-risk and keep read-only).

## 5. Follow-up prototype work

- Prototype `src/providers/cursor.ts` calling the three DashboardService RPCs with connect-JSON (`Content-Type: application/json`, plain POST works — verified with curl); golden-fixture the responses under `docs/fixtures/`.
- Decide the `cacheWriteTokens` mapping (new payload field vs fold into `input_tokens`) — affects schema version.
- Test on a **self-serve (Pro) account** to confirm: token fields intact, cents zeroed, `team_id`-less requests accepted, `INCLUDED_IN_PRO` kind mapping.
- Implement estimated-cost table for the zeroed-cents case (model → per-Mtoken input/output/cache prices from the pricing page), emitting `counting/source quality: estimated`.
- Add JWT `exp` pre-check and `authentication_required` surfacing; verify CLI auto-refresh cadence (does `cursor-agent status` refresh? — cheap to test).
- Probe retention: request a 90-day range and record how far back events go.
- Version-drift canary: on adapter start, `HEAD`-check response shape (presence of `usageEventsDisplay[].tokenUsage`) and emit `incompatible_version` instead of silently ingesting nulls.
- Later tier: optional Admin API credential (`crsr_` key, Basic auth) for team-admin users, reusing the same event mapper (field names are identical between `/teams/filtered-usage-events` and the RPC).
- Optional enrichment: join `conversationId` from usage events to `~/.cursor/chats/<hash>/<id>/meta.json` (`title`, `cwd`) for per-project attribution — metadata only, never blob content.
