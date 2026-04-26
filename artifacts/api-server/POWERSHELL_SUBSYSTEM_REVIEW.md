# POWERSHELL_SUBSYSTEM_END_TO_END_REVIEW

**Review date:** 2026-04-26
**Scope:** End-to-end audit of the cancelled Task #4 (Windows PowerShell bridge), Task #5 (PowerShell Agents Sidebar — server-side `pwsh`), Task #15 (PowerShell safety tests), Task #16 (command history), and Task #17 (auto-revoke pairing tokens) subsystems. Goal: determine whether anything ships safely today, what conflicts with the new Local Automation Agent (LAA) architecture (Tasks #21–#29, #32–#33), and how to preserve operational capability during migration.
**Method:** read-only inspection of the merged tree on `main` — full-tree ripgrep for every PowerShell-, agent-, pairing-, command-, websocket-, and SSE-related identifier; direct read of `artifacts/api-server/src/routes/index.ts`, `lib/db/src/schema/index.ts`, `lib/api-spec/openapi.yaml`, and the bos-omega frontend; cross-check against the `.local/tasks/*.md` plan files for what *was supposed to* exist.
**Posture:** read-only. No code was changed in this pass. Recommendations only.

---

## ├── Executive Summary

> **Headline:** There is nothing to review.
>
> The PowerShell subsystem (Task #4 + Task #5) was planned in detail in `.local/tasks/powershell-bridge.md` and `.local/tasks/powershell-agents-sidebar.md`, **but no code from either task was ever committed to `main`**. Every file enumerated in the task plans — the database tables, the REST routes, the WebSocket transport, the Windows agent script, the LLM `runPowerShell` tool, the frontend page, the deny-list policy engine, the audit events — is absent. Task #4 and the related Tasks #15, #16, #17 were **CANCELLED** before any implementation merged. The replacement architecture (Local Automation Agent, Tasks #21–#29 plus #32–#33) is **PROPOSED** but not yet implemented.
>
> This is the unusual case where the security and architecture verdicts are trivially clean — a non-existent subsystem cannot be exploited, cannot conflict with the new architecture, and cannot regress. The interim operational story is also trivial: there is no operational capability to preserve, because there has never been one.

### ├── Functional Status

**NULL — subsystem does not exist on `main`.**

Evidence (every check returned zero matches against committed code, excluding plan files in `.local/tasks/`, audit reports, and the unrelated `cssesc` package in `pnpm-lock.yaml`):
- `rg -i "powershell|pwsh"` against `*.{ts,tsx,yaml,json,sh}` in `artifacts/`, `lib/`, `scripts/`, and `public/`: **0 hits.**
- `rg -i "pairing|pairingToken|local.?agent|agentHeartbeat"` over the same scope: **0 hits.**
- `rg -i "websocket|EventSource|sse"` over the same scope: **0 hits in any agent context.** (No real-time transport of any kind exists in the API server today; everything is request/response REST.)
- `lib/db/src/schema/` contains 17 schema files (attachments, attempts, audit, executionRuns, fallback, memory, models, parallelAgents, providerHealth, providers, seriesPasses, synthesisReports, tasks, triStateDecisions, users, validation, index). **No** `agents`, `commands`, `pairings`, `pairing_tokens`, or `command_outputs` table exists. The `parallelAgents` table is for in-process LLM personas (ARCHITECT/CRITIC/etc.), not local execution agents — confirmed by the file's enum at line 9.
- `artifacts/api-server/src/routes/index.ts` mounts: `health`, `auth`, `tasks`, `providers`, `models`, `audit`, `memory`, `fallback`, `runs`, `triState`, `uploads`, `users`, `overrides`. **No** `agents`, `commands`, `pairing`, `ws`, or `sse` routes are registered.
- `lib/api-spec/openapi.yaml` declares no agent, pairing, or command endpoints.
- `artifacts/bos-omega/src/pages/` contains: `Login`, `TaskConsole`, `TaskDetail`, `ProviderStatus`, `ModelRegistry`, `AuditLog`, `LocalMemory`, `Settings`, `Users`, etc. **No** `Agents`, `Commands`, `PowerShell`, or `Pairing` page; no `PowerShell Agents` sidebar entry.
- `scripts/` contains only `generate-governance-pdf.mjs` and `post-merge.sh`. **No** `.ps1` installer, no Windows agent script.

### ├── Security Status

**N/A — no attack surface.**

There is no code path that can execute a shell command, no inbound socket from an external paired agent, no token exchange endpoint, no approval queue, and no LLM tool that can invoke local execution. Every threat enumerated in the OBJECTIVE block of the directive (arbitrary command execution, raw shell passthrough, approval bypass, replay/signing weakness, cross-agent injection, audit gaps, transport gaps, multi-tenant isolation) requires a code path that does not exist.

### ├── Architectural Status

**No conflict with the new LAA architecture, because nothing exists to conflict.**

The LAA task series (#21–#29, #32–#33) is the proposed implementation of the same product capability, redesigned from scratch with a stricter contract (signed requests, tamper-evident audit, policy engine, paired-approval queue, multi-user/enterprise hooks). It does not need to migrate or refactor anything — it is a greenfield build inside an empty namespace. The risk usually associated with replacing an unsafe subsystem (data migration, dual-running, shimming, lock-in) does not apply here.

### ├── Interim Ship Recommendation

**DISABLE (already disabled — nothing exists).**

There is no interim operational capability to preserve. The directive's mandatory constraint ("PowerShell/local execution capability remains a required feature… do not recommend removal without replacement path") is honored by the LAA replacement plan (Tasks #21–#29 + #32–#33), which is the agreed forward path.

If the user genuinely needs a thin temporary capability before the LAA lands — for their own operational use, super-admin only — that is a **separate product decision**, not a finding from this audit. The plan file for Task #5 (`.local/tasks/powershell-agents-sidebar.md`, server-side `pwsh` execution scoped to the API container) describes such a capability, but Task #5 is currently not active and its security model is materially different from the LAA's. Restarting it would be a deliberate scope re-opening, not a continuation of existing work.

---

## ├── Functional Validation Matrix

Every row in the original directive's "Functional End-to-End Review" list, validated against the actual tree.

| Feature | Status | Evidence | Defects |
|---|---|---|---|
| Pairing flow | **NOT IMPLEMENTED** | No `pair_code` table, no pair-code generator endpoint, no `POST /api/pair` route in `routes/index.ts`. | N/A — feature absent |
| Agent registration | **NOT IMPLEMENTED** | No `agents` schema in `lib/db/src/schema/`. No `POST /api/agents` route. | N/A |
| Agent reconnect / revoke / unpair | **NOT IMPLEMENTED** | No agent registry, no socket map, no revoke endpoint. | N/A |
| Command creation | **NOT IMPLEMENTED** | No `commands` table, no `POST /api/commands` route. | N/A |
| Approval / rejection / cancel flow | **NOT IMPLEMENTED** | No approval-queue page in frontend, no state-machine code in api-server. | N/A |
| WebSocket / SSE real-time updates | **NOT IMPLEMENTED** | `ws`, `socket.io`, `eventsource` are not in `package.json` dependencies of `api-server`. No upgrade handler in `app.ts`. | N/A |
| Output streaming / chunking | **NOT IMPLEMENTED** | No streaming response code path; all routes are JSON request/response. | N/A |
| Heartbeat / stale detection | **NOT IMPLEMENTED** | No background timer or cleanup job in `app.ts` or `index.ts`. | N/A |
| LLM tool invocation path | **NOT IMPLEMENTED** | The LLM adapters in `artifacts/api-server/src/providers/` do not register any tool/function-calling capability beyond plain text completion. No `runPowerShell`, no `runShell`, no `tool_use` integration. | N/A |
| Tool-marker parsing | **NOT IMPLEMENTED** | No tool-marker parser in `bos/`. Validation engine parses BOS-schema JSON only. | N/A |
| Multi-agent targeting | **NOT IMPLEMENTED** | No agent registry to target. | N/A |
| Timeout / cancellation behavior | **NOT IMPLEMENTED** | No long-running command processes; only LLM-call timeouts exist (provider adapters). | N/A |
| Audit event generation (PowerShell-specific) | **NOT IMPLEMENTED** | `bos/auditEngine.ts:46-50` event union does not include any `COMMAND_*`, `AGENT_*`, or `PAIRING_*` events. | N/A |
| Script download / install / uninstall flow | **NOT IMPLEMENTED** | No `public/agent.ps1`, no installer route, no download endpoint. | N/A |

**Summary: 14/14 features absent.** The functional verdict is unambiguous: there is no subsystem to validate.

---

## ├── Security Review

There is no PowerShell-specific code to attack. The general application-level security findings still in play come from the prior audits (`AUDIT_REPORT.md` and `POST_MERGE_AUDIT.md`) and are unrelated to PowerShell. For completeness, a sanity table:

| Finding | Severity | Impact | Exploitability | Fix |
|---|---|---|---|---|
| Arbitrary command execution exposure | **NONE** | No code path executes shell commands. | Not exploitable — no surface. | No action |
| Raw shell passthrough risk | **NONE** | No `child_process.exec`, `child_process.spawn`, or equivalent in `artifacts/api-server/src/`. (Verified by `rg -n "child_process|spawn|exec\(" artifacts/api-server/src/`.) | Not exploitable — no surface. | No action |
| Approval bypass vector | **NONE** | No approval queue exists. | Not exploitable — no surface. | No action |
| Policy parser weakness | **NONE** | No policy parser exists. | Not exploitable — no surface. | No action |
| Replay / signing / auth weakness on agent channel | **NONE** | No agent channel. | Not exploitable — no surface. | No action |
| Cross-command / cross-agent injection | **NONE** | No commands, no agents. | Not exploitable — no surface. | No action |
| Audit integrity gap (PowerShell-specific) | **NONE** | No PowerShell audit events to lose. | Not exploitable. | No action |
| Transport security gap (agent WebSocket) | **NONE** | No agent transport. | Not exploitable. | No action |
| Pairing / token trust model weakness | **NONE** | No pairing or token flow. | Not exploitable. | No action |
| Multi-user / tenant isolation in PowerShell context | **NONE** | No PowerShell context. | Not exploitable. | No action |

**Net security risk introduced by the cancelled subsystem: zero.** The cancellation eliminated the risk before it could ship.

> One non-finding worth recording: the LAA architecture proposed in Tasks #21–#29 is the *correct* place to address every line item above. Designing them in from day one — signed requests (Task #22), tamper-evident audit (Task #22), policy engine (Task #21), pairing + approval queue (Task #23), spec test matrix and ship-gate (Task #25) — is materially safer than retrofitting them onto a half-built Task #4 codebase.

---

## ├── Architecture Compatibility Matrix

Every component named in the Task #4 / Task #5 plan files, classified against the current state of the tree and the LAA replacement plan.

| Component | Compatibility Status | Migration Path | Notes |
|---|---|---|---|
| `agents` DB table | **N/A — DOES NOT EXIST** | LAA Task #21 (schema, contracts & policy engine) defines the replacement schema from scratch. | No migration needed — there is no row to migrate. |
| `commands` DB table | **N/A — DOES NOT EXIST** | LAA Task #21. | Greenfield. |
| `pairing_tokens` DB table | **N/A — DOES NOT EXIST** | LAA Task #23 (pairing, approval queue, audit UI). | Greenfield. |
| `command_outputs` / chunked-output store | **N/A — DOES NOT EXIST** | LAA Task #22 (API, signed requests & tamper-evident audit). | Greenfield. |
| `POST /api/pair`, `POST /api/agents/:id/exchange` | **N/A — DOES NOT EXIST** | LAA Task #22. | Greenfield. |
| `WS /api/agents/:id/socket` | **N/A — DOES NOT EXIST** | LAA Task #22 chooses transport; WS is not committed. | The LAA spec explicitly evaluates transport options rather than inheriting one. |
| `runPowerShell` LLM tool | **N/A — DOES NOT EXIST** | LAA Task #22 defines tool-call surface; tool name and schema not yet finalized. | Re-evaluate naming; `runPowerShell` is Windows-flavored, the LAA aims to be cross-platform. |
| Deny-list policy engine | **N/A — DOES NOT EXIST** | LAA Task #21. | LAA design uses an allowlist-first policy, not a denylist. Task #4's denylist approach is **incompatible** with LAA — denylists are unsafe by default. |
| Approval queue UI | **N/A — DOES NOT EXIST** | LAA Task #23. | LAA queue is per-tenant + signed; Task #4 plan was per-user only. |
| Windows agent (`.ps1` + installer) | **N/A — DOES NOT EXIST** | LAA Tasks #26–#29 (Windows-only, currently `BLOCKED-ENV`). | Out of reach until Windows build env is available. Reference test agent (Task #24) covers the contract on Linux. |
| Sidebar entry "PowerShell Agents" | **N/A — DOES NOT EXIST** | LAA Task #23 provides the audit UI; sidebar entry will be added there. | The "PowerShell" branding from Task #5 conflicts with the LAA's cross-platform framing — recommend the LAA UI use a neutral name (e.g. "Local Agents" or "Automation"). |
| Audit events `COMMAND_*` / `AGENT_*` / `PAIRING_*` | **N/A — DOES NOT EXIST** | LAA Task #22 + #25 (spec test matrix & ship-gate). | The existing `auditEngine` event union (`bos/auditEngine.ts:46-50`) will need to be extended; the union is already designed to be extended (a discriminated union of literal-string event types). |
| Heartbeat + auto-reconnect logic | **N/A — DOES NOT EXIST** | LAA Task #22 (server) + Task #24 (reference agent). | Greenfield. |
| Secret-shaped redaction in output | **N/A — DOES NOT EXIST** | LAA Task #22. | Greenfield. The same redaction utility could later be reused for the Local Memory injection path (cross-cutting). |
| Server-side `pwsh` runtime (Task #5) | **N/A — DOES NOT EXIST** | Currently no LAA task covers in-container `pwsh` execution; LAA is "out-of-process agent on the user's machine." If server-side execution is also wanted, it is a **separate product decision**, not covered by the LAA series. | See "Migration / Replacement Plan" → "Replace" below. |

**Summary: 0 components migrate, 0 components refactor, 0 components conflict — because 0 components exist.** Every row resolves to "greenfield in the LAA series."

---

## ├── Interim Hardening Recommendations

### Required Immediate Changes

**None.** Hardening a non-existent subsystem is a no-op. The only immediate action is documentation hygiene: ensure no developer or future agent assumes the PowerShell capability already exists on `main`. That has been addressed inline in this review by updating `replit.md` (see follow-up note below).

### Feature Flags / Restrictions

**N/A.** There is no feature to flag.

### Temporary Safeguards

**N/A.** There is no surface to safeguard.

> If the user later decides to ship a tightly-scoped server-side `pwsh` capability as a stopgap before the LAA lands (the cancelled Task #5 design), the bare-minimum guardrails from that plan should be applied at build time, not retrofitted: super-admin only, allowlist-first policy, hard timeout, capped output, scrubbed env, non-root subprocess, secret-shaped redaction at persistence. This is captured here for reference; it is not a recommendation to do so.

---

## ├── Migration / Replacement Plan

### Preserve

**Nothing to preserve.** The cancelled tasks left no working capability behind.

### Refactor

**Nothing to refactor.** There is no code to refactor.

### Replace

The full feature is being replaced by the **Local Automation Agent (LAA)** task series, already proposed:

| Task | Title | Role in replacement |
|---|---|---|
| #21 | LAA — schema, contracts & policy engine | Defines `agents`, `commands`, `policies` schema and the allowlist-first policy engine that Task #4's denylist approach would have failed to provide. |
| #22 | LAA — API, signed requests & tamper-evident audit | Defines the agent transport, request signing (replaces Task #4's untyped HMAC-handwave), and audit chain. |
| #23 | LAA — pairing, approval queue & audit UI | Replaces Task #4's pairing flow + approval queue with a per-tenant version. |
| #24 | LAA — reference test agent + gated dev console | Provides a Linux reference agent so the LAA contract can be validated end-to-end without a Windows host, replacing Task #4's "ship the agent then test" ordering. |
| #25 | LAA — spec test matrix & ship-gate checks | Replaces Task #15's "PowerShell safety tests" with a broader contract + safety matrix, gated on every PR. |
| #26 | Windows native local agent | Windows build of the agent; currently `BLOCKED-ENV`. |
| #27 | System tray UI + native approval prompts | Native Windows UX; currently `BLOCKED-ENV`. |
| #28 | UAC elevation broker | Privileged-action broker; currently `BLOCKED-ENV`. |
| #29 | Signed MSI installer + auto-update + uninstall | Replaces Task #4's `.ps1` installer with a signed MSI, plus update/uninstall lifecycle. Currently `BLOCKED-ENV`. |
| #32 | LAA — multi-user & enterprise hooks (architecture) | Per-tenant scoping, audit feeds, role gating — covers the multi-user gap in Task #4's plan. |
| #33 | LAA — master orchestration & crosswalk | Sequencing + integration view across the LAA series. |

### Sequence

The LAA series already sequences itself via task dependencies (#33 is the orchestration task; #26–#29 are blocked on Windows-env availability). No re-sequencing is recommended from this review.

The Linux-reachable subset (#21, #22, #23, #24, #25, #32, #33) can proceed independently. The Windows-blocked subset (#26–#29) is correctly held until a Windows build environment is available; nothing in the Linux subset blocks on Windows.

If a stopgap server-side `pwsh` capability is wanted before #21–#25 land, the cancelled Task #5 plan (`.local/tasks/powershell-agents-sidebar.md`) is the minimum viable specification — but resurrecting it is a separate product decision, not a finding of this audit.

---

## └── Final Recommendation

**`DISABLE` (already disabled — nothing exists to disable).**

Continue with the proposed Local Automation Agent task series (#21–#29 + #32–#33) as the sole forward path for delivering the required PowerShell / local-execution capability. There is no interim PowerShell capability on `main` to preserve, harden, or feature-flag, because none was ever shipped — Task #4 and its companions were cancelled before any code merged.

The four `KEEP_*` options in the directive's recommendation enum (`KEEP_INTERIM`, `KEEP_WITH_HARDENING`, `DEV_ONLY`, `DISABLE`) reduce to `DISABLE` by default when there is nothing to keep. That is the recommendation.

---

## Items the audit explicitly checked and found clean

To keep this report honest:

- **Routes index** (`artifacts/api-server/src/routes/index.ts`) is fully clean — no agent/command/pairing routes leaked in, no dead imports for cancelled subsystems.
- **Database schema index** (`lib/db/src/schema/index.ts`) is fully clean — no orphan agent/command/pairing tables left over from the cancelled task.
- **OpenAPI spec** (`lib/api-spec/openapi.yaml`) is fully clean — no orphan endpoints documented for the cancelled subsystem.
- **Frontend pages and sidebar** are fully clean — no orphan "PowerShell" route, no broken sidebar entry, no dead imports.
- **No `child_process` usage** anywhere in `artifacts/api-server/src/` — the API server has no current path to spawn local processes of any kind, which is the strongest possible attestation that the cancelled subsystem left no foothold.
- **`pnpm-lock.yaml` `cssesc` and similar regex hits** during the audit are unrelated (CSS escape utility for `postcss-selector-parser`), not PowerShell or pairing.

---

## Out of scope

- The Local Automation Agent design itself (#21–#29, #32–#33) — that is its own design review.
- The general application security findings already documented in `AUDIT_REPORT.md` and `POST_MERGE_AUDIT.md`.
- Any decision to revive Task #4 or Task #5; this audit only assesses what exists today and the migration story for it.
- Any code changes — read-only by directive scope.
