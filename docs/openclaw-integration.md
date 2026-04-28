# OpenClaw Integration Notes

OpenClaw (codename "Clawy") is an open-source personal AI assistant
released under the MIT License. It is **not** bundled into BOS-OMEGA
at runtime: the BOS-OMEGA orchestration platform remains
self-contained and does not invoke any OpenClaw scripts or tasks
automatically. This document records the integration surface that
exists today and what it is good for.

## What ships in this repo

This repo does **not** vendor the OpenClaw source tree. The reference
implementation is upstream at the OpenClaw GitHub project; clone it
separately if you want to study the channel-adapter patterns
(WhatsApp, Gmail, etc.) or the skills library. Doing so keeps the
BOS-OMEGA repo small and avoids redistributing third-party assets we
do not actively run.

## What this integration does add

A new **PowerShell execution capability** is available to operators
on hosts that have PowerShell Core (`pwsh`) or `powershell.exe`
installed. The intent is to let a single operator drive small,
authenticated host-side automations from inside the dashboard, in
the same audit-logged way the rest of the platform manages overrides.

### Endpoint

`POST /api/powershell`  →  `{ output: string }`

Body: `{ "command": "<powershell expression>" }`

### Security posture

The endpoint is hardened to match the rest of the platform's
defense-in-depth posture:

1. **Authenticated** — sits behind the global `requireAuth` gate.
2. **`super_admin` only** — regular `admin` users cannot reach it.
3. **OFF by default** — requires `POWERSHELL_ENDPOINT_ENABLED=1` in
   the environment to be reachable. Without the flag the endpoint
   replies `404 POWERSHELL_DISABLED`.
4. **Audited** — every invocation (success and failure) writes a
   `POWERSHELL_EXECUTED` / `POWERSHELL_FAILED` row to the audit
   chain with the actor `user_id`, role, IP, command summary, and
   byte counts.
5. **Bounded** — command body capped at 4 KB, output buffer at
   1 MB, wall-clock timeout at 30 s.
6. **Rate-limited** — inherits the platform's `writeLimiter`
   (60 mutating req/min/IP).
7. **No shell binary on the host? Fails closed** with
   `No PowerShell binary found …`.

### Example

```sh
# (Requires POWERSHELL_ENDPOINT_ENABLED=1 in the API server env
#  AND a valid super_admin session cookie.)
curl -X POST http://localhost:8080/api/powershell \
  -H "Content-Type: application/json" \
  --cookie "bos_session=…" \
  -d '{"command":"Get-Date"}'
```

Sample response:

```json
{ "output": "Monday, April 27, 2026  7:42:10 AM" }
```

## Tests

Unit coverage lives at `artifacts/api-server/tests/powershell_unit.mjs`
and validates input rejection plus graceful behaviour when no
PowerShell binary is installed (the common case in the Replit Nix
environment).

## Licensing

OpenClaw is MIT-licensed. If you choose to vendor or adapt OpenClaw
code into your own modules, retain the upstream `LICENSE` alongside
the copied files. BOS-OMEGA's own licensing terms are unchanged by
the presence of this integration document.
