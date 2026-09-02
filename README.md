# burn

Local-first CLI and server for AI usage and limits observability. Burn
collects quota windows, token consumption, credits, and inference performance
from the AI tools you already use — Claude Code, Codex, OpenRouter, LM Studio
— normalizes them into versioned observations, and keeps durable history in
SQLite on your own machines.

- One executable, two roles: `server` (keeps history, serves the API) and
  `collector` (gathers usage on a machine and reports in). `burn server run`
  does both, so the server machine is covered automatically. An enrolled
  machine is called a *node*.
- Collectors only make outbound connections; enrollment is a browser-approved
  device-authorization flow.
- Tailscale Serve is the recommended transport (`tailscale serve --bg 7337`);
  LAN is an explicit opt-in.
- Provider credentials never leave the collecting node; prompts and
  completions are never read into observations.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/JarenKempton/burn/main/install.sh | bash
```

Installs the latest release binary to `~/.local/bin/burn` (Linux/macOS, x64
and arm64). Update any time with `burn update`. From a source checkout:
`bun install && bun run build`.

## Quick start

```sh
# on the machine that keeps history — it collects on itself automatically
burn server run

# on every other machine that uses AI tools
burn collector run     # asks for the server URL on first run and walks you
                       # through browser-approved enrollment

burn providers add     # connect providers (local tools are auto-detected)
burn status            # machines, quota windows, usage
```

To reach the server from other machines, run `tailscale serve --bg 7337` on
it and enroll against `https://<server>.<tailnet>.ts.net`. `burn server
install` writes systemd user units (Linux) or launchd agents (macOS) for
install-and-forget operation.

For Claude Code 5-hour/weekly quota windows, run
`burn providers add claude_code` — it offers to register Burn as your Claude
Code statusline (the officially documented surface that carries rate-limit
data).

## Moving a server or repairing a cloned machine

Move the authoritative server database without overwriting the destination
machine's collector identity or provider credentials:

```sh
# old server (stop its service first for the final cutover snapshot)
systemctl --user disable --now burn-server
burn server backup ~/burn-migration

# copy ~/burn-migration to the new machine, stop Burn there, then:
systemctl --user disable --now burn-server burn-collector
burn server restore ~/burn-migration --replace
burn server install
```

If a machine was cloned from another collector, give it its own Burn identity
before starting it. This preserves provider settings and collection cursors,
but removes the copied node credential and pending observations:

```sh
burn collector reidentify
```

After a server move, existing collectors should retain their node identity and
history. Point them at the restored server with:

```sh
burn collector retarget https://new-server.example.ts.net
burn collector install
```

## Documentation

- `docs/spec.md` — CLI/HTTP/SQLite contracts, auth and redaction invariants.
- `docs/fixtures/` — example observation payloads.
- `docs/research/` — provider research findings (issues #2, #3, #5, #6).

## Development

```sh
bun test          # end-to-end: enrollment, ingestion idempotency, liveness
bunx tsc --noEmit # typecheck
```
