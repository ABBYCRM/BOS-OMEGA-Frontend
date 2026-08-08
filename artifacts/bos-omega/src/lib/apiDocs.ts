/**
 * BOS-OMEGA External API — quick reference for the operator.
 *
 * Auth: `Authorization: Bearer bos_<prefix>_<secret>` (issued from
 * Settings → API Tokens). Plaintext is shown ONCE on creation and
 * never stored.
 *
 * Base URL: same as the BOS-OMEGA web app (e.g.
 * `https://bos-omega-teajr.ondigitalocean.app`). All routes are
 * under `/api/external/*`.
 *
 * Scopes (each token has a set; the route requires the matching one
 * or it returns 403 `scope_denied`):
 *   - memory:read, memory:write                          — generic
 *   - memory:canon:read, memory:canon:write              — canon
 *   - memory:scratchpad:read, memory:scratchpad:write    — scratchpad
 *   - memory:continuity:read, memory:continuity:write    — continuity
 *   - conversations:read, conversations:write
 *   - tasks:read, tasks:write
 *   - audit:read
 *   - continuity:export, continuity:import
 *
 * PowerShell-only tokens are rejected when the request's User-Agent
 * looks like a browser — use them for the local bridge so a stolen
 * token cannot be replayed from a web origin.
 *
 * Endpoints
 * ─────────
 *   GET    /api/external/me                                caller identity
 *   GET    /api/external/health                            liveness (token-auth)
 *
 *   GET    /api/external/memory?layer=<>&q=<>&limit=<>     list memory items
 *   POST   /api/external/memory                            create
 *          body: { layer, title, content, authority_level?, source?, source_task_id? }
 *   PATCH  /api/external/memory/:id                        update (title, content, authority_level)
 *   DELETE /api/external/memory/:id                        delete
 *
 *   GET    /api/external/conversations?limit=<>&offset=<> list
 *   GET    /api/external/conversations/:id                 get one
 *
 *   GET    /api/external/tasks?tri_state=<>&limit=<>       list (filter by tri_state)
 *   GET    /api/external/tasks/:id                         get one
 *
 *   GET    /api/external/audit?event_type=<>&task_id=<>&since=<>
 *
 *   GET    /api/external/continuity/task/:task_id          export task bundle (text/markdown)
 *   GET    /api/external/continuity/conversation/:conv_id  export conversation bundle
 *   POST   /api/external/continuity/import                 rehydrate from a bundle
 *          body: { bundle: <text>, mode?: "merge"|"replace_thread" }
 *
 * Token management (session-auth, /api/tokens/*)
 * ──────────────────────────────────────────────
 *   GET    /api/tokens             list (masked)
 *   POST   /api/tokens             create — body: { name, scopes, expires_in_days?, power_shell_only? }
 *   POST   /api/tokens/:id/revoke  body: { reason? }
 *   GET    /api/tokens/audit       per-user audit (use /limit)
 *   GET    /api/tokens/scopes      catalog of valid scopes
 *
 * Quick examples (cURL)
 * ─────────────────────
 *   export BOS="https://bos-omega-teajr.ondigitalocean.app"
 *   export TOK="bos_AbCdEf1234567890_…"
 *   curl -s -H "Authorization: Bearer $TOK" "$BOS/api/external/me" | jq
 *   curl -s -H "Authorization: Bearer $TOK" "$BOS/api/external/memory?layer=canon&limit=20" | jq
 *   curl -s -H "Authorization: Bearer $TOK" -X POST "$BOS/api/external/memory" \
 *        -H "Content-Type: application/json" \
 *        -d '{"layer":"scratchpad","title":"From PowerShell","content":"hello","authority_level":3}' | jq
 *   curl -s -H "Authorization: Bearer $TOK" "$BOS/api/external/tasks?tri_state=HOLD&limit=5" | jq
 *   curl -s -H "Authorization: Bearer $TOK" "$BOS/api/external/audit?event_type=AUTH_LOGIN_SUCCESS" | jq
 *   curl -s -H "Authorization: Bearer $TOK" "$BOS/api/external/continuity/task/<task_id>" -o bundle.md
 *
 * Quick examples (PowerShell)
 * ───────────────────────────
 *   $env:BOS_OMEGA_TOKEN = "bos_…"
 *   $env:BOS_OMEGA_BASE  = "https://bos-omega-teajr.ondigitalocean.app"
 *   function Invoke-Bos { param([string]$Path,[string]$Method="GET",$Body)
 *     $h = @{ Authorization = "Bearer $env:BOS_OMEGA_TOKEN" }
 *     if ($Body) { Invoke-RestMethod -Uri "$env:BOS_OMEGA_BASE/api/external/$Path" -Method $Method -Headers $h -Body ($Body|ConvertTo-Json -Depth 10) -ContentType "application/json" }
 *     else       { Invoke-RestMethod -Uri "$env:BOS_OMEGA_BASE/api/external/$Path" -Method $Method -Headers $h } }
 *   Invoke-Bos -Path "memory?layer=canon"
 *   Invoke-Bos -Path "tasks?tri_state=GO&limit=5"
 */
export const API_DOCS_MARKDOWN = `# BOS-OMEGA External API

The external API lets you drive BOS-OMEGA from scripts, the local PowerShell bridge, or other AURA-OMEGA agents. All routes are under \`/api/external/*\` and require a \`Bearer\` token issued from **Settings → API Tokens**.

See \`src/lib/apiDocs.ts\` for the full reference.
`;
