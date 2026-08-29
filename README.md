# burn

Local-first CLI and server for AI usage and limits observability. Burn
collects quota windows, token consumption, credits, and inference performance
from the AI tools you already use — Claude Code, Codex, OpenRouter, LM Studio
— normalizes them into versioned observations, and keeps durable history in
SQLite on your own machines.

- One executable, two roles: `server`, `collector`, or both.
- Agents only make outbound connections; enrollment is a browser-approved
  device-authorization flow (`burn enroll`).
- Tailscale Serve is the recommended transport (`tailscale serve --bg 7337`);
  LAN is an explicit opt-in.
- Provider credentials never leave the collecting node; prompts and
  completions are never read into observations.

## Quick start

```sh
bun install

# on the server machine
bun run src/index.ts server run          # listens on 127.0.0.1:7337

# on each node (can be the same machine)
bun run src/index.ts enroll http://server:7337   # approve in the browser
bun run src/index.ts providers add openrouter    # optional; local tools auto-detect
bun run src/index.ts collector run               # heartbeat + collect + deliver

bun run src/index.ts status
```

`bun run build` compiles a standalone `dist/burn` binary; `burn server
install` writes systemd user units (Linux) or launchd agents (macOS).

For Claude Code 5-hour/weekly quota windows, run
`burn providers add claude_code` — it offers to register Burn as your Claude
Code statusline (the officially documented surface that carries rate-limit
data).

## Documentation

- `docs/spec.md` — CLI/HTTP/SQLite contracts, auth and redaction invariants.
- `docs/fixtures/` — example observation payloads.
- `docs/research/` — provider research findings (issues #2, #3, #5, #6).

## Development

```sh
bun test          # end-to-end: enrollment, ingestion idempotency, liveness
bunx tsc --noEmit # typecheck
```
