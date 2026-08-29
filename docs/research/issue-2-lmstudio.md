# Issue #2 — LM Studio consumption collection modes

- Issue: JarenKempton/burn#2
- Date: 2026-08-28
- Sources: live local installation at `/home/jaren/.lmstudio/` (LM Studio desktop, llmster daemon 0.0.22-1, server running on port 1234, inspected 2026-08-28), official docs fetched live from https://lmstudio.ai/docs, and upstream source at github.com/lmstudio-ai/lms and github.com/lmstudio-ai/lmstudio-js (exact files cited inline). No prompt/completion text is reproduced anywhere in this document.

**Recommendation.** Burn should ship **passive collection first, proxy later as an optional add-on — i.e. eventually both, but not both in v0.** LM Studio has **no historical or aggregate usage API**: per-request stats exist only (a) in the moment, on each response (`/api/v0` `stats` block, `/api/v1/chat` `stats` block, SDK `result.stats`), (b) on the live diagnostics stream (`lms log stream`), and (c) persisted inside in-app conversation files. The smallest reliable v0 is a **passive tap on the diagnostics stream** via `lms log stream --source model --filter output --stats --json`, whose `llm.prediction.output` events carry a complete, typed `LLMPredictionStats` object (promptTokensCount, predictedTokensCount, totalTokensCount, tokensPerSecond, timeToFirstTokenSec, totalTimeSec, stopReason) plus `modelIdentifier` — one event per prediction, engine-level, so it should cover in-app chat *and* API-served traffic (coverage of API traffic must be confirmed in the prototype; see §6). The events also carry the completion text, so the adapter must drop the `output`/`input` fields in-process and persist stats only. A request proxy is deferred: it is the only way to get request IDs and per-client attribution, but it requires every client to be repointed and still misses in-app chat, so it earns its complexity only after the passive path is proven. Server-file log parsing and conversation-file scanning are rejected for v0 (privacy and fragility, respectively — details below), though conversation files are the only surface offering any backfill and remain a candidate for a later opt-in.

---

## 1. What exists locally (inspected installation)

Layout of `/home/jaren/.lmstudio/` (structure only; content redacted):

| Path | Relevance |
|---|---|
| `conversations/*.conversation.json` | In-app chats. Top level: `name`, `createdAt`, `tokenCount`, `systemPrompt`, `messages[]`. Each assistant message version carries `genInfo` with `indexedModelIdentifier`, `loadModelConfig` (context length, GPU/flash-attention settings, full Jinja prompt template), `predictionConfig`, and **`stats`** — verified sample fields on this machine: `stopReason`, `tokensPerSecond`, `timeToFirstTokenSec`, `totalTimeSec`, `promptTokensCount`, `predictedTokensCount`, `totalTokensCount`. Files also contain **full prompt/completion text**. |
| `server-logs/YYYY-MM/YYYY-MM-DD.N.log` | API server file logs, rotated ~10 MB (`.1`, `.2`, `.3` per day). Verified content: full `POST /v1/chat/completions` **request bodies** (messages, tool definitions — a privacy hazard), full `GET /api/v0/models` responses, llama.cpp `slot print_timing` lines (`prompt eval time = 63334.56 ms / 54346 tokens (858.08 tokens per second)`, `eval time`, `total time`, draft acceptance), `Prompt processing progress`, `Finished streaming response`. Rotation state in `.internal/server-logs-state.json`. |
| `.internal/http-server-config.json` | Effective server config on this machine: `{"autoStartOnLaunch": true, "port": 1234, "cors": false, "logSensitiveData": true, "logIncomingTokens": false, "verbose": true, "logLinesLimit": 500, "networkInterface": "127.0.0.1", "justInTimeModelLoading": true, "fileLoggingMode": "succinct"}`. Note `logSensitiveData: true` — request bodies land in server-logs by default here. |
| `.internal/http-server.json` | Internal daemon control endpoint: `{"host": "127.0.0.1", "pid": ..., "port": 41343}` (websocket port the SDK/`lms` connect to; distinct from API port 1234). |
| `.internal/api-prediction-history/packs/` | **Empty on this machine**, but `settings.json` has `developer.apiPredictionHistoryEviction: {"type": "time", "ttlDays": 30}` — LM Studio 0.4.x evidently persists *some* API prediction history (plausibly the stateful `/api/v1/chat` `store: true` responses) with 30-day eviction. Format undocumented; see §6. |
| `dev-logs/` | Only `dev-logs-state.json` (`lastWrittenFile: null`) here — not a usable usage source on this install. |
| `settings.json` | `enableLocalService: true` (headless service on login), `defaultContextLength`, JIT TTL (`jitModelTTL.ttlSeconds: 3600`), `developer.separateReasoningContentInAPI: true`. |
| `bin/lms` | The `lms` CLI binary is bundled at `~/.lmstudio/bin/lms` (works even though `settings.json` says `cliInstalled: false`; verified `lms server status` → "The server is running on port 1234", `lms ps` → lists loaded models). |
| `llmster/0.0.22-1/llmster` | The server-native daemon ("llmster") powering headless mode. |

`~/.cache/lm-studio` does not exist on this machine.

Live probes (read-only, 2026-08-28): `GET http://127.0.0.1:1234/api/v0/models` → 200, 6 models with `id`, `type`, `publisher`, `arch`, `compatibility_type`, `quantization`, `state` (`loaded`/`not-loaded`), `max_context_length`, `capabilities`. `GET /v1/models` → OpenAI-shaped minimal list (`id`, `object`, `owned_by` only).

## 2. What the official surfaces expose (docs, fetched live)

- **OpenAI-compat** (`/v1/models`, `/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`, `/v1/responses`; base `http://localhost:1234/v1`) — https://lmstudio.ai/docs/developer/openai-compat. The docs page does not enumerate usage fields; standard OpenAI `usage` applies. Local server logs show real clients sending `"stream_options": {"include_usage": true}` against this server (accepted; response side not directly verified — prototype item). An **Anthropic-compatible `/v1/messages`** surface also exists per the v1 API announcement page (https://lmstudio.ai/docs/developer/rest — "OpenAI-compatible … and Anthropic-compatible (`/v1/messages`) endpoints are also offered"); its usage fields are unverified.
- **REST v0** (`/api/v0/models`, `/api/v0/chat/completions`, `/api/v0/completions`, `/api/v0/embeddings`) — https://lmstudio.ai/docs/developer/rest/endpoints. Chat/text completions return, beyond OpenAI fields: `usage {prompt_tokens, completion_tokens, total_tokens}`, **`stats {tokens_per_second, time_to_first_token, generation_time, stop_reason}`**, `model_info {arch, quant, format, context_length}`, `runtime {name, version, supported_formats}`. Marked beta; v1 is now recommended.
- **REST v1** (LM Studio 0.4.0+; `/api/v1/chat`, `/api/v1/models`, `/api/v1/models/load|unload|download`) — https://lmstudio.ai/docs/developer/rest and https://lmstudio.ai/docs/developer/rest/chat. `/api/v1/chat` responses include **`stats {input_tokens, total_output_tokens, reasoning_output_tokens, tokens_per_second, time_to_first_token_seconds, model_load_time_seconds}`**, `model_instance_id`, and (with `store: true`, the default) a `response_id` (`resp_...`) usable as `previous_response_id` — the only request-ID-like identifier anywhere in the product, and only on this endpoint. **No endpoint lists or retrieves past responses/usage.**
- **`lms` CLI** — https://lmstudio.ai/docs/cli and https://lmstudio.ai/docs/cli/log-stream. `lms log stream` streams "the exact strings LM Studio sends to and receives from models"; flags `--source model|server|runtime`, `--filter input,output`, `--json` (newline-delimited JSON), `--stats` ("Print prediction stats when available"; only valid with `--source model`). `lms ps` lists loaded models; `lms server status` reports the port.
- **Diagnostics stream schema** (what `--json` actually emits) — verified in source: `lms` repo `src/subcommands/log.ts` (github.com/lmstudio-ai/lms) subscribes to `client.diagnostics.unstable_streamLogs`; event data is a discriminated union defined in `lmstudio-js/packages/lms-shared-types/src/diagnostics/DiagnosticsLogEvent.ts`:
  - `llm.prediction.input`: `{input: string, modelPath, modelIdentifier}` — full formatted prompt.
  - `llm.prediction.output`: `{output: string, stats?: LLMPredictionStats, modelIdentifier}` — full completion text plus stats.
  - `server.log`, `runtime.log`: text lines.
- **`LLMPredictionStats`** (`lmstudio-js/packages/lms-shared-types/src/llm/LLMPredictionStats.ts`): `stopReason` (`userStopped | modelUnloaded | failed | eosFound | stopStringFound | toolCalls | maxPredictedTokensReached | contextLengthReached`), and optional `stopString`, `tokensPerSecond`, `numGpuLayers` (documented as "currently not correct"), `timeToFirstTokenSec`, `totalTimeSec`, `promptTokensCount`, `predictedTokensCount`, `totalTokensCount`, plus speculative-decoding fields (`usedDraftModelKey`, `totalDraftTokensCount`, `acceptedDraftTokensCount`, `rejectedDraftTokensCount`, `ignoredDraftTokensCount`). All stats fields except `stopReason` are optional — `--stats` is best-effort.
- **SDKs** (TS/Python) expose the same per-response stats (`result.stats.predictedTokensCount`, `timeToFirstTokenSec`, `stopReason`, …) — https://lmstudio.ai/docs/typescript/llm-prediction/completion — but only for predictions the SDK itself initiates; not a collection surface for third-party traffic.
- **Auth** — https://lmstudio.ai/docs/developer/core/authentication (via search; page enumerated from lmstudio-ai/docs repo): **no auth by default**; LM Studio 0.4.0+ can optionally require API tokens (generated on the Developer page, sent as `Authorization: Bearer $LM_API_TOKEN`; required for MCP-via-API regardless). Network exposure: `networkInterface` (default loopback `127.0.0.1` on this install; the GUI offers "serve on local network"), `cors` off by default, port 1234 default.
- **Headless** — https://lmstudio.ai/docs/developer/core/headless: desktop app "run server on login" (tray), or the standalone `llmster` daemon (`lms daemon up`, systemd-able). JIT loading auto-loads models on request and auto-evicts after TTL.

**Key answer for issue #2:** there is **no historical/aggregate usage surface** for API-served traffic. Stats are per-response, at response time, or on the live diagnostics stream. If Burn is not listening when a prediction happens, that prediction's usage is gone (partial exceptions: in-app chats persist `genInfo.stats` in conversation files; the undocumented `api-prediction-history` store *may* retain stored v1-chat responses for 30 days).

## 3. Mode comparison

| Mode | Mechanism | Completeness | Privacy | Fragility | Effort |
|---|---|---|---|---|---|
| **Passive diagnostics tap** (recommended v0) | Subprocess `lms log stream --source model --filter output --stats --json`, parse NDJSON, keep `stats` + `modelIdentifier` + timestamp, drop `output` | One event per prediction, engine-level → in-app chat + API traffic (API coverage to be verified); **no request IDs, no client attribution**; live-only — misses everything while Burn or LM Studio's tap is down | Completion text transits Burn's process memory; never persisted. Input events excluded entirely by `--filter output` | Medium: `--json` shape is a typed schema in `lms-shared-types`, but the underlying RPC is literally named `unstable_streamLogs`; pin/test per LM Studio release | Low: spawn + NDJSON parse + field whitelist |
| **Request proxy** (optional, later) | Burn listens on e.g. 1244, forwards to 1234; records `usage`/`stats` from response bodies (inject `stream_options.include_usage` or parse SSE tails for streams) | Complete **only for traffic routed through it**; misses in-app chat and anything still pointed at 1234; uniquely provides request IDs, per-client attribution (listener port / header), status codes, wall-clock timing | Prompts and completions transit the proxy; Burn records counters only. Clear story: "usage numbers from responses passing through; content never written" | Medium-high: must faithfully pass through SSE streaming, tool calls, images, both OpenAI and Anthropic shapes, v0/v1 REST; breaks silently if clients bypass it | High: reverse proxy + response parsing + client reconfiguration UX |
| **SDK/REST polling** | Poll `GET /api/v0/models`, `lms ps`, `lms server status` | **Zero consumption data** — no aggregate endpoint exists to poll. Useful only for `adapter_status` and model-load state | Perfect (no content anywhere near these endpoints) | Low | Trivial |
| **Conversation-file scanning** | Watch `~/.lmstudio/conversations/*.conversation.json` mtimes; extract per-message `genInfo.stats` | In-app chats only (API traffic never touches these files); **the only surface with backfill** — stats persist, so Burn downtime loses nothing for chats | Files contain full prompts/completions; Burn must parse and extract stats fields only, never copy raw files | High: undocumented, unversioned app-internal format (already migrated once — `pre030ChatsMigrated`); silent breakage on app updates | Medium |
| **Server-file log parsing** (rejected) | Tail `~/.lmstudio/server-logs/` | API traffic only; token/speed data exists but in freeform llama.cpp timing lines interleaved per engine | Worst: with default-on `logSensitiveData`, full request bodies (prompts, tool defs) sit in the files Burn would tail | Worst: engine-specific text formats, 10 MB rotation, `fileLoggingMode`/`verbose` settings change content | Medium, wasted |

## 4. Recommended v0 and onboarding UX

**v0 collection loop** (all passive; no LM Studio configuration changes):

1. `adapter_status` probe: `GET http://127.0.0.1:<port>/api/v0/models` (also yields the model inventory). Fallback discovery: `lms server status`. Port default 1234, overridable.
2. Consumption/performance: long-running child process `~/.lmstudio/bin/lms log stream --source model --filter output --stats --json` (resolve `lms` from `~/.lmstudio/bin/`, then `$PATH`). For each `llm.prediction.output` event: read `data.stats` and `data.modelIdentifier`, **immediately discard `data.output`**, emit one `consumption` + one `inference_performance` observation. Auto-restart the subprocess with backoff; emit `adapter_status: temporarily_failed` while disconnected so gaps are visible.
3. No `quota_snapshot`, no `credit_balance` — local inference has neither quotas nor cost. Do not fabricate `cost_micros: 0`; leave cost fields null and `currency` null.

**`burn providers add lmstudio` UX:**

- Zero-credential by default. Detect: `~/.lmstudio/` exists? `lms` binary found? Probe `http://127.0.0.1:1234/api/v0/models`. Print what was found (app version from `~/.lmstudio/.internal/historical-version-info.json` if readable).
- Flags: `--port <n>` (non-default server port), `--host <addr>` (only if the user serves on the LAN; warn that LM Studio has no auth by default and CORS/network exposure are user-managed), `--api-token <t>` stored in keychain **only if** the user has enabled LM Studio's optional token auth (0.4.0+; sent as `Authorization: Bearer`, needed for v1 endpoints when auth is on — the diagnostics tap goes through `lms`'s own local channel and needs no token).
- Print the standing limitation up front: "LM Studio keeps no usage history. Burn records requests only while both LM Studio and the Burn agent are running; anything before enrollment or during downtime is unrecoverable."
- Recommend (don't require) LM Studio's "run server on login" / `lms daemon up` so the tap has something to attach to.

**Envelope values:** `provider_id: "lmstudio"`, `source_quality: "official_cli"` (documented `lms log stream --json` contract; downgrade to `experimental_rpc` if the adapter later binds `unstable_streamLogs` directly via the SDK), `counting: "provider_reported"`, `account_ref: null` (no accounts). `observation_id`: hash of `(node_id, observed_at ns, modelIdentifier, totalTokensCount)` — no provider request ID exists.

## 5. Field mappings (sample payloads, fake values, REDACTED)

Source event (shape per `DiagnosticsLogEvent.ts`; `output` shown only to document what must be dropped):

```json
{"timestamp": 1787950000000,
 "data": {"type": "llm.prediction.output",
          "output": "<REDACTED — dropped in-process, never persisted>",
          "modelIdentifier": "qwen/qwen3-coder-30b",
          "stats": {"stopReason": "eosFound", "tokensPerSecond": 91.17,
                     "timeToFirstTokenSec": 0.121, "totalTimeSec": 0.843,
                     "promptTokensCount": 1740, "predictedTokensCount": 66,
                     "totalTokensCount": 1806}}}
```

`consumption` — one per prediction; window kind `request` (per issue #7 window taxonomy):

```json
{"type": "consumption",
 "period_start": "2026-08-28T14:40:31.000Z",
 "period_end": "2026-08-28T14:40:31.843Z",
 "model": "qwen/qwen3-coder-30b",
 "input_tokens": 1740,
 "cached_input_tokens": null,
 "output_tokens": 66,
 "reasoning_output_tokens": null,
 "total_tokens": 1806,
 "requests": 1,
 "cost_micros": null,
 "currency": null,
 "counting": "provider_reported"}
```

(`period_start` = event timestamp minus `totalTimeSec`; `period_end` = event timestamp. `reasoning_output_tokens` is null on this path — only `/api/v1/chat` responses split reasoning tokens.)

`inference_performance`:

```json
{"type": "inference_performance",
 "model": "qwen/qwen3-coder-30b",
 "request_ref": null,
 "time_to_first_token_ms": 121,
 "tokens_per_second": 91.17,
 "duration_ms": 843,
 "input_tokens": 1740,
 "output_tokens": 66}
```

(`request_ref` stays null in passive mode; a future proxy mode fills it with the OpenAI-compat response `id` or v1 `response_id`. `stopReason` values worth surfacing later: `failed`, `contextLengthReached`.)

`adapter_status`:

```json
{"type": "adapter_status",
 "status": "healthy",
 "message": "server on 127.0.0.1:1234; log stream attached; 6 models (1 loaded)",
 "provider_version": "0.4.2"}
```

Status mapping: probe 200 + stream attached → `healthy`; connection refused / `lms` missing → `temporarily_failed`; server requires token Burn lacks (v1 401) → `authentication_required`; NDJSON schema mismatch after an LM Studio update → `incompatible_version`.

## 6. Impossible / unknown — stated explicitly

- **Historical backfill of API traffic: impossible.** No endpoint lists past requests or aggregates usage. Requests made while Burn (or the stream tap) is down are permanently unobserved. In-app chats are the sole exception (stats persist in conversation files) — an opt-in backfill scanner is future work, not v0.
- **`api-prediction-history/packs`: unknown.** Present with a 30-day eviction setting (`settings.json` → `developer.apiPredictionHistoryEviction`), empty on this machine, undocumented. If it stores v1 stateful-chat responses with stats, it would be a second backfill surface. Needs a populated install to reverse — do not build on it yet.
- **Diagnostics stream coverage of API-originated predictions: unverified.** Docs describe engine-level I/O logging, which implies all sources, but this session did not run an inference to confirm (avoided mutating server state). Prototype must confirm events fire for `/v1/chat/completions`, `/api/v0/*`, `/api/v1/chat`, and embeddings (embeddings likely emit no `llm.prediction.*` events at all — embedding usage may be invisible to passive mode; the v0 docs example even shows `usage: {"prompt_tokens": 0, "total_tokens": 0}` for embeddings).
- **Stats are optional.** `stats?` in the schema and "when available" in the docs — the adapter must tolerate stat-less output events (emit nothing, or a count-only `consumption` with token fields null; never zeros).
- **No request IDs, no client attribution, no status codes** on the diagnostics stream. Only a proxy provides these.
- **`stream_options.include_usage` behavior on OpenAI-compat streaming responses: unverified** (clients on this machine request it; the response-side chunk was not captured). Matters only for proxy mode.
- **Anthropic-compat `/v1/messages` usage fields: unverified.** Matters only for proxy mode.
- **`unstable_streamLogs`** is explicitly unstable upstream; the `lms --json` CLI contract is the safer dependency but can still change between releases. Multi-instance model loads (`model_instance_id`) and concurrent predictions interleaving on the stream are untested.
- **`numGpuLayers`** in stats is documented by upstream as "currently not correct" — ignore it.

## 7. Prototype follow-ups

- Run `lms log stream --source model --filter output --stats --json` while issuing one request each to `/v1/chat/completions` (stream + non-stream), `/api/v0/chat/completions`, `/api/v1/chat`, and `/v1/embeddings`; confirm which produce output events, that stats are populated, that `--filter output` truly suppresses input events in JSON mode, and capture the exact NDJSON envelope (`timestamp` units, field casing) for a golden-file test.
- Verify stream behavior across: server stop/start, model JIT load/unload mid-stream, app quit-to-tray, llmster-daemon-only (no GUI) operation, and two concurrent predictions (event interleaving/ordering).
- Measure subprocess supervision needs: does `lms log stream` exit or hang when the daemon restarts? Implement reconnect-with-backoff and `adapter_status` gap reporting accordingly.
- Confirm streaming OpenAI-compat responses include a final usage chunk with `stream_options.include_usage` (needed before committing to proxy-mode design).
- Inspect a populated `~/.lmstudio/.internal/api-prediction-history/packs/` (make a `store: true` `/api/v1/chat` request first) to determine format and whether it enables 30-day API backfill.
- Decide the conversation-file backfill story: prototype an mtime-watcher that extracts `genInfo.stats` only, and measure dedup overlap against live-stream events for in-app chats (same prediction observed twice: once live, once from the file).
- Version-pin strategy: record LM Studio app/`lms` versions in `adapter_status.provider_version`; add a canary test in CI against the current `@lmstudio/lms-shared-types` npm package (0.6.14 today) to detect schema drift.
- Proxy-mode spike (post-v0): minimal pass-through on a second port recording `usage` from non-streaming OpenAI-compat responses, to validate the client-repointing UX before investing in SSE/Anthropic/v1 coverage.
