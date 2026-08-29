# Issue #6 — OpenRouter onboarding and usage collection capabilities

- Issue: JarenKempton/burn#6
- Date: 2026-08-28
- Sources: fetched live from https://openrouter.ai/docs on 2026-08-28 (exact URLs cited inline). All endpoint shapes below were read from OpenRouter's published OpenAPI-derived reference pages, not from memory.

**Recommendation.** The first Burn adapter should support two credential tiers. Tier 1 (OAuth PKCE, zero-paste onboarding) yields a regular `sk-or-v1-...` inference key that unlocks only `GET /api/v1/key` (per-key usage + limits, `quota_snapshot`) and `GET /api/v1/generation` (per-generation metadata, deferred to a later milestone). Tier 2 (paste a **management key**, created manually in the OpenRouter dashboard) unlocks the endpoints Burn actually needs for observability: `GET /api/v1/activity` (30-day daily rollups per model/endpoint — the primary `consumption` source), `GET /api/v1/credits` (`credit_balance`), `POST /api/v1/analytics/query` (richer ad-hoc analytics), and `/api/v1/keys` (per-key inventory). Current docs mark `/credits` and `/activity` as "Management key required" with a `403 Only management keys can perform this operation` otherwise — so OAuth PKCE alone is *not* sufficient for the core collection loop, and v0 should treat the management key as the primary credential with OAuth PKCE as an optional add-on for per-key quota snapshots. v0 should collect from `/activity` + `/credits` + `/key` on a poll loop and skip `/generation` (Burn has no reliable source of generation IDs unless it proxies traffic).

---

## 1. Endpoint / capability matrix

| Endpoint | Capability | Credential required | Pagination / cursor | Rate limits | Stability |
|---|---|---|---|---|---|
| `https://openrouter.ai/auth?callback_url=...&code_challenge=...&code_challenge_method=S256` | Start OAuth PKCE; localhost callback on **any port** supported; headless mode (omit `callback_url`, add `key_label=<app>`) shows code for manual paste | none (browser session) | n/a | code single-use, expires 10 min | official_api ([oauth-pkce](https://openrouter.ai/docs/use-cases/oauth-pkce)) |
| `POST /api/v1/auth/keys` | Exchange `{code, code_verifier, code_challenge_method}` → `{key: "sk-or-v1-...", user_id}` (a regular "user-controlled API key") | none (code is the credential) | n/a | not documented | official_api ([exchange-authorization-code-for-api-key](https://openrouter.ai/docs/api/api-reference/oauth/exchange-authorization-code-for-api-key.md)) |
| `GET /api/v1/key` | Introspect the presented key: `limit`, `limit_remaining`, `limit_reset`, `usage{,_daily,_weekly,_monthly}`, `byok_usage*`, `include_byok_in_limit`, `is_free_tier`, `is_management_key`, `is_provisioning_key` (deprecated alias), `expires_at`; `rate_limit` object is deprecated ("Will always return -1") | regular API key **or** management key (introspects whichever is presented) | none (single object) | none documented for this endpoint; docs recommend it *as* the proactive limit monitor | official_api ([get-current-api-key](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key.md), [limits](https://openrouter.ai/docs/api-reference/limits)) |
| `GET /api/v1/credits` | Account totals: `data.total_credits`, `data.total_usage` (doubles; credits ≈ USD) | **management key** ("Management key required"; 403 otherwise) | none | not documented | official_api ([get-remaining-credits](https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits.md)) |
| `GET /api/v1/activity` | Daily rollups for the **last 30 completed UTC days**, aggregated by date × model × endpoint: `date`, `model`, `model_permaslug`, `endpoint_id`, `provider_name`, `usage` (USD), `byok_usage_inference` (USD), `requests`, `prompt_tokens`, `completion_tokens`, `reasoning_tokens` (+ optional `workspace_id`). Filters: `date=YYYY-MM-DD`, `api_key_hash`, `user_id` (org accounts), `group_by=workspace`, `workspace_id` | **management key** (403 otherwise) | none — single `data` array, no cursor; `date` param is the de-facto cursor | not documented | official_api ([get-user-activity-grouped-by-endpoint](https://openrouter.ai/docs/api/api-reference/analytics/get-user-activity-grouped-by-endpoint.md)) |
| `POST /api/v1/analytics/query` | Ad-hoc analytics: `metrics[]` (required), `dimensions[]` (max 2), `filters[]` (max 20), `time_range{start,end}`, `granularity` (e.g. `day`), `order_by`, `limit` (default 1000), `group_limit`; response `data.data[]` rows + `metadata{query_time_ms,row_count,truncated}` + `warnings[]`; discover metrics/dimensions via the analytics `/meta` endpoint | **management key** (403 otherwise) | `limit`/`group_limit` + `truncated` flag (no cursor) | 408 timeout possible; otherwise not documented | official_api ([query-analytics-data](https://openrouter.ai/docs/api/api-reference/analytics/query-analytics-data.md), [get-available-analytics-metrics-and-dimensions](https://openrouter.ai/docs/api/api-reference/analytics/get-available-analytics-metrics-and-dimensions.md)) |
| `GET /api/v1/generation?id=gen-...` | Per-generation metadata: `total_cost` (USD), `usage`, `cache_discount`, `upstream_inference_cost`, `is_byok`, `tokens_prompt/completion`, `native_tokens_prompt/completion/reasoning/cached/completion_images`, `latency`, `generation_time`, `moderation_latency`, `created_at`, `finish_reason`, `provider_name`, `streamed`, `cancelled`, fallback `provider_responses[]` | regular API key (bearer; the authenticated account's generations). Retention window not documented | none (single object) | 429 documented among errors; no specific quota | official_api ([get-a-generation](https://openrouter.ai/docs/api-reference/get-a-generation)) |
| `GET /api/v1/keys` (+ `GET/POST/PATCH/DELETE /api/v1/keys/{key_hash}`) | Key inventory and per-key usage: each item has `hash`, `label`, `name`, `disabled`, `limit`, `limit_remaining`, `limit_reset`, `include_byok_in_limit`, `usage{,_daily,_weekly,_monthly}`, `byok_usage*`, `created_at`, `updated_at`. Management key can read usage/limits of every key it lists. Cannot call completion endpoints | **management key** (created manually at https://openrouter.ai/settings/management-keys — no API to mint one) | offset pagination: 100 most recent, `?offset=100` | not documented | official_api ([management-api-keys guide](https://openrouter.ai/docs/features/provisioning-api-keys), [list-api-keys](https://openrouter.ai/docs/api/api-reference/api-keys/list-api-keys.md)) |

General platform rate limits (from [limits](https://openrouter.ai/docs/api-reference/limits)): documented numeric limits apply only to `:free` model inference (20 req/min; 50 or 1000 req/day depending on lifetime credits purchased); metadata endpoints have no published per-endpoint quota but sit behind Cloudflare DDoS protection. 429 bodies carry `error_type: "rate_limit_exceeded"` with `X-RateLimit-Limit/Remaining/Reset` headers; successful responses carry no `X-RateLimit-*` headers.

Terminology note: OpenRouter renamed "provisioning keys" to **management keys**; `GET /key` still returns the deprecated `is_provisioning_key` as an alias of `is_management_key`. Burn should use "management key" in UX and code.

## 2. Proposed onboarding flow — `burn providers add openrouter`

1. **Primary path — paste a management key.** Prompt: "Create a Management API key at https://openrouter.ai/settings/management-keys and paste it here." Validate by calling `GET /api/v1/key` and asserting `data.is_management_key == true`. This single credential unlocks everything the collector needs: `/activity`, `/credits`, `/analytics/query`, `/keys`, and `/key` (self-introspection). Management keys cannot spend on inference, which is a good least-privilege property for an observability tool — Burn holds a credential that can read usage and manage keys but cannot run completions.
2. **Optional path — OAuth PKCE (`--oauth`).** For users who won't create a management key:
   - Generate `code_verifier` (43–128 chars), compute `code_challenge = base64url(sha256(verifier))`.
   - Start a localhost listener on an ephemeral port (any port is supported) and open `https://openrouter.ai/auth?callback_url=http://localhost:<port>/callback&code_challenge=<c>&code_challenge_method=S256`. If no browser (SSH), use headless mode: omit `callback_url`, pass `key_label=burn`, and prompt the user to paste the displayed code (single-use, 10-minute expiry).
   - Exchange via `POST https://openrouter.ai/api/v1/auth/keys` with `{code, code_verifier, code_challenge_method: "S256"}` → `{key, user_id}`.
   - The result is a **regular inference key** (`sk-or-v1-...`), user-visible and revocable at `https://openrouter.ai/keys/<sha256hex(key)>`. It unlocks only `GET /api/v1/key` and `GET /api/v1/generation` — Burn must tell the user that balance/analytics collection stays disabled until a management key is added.
3. **Plain API-key paste** is the same tier as OAuth (a regular key); accept it but show the same capability warning.
4. **Capability probe on add and on every collector start:** call `GET /api/v1/key`, record `{is_management_key, is_free_tier, limit, limit_remaining, expires_at}`, and derive the enabled capability set. A 401 → credential revoked/expired: mark the provider `needs_reauth`, keep historical observations, and re-run onboarding on next `burn providers add openrouter` (idempotent upsert).

**Credential storage:** store the key in the OS keychain via a keyring library (Secret Service/`libsecret` on Linux, Keychain on macOS, Credential Manager on Windows); fall back to a file under `$XDG_CONFIG_HOME/burn/credentials.json` created with mode `0600` (and `0700` parent dir) when no keychain is available, with a startup warning. Never write the key into the observation store, logs, or error messages — log only the SHA-256 hash prefix (which is also OpenRouter's public key identifier: `keys/{key_hash}` uses lowercase hex sha256 of the key, per [oauth-pkce](https://openrouter.ai/docs/use-cases/oauth-pkce)).

**Revocation/reauth:** there is no API for a key to revoke itself; deletion happens in the dashboard (`https://openrouter.ai/keys/<hash>` for user keys, `/settings/management-keys` for management keys), or via `DELETE /api/v1/keys/{key_hash}` for keys *provisioned by* a management key. `burn providers remove openrouter` should delete the stored secret and print the dashboard URL for manual revocation.

## 3. Incremental collection contract

- **`/activity` (consumption):**
  - Window: last 30 *completed* UTC days only; today is excluded and days older than 30 fall off. Burn must poll at least every ~29 days to avoid gaps; daily polling is the target.
  - Cursor: date-based. Persist `last_complete_date` per provider account. Each run fetches the full unfiltered array (cheap; no pagination) or per-day via `?date=YYYY-MM-DD` for backfill, then upserts.
  - Idempotency: natural key `(account_id, date, model_permaslug, endpoint_id)` — the docs state default aggregation is "by date, model, and endpoint". Include `workspace_id` in the key iff `group_by=workspace` is used (note: pre-workspace activity is permanently attributed to the default workspace, no backfill). Upsert semantics (replace on conflict) make re-fetching the whole 30-day window safe and self-healing if OpenRouter restates a day.
  - Freshness: a day is final once it is a completed UTC day; still, re-fetch the trailing 2–3 days on each run defensively and rely on upsert.
- **`/credits` (credit_balance):** snapshot endpoint, no cursor. Poll on collector interval (e.g. hourly); idempotency key `(account_id, observed_at)`; derive balance = `total_credits - total_usage`.
- **`/key` (quota_snapshot):** snapshot per credential, no cursor. Poll on collector interval; idempotency key `(key_hash, observed_at)`. `usage_daily/weekly/monthly` reset on UTC boundaries — record `observed_at` in UTC so consumers can interpret resets. Ignore the deprecated `rate_limit` object (always -1).
- **`/generation`:** pull-by-ID only; no listing/cursor. Out of scope for v0 (see ambiguity A3).
- **Politeness:** no documented metadata rate limits, but cap at ~1 request/sec with jittered retry on 429 honoring `X-RateLimit-Reset`/`Retry-After`.
- **Redaction:** confirmed — `/key`, `/credits`, `/activity`, and `/analytics/query` return **no prompt or completion content**, only counters, costs, and identifiers. `/generation` (metadata variant) is likewise content-free, but the adjacent endpoint "Get stored prompt, completion, and error content for a generation" ([doc](https://openrouter.ai/docs/api/api-reference/generations/get-stored-prompt-completion-and-error-content-for-a-generation.md)) *does* return content — Burn must never call it. `/generation` metadata does include `http_referer`, `user_agent`, `origin`, and `external_user`; if `/generation` is ever adopted, drop or hash those fields at ingest.

## 4. Sample REDACTED payloads → Burn observation types

All monetary values normalized to integer **micro-USD** (`usd_micros = round(usd * 1_000_000)`); OpenRouter credits are USD-denominated doubles at the API.

`credit_balance` — from `GET /api/v1/credits` (`{"data":{"total_credits":100.5,"total_usage":25.75}}`):

```json
{
  "type": "credit_balance",
  "provider": "openrouter",
  "account_id": "user_2yOPcREDACTED",
  "observed_at": "2026-08-28T14:00:00Z",
  "total_purchased_usd_micros": 100500000,
  "total_used_usd_micros": 25750000,
  "balance_usd_micros": 74750000,
  "source": {"endpoint": "/api/v1/credits", "credential": "management_key"}
}
```

`consumption` — one row per `/activity` item:

```json
{
  "type": "consumption",
  "provider": "openrouter",
  "account_id": "user_2yOPcREDACTED",
  "natural_key": "2026-08-27|openai/gpt-4.1-2025-04-14|550e8400-e29b-41d4-a716-446655440000",
  "date": "2026-08-27",
  "model": "openai/gpt-4.1",
  "model_permaslug": "openai/gpt-4.1-2025-04-14",
  "endpoint_id": "550e8400-e29b-41d4-a716-446655440000",
  "provider_name": "OpenAI",
  "requests": 5,
  "prompt_tokens": 50,
  "completion_tokens": 125,
  "reasoning_tokens": 25,
  "cost_usd_micros": 15000,
  "byok_cost_usd_micros": 12000,
  "source": {"endpoint": "/api/v1/activity", "credential": "management_key"}
}
```

`quota_snapshot` — from `GET /api/v1/key`:

```json
{
  "type": "quota_snapshot",
  "provider": "openrouter",
  "key_hash_prefix": "a3f9c2REDACTED",
  "observed_at": "2026-08-28T14:00:00Z",
  "limit_usd_micros": 100000000,
  "limit_remaining_usd_micros": 74500000,
  "limit_reset": "monthly",
  "usage_usd_micros": 25500000,
  "usage_daily_usd_micros": 1200000,
  "usage_weekly_usd_micros": 8300000,
  "usage_monthly_usd_micros": 25500000,
  "is_free_tier": false,
  "include_byok_in_limit": false,
  "expires_at": null,
  "source": {"endpoint": "/api/v1/key", "credential": "api_key"}
}
```

`adapter_status` — emitted by the adapter itself:

```json
{
  "type": "adapter_status",
  "provider": "openrouter",
  "observed_at": "2026-08-28T14:00:05Z",
  "credential_kind": "management_key",
  "capabilities": {"activity": true, "credits": true, "key": true, "generation": false, "keys_inventory": true},
  "last_activity_date_collected": "2026-08-27",
  "status": "ok",
  "detail": null
}
```

## 5. Unresolved ambiguities

- **A1 — `/credits` privilege tightening.** Current docs unambiguously say `/credits` requires a management key (403 otherwise), but older integrations called it with regular keys. *Resolution:* implement the capability probe (section 2, step 4) rather than hardcoding the assumption — attempt `/credits` with whatever credential is held, and enable the capability from the live response, so Burn works under either policy. Verified against [get-remaining-credits.md](https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits.md) on 2026-08-28.
- **A2 — generation data retention.** No retention window is documented for `/generation` metadata. *Resolution:* irrelevant for v0 (endpoint unused); if adopted later, fetch generations within 24h of observing their IDs and treat 404 as expired.
- **A3 — `/generation` in v0.** Burn only learns generation IDs if it proxies traffic or client tools log them; there is no list endpoint. *Resolution:* v0 relies on `/activity` + `/credits` + `/key` exclusively; define a `generation_ids` ingest hook as a v1 candidate.
- **A4 — `/activity` scope for org accounts.** Whether a member's management key sees org-wide vs member-scoped activity is not fully specified (the `user_id` filter is "Only applicable for organization accounts"). *Resolution:* store `user_id`/`workspace_id` when present in responses; test against an org account before claiming multi-seat support.
- **A5 — metadata endpoint rate limits.** None published. *Resolution:* self-impose ≤1 req/s with exponential backoff on 429; revisit if OpenRouter publishes quotas.
