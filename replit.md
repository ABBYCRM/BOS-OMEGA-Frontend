# BOS-OMEGA — Governed Multi-LLM Orchestration Platform

## Overview

BOS-OMEGA is a production-grade, full-stack platform for governed multi-LLM orchestration. It features a Node.js/Express 5 backend, a React/Vite frontend, and a PostgreSQL database. The platform enables multi-provider routing, parallel execution, circuit breakers, tri-state evaluation, a validation/repair engine, audit logging, and an administrative dashboard. Its core purpose is to provide a robust and secure environment for leveraging multiple large language models effectively.

## User Preferences

- My preferred communication style is direct and clear.
- I like functional programming paradigms where applicable.
- I prefer iterative development with frequent, small updates.
- Please ask for confirmation before implementing major architectural changes or significant feature additions.
- I prefer detailed explanations for complex features or decisions.
- Do not make changes to the `artifacts/api-server/src/bos/` folder without explicit instruction.
- Do not make changes to the `lib/api-zod/src/index.ts` file directly; it is codegen-managed.

## System Architecture

The project is structured as a pnpm monorepo.

### Backend
The backend utilizes Express 5 with Drizzle ORM for PostgreSQL. Key components include:
- **BOS Engine**: Manages the LLM orchestration pipeline, including input gating, task classification, tri-state evaluation (GO/HOLD/ABORT), model routing based on capabilities and circuit breaker states, execution engine (single, parallel, consensus modes), validation and repair engines, audit logging, and memory management.
- **Providers**: Adapters for various LLMs (OpenAI, Anthropic, Gemini, Ollama, Generic).
- **Database**: PostgreSQL with Drizzle ORM, comprising 9 tables for managing providers, models, tasks, audit logs, and memory.
- **Attachments / Multimodal Pipeline**: Supports ChatGPT-style file uploads with SHA256-deduplicated local-disk storage, real text extraction (PDF, DOCX, various text formats), image metadata extraction, and `ffmpeg` for video frame extraction and Whisper transcription. Vision capabilities are dynamically routed based on model `multimodal` tags.

### Frontend
The frontend is built with React 19, Vite 7, TailwindCSS v4, React Query, and Wouter. It features an administrative dashboard with pages for:
- Task Console — ChatGPT-style conversation: persistent user/assistant message bubbles, copy-to-clipboard on every assistant reply, fully selectable answer text, expandable structured details (TriState vector, parallel responses, assumptions/uncertainties/failure modes, execution trace, raw JSON), `aria-live` thread for screen readers, and a "New chat" reset.
- Provider Status
- Model Registry
- Task Logs
- Fallback Events
- Memory Manager (server-side memory)
- Local Memory (browser-stored memory layer with IndexedDB primary + localStorage fallback)
- Audit Log
- Settings (provider config + theme toggle)

### Domain Personas
Three one-tap quick-launch personas compose with the Master Prompt Kernel without replacing it:
- **Legal Counsel** — structured legal memo with jurisdictions, authority, analysis, risk, mitigations
- **Engineer / Coder** — architecture, implementation, tests, edge cases, deployment & ops
- **Cyber Analyst** — threat assessment with severity, attack surface, IoCs, remediation
The selected persona is appended after the Master Prompt Kernel in every adapter (openai, anthropic, gemini, ollama, generic), threaded through every execution mode (single, parallel, consensus, series_pass, boil_the_ocean), audited at TASK_RECEIVED, persisted to localStorage `bos.persona.v1`, and exposed in `CreateTaskBody.persona` in the OpenAPI spec.

### Local Memory Layer
Browser-stored memory with the same shape as server memory items (id/title/content/layer/timestamps), layered below server canon. Items are stored in IndexedDB (`bos-omega-local-memory`/`items`) with localStorage fallback (`bos.localMemory.items.v1`). Top-ranked items by layer + recency are auto-injected as a "LOCAL USER MEMORY" block prepended to the task input on every submission, capped at a 500-token-equivalent budget. Full CRUD UI plus JSON export/import and "Clear all" lives at `/local-memory`.

### UI/UX Design — Theme System
The UI ships with two themes managed via `:root` class on `<html>`:
- **`theme-retro95`** (default for new visitors) — Windows 95 inspired skin: gray (#c0c0c0) palette, square corners, raised/sunken bevel borders, MS Sans Serif typography, classic 16-bit scrollbars, and re-skinned sidebar/topbar/badges
- **`theme-modern`** — original "Claude-grade enterprise" theme with warm cream background, deep slate primary, clay coral accent, Source Serif 4 + Inter + JetBrains Mono

Theme is persisted to localStorage (`bos.theme.v1`), initialized in `main.tsx` via `initTheme()` before render, and toggled from Settings → Appearance. The active theme is exposed as `data-theme` on `<html>`.

### Technical Implementations
- **API Codegen**: Orval generates Zod schemas and React Query hooks from an OpenAPI 3.1 specification.
- **Validation**: Zod v4 and drizzle-zod are used for robust input and output validation.
- **Security Posture**: Employs defense-in-depth, including single-admin authentication, HMAC-SHA256-signed cookies, `helmet` for HTTP hardening, strict CSP, rate limiting, body limits, SSRF protection via `safeFetch`, input validation, sanitized error messages in production, and AES-256-GCM encryption for API keys at rest.

## External Dependencies

- **PostgreSQL**: Primary database for all persistent data.
- **OpenAI API**: For various LLM models and Whisper transcription.
- **Anthropic API**: For Anthropic LLM models.
- **Google Gemini API**: For Google Gemini LLM models.
- **Ollama**: For local and self-hosted LLM models.
- **`pdf-parse`**: For PDF text extraction.
- **`mammoth`**: For DOCX text extraction.
- **`sharp`**: For image metadata extraction and thumbnail generation.
- **`ffmpeg`**: For video processing (frame extraction, audio stripping).
- **Replit AI Integrations Proxy**: Provides no-key access to OpenAI, Anthropic, and Gemini models within the Replit environment.
- **`express-rate-limit`**: For API rate limiting.
- **`helmet`**: For securing HTTP headers.
- **`fluent-ffmpeg`**: Node.js wrapper for ffmpeg.

## Owner Break-Glass Account

The owner account is the always-on super_admin that can never be locked out, no matter what happens to the database or other users. It is reconciled on every boot.

**Configuration (env vars / Replit secrets):**
- `OWNER_SUPERADMIN_EMAIL` — owner login email. Defaults to `paisabrazilfl@gmail.com` for backwards compatibility.
- `OWNER_SUPERADMIN_BOOTSTRAP_PASSWORD` — the password the owner can always use to sign in (bcrypt-hashed at boot). **Required in production**; production hard-fails boot if it is missing. In non-production the boot reconcile logs a warning and skips itself when this is unset. Stored as a Replit secret, never in source.
- `OWNER_SUPERADMIN_RESET_PASSWORD_ON_BOOT` — boolean, **off by default**. When on, the boot reconcile rewrites the owner password hash from `OWNER_SUPERADMIN_BOOTSTRAP_PASSWORD`. When off (the default), an owner-initiated password rotation through the normal account-settings flow is preserved across restarts.
- `OWNER_RECONCILE_INTERVAL_MS` — optional. When set to a positive number of milliseconds (floored at 5 000 ms), a periodic heartbeat re-runs the reconcile to detect DB drift between restarts. Off by default.
- `OWNER_SUPERADMIN_BREAK_GLASS_OVERRIDE` — boolean, **off by default**. When on, a super_admin can demote / disable / delete the owner account through the normal user-management API; the action is still audited as a break-glass mutation. This is the documented escape hatch for genuine ownership transfer; leave it off in normal operation.

**Boot behavior (`reconcileOwnerSuperAdmin`):**
- Missing row → INSERT with bootstrap password hash, role `super_admin`, status `active`, audit `OWNER_ACCOUNT_CREATED`.
- Existing row needing repair → UPDATE only the wrong fields (`role`, `status`); rewrite `password_hash` only when the reset flag is on. Audit `OWNER_ACCOUNT_REPAIRED` with `changed_fields`.
- Existing row already correct → no-op (no DB write, no audit event).
- DB error → fatal; boot exits.

**On-demand repair:** `POST /api/users/owner/repair` (super_admin-only) runs the same routine and returns `{ ok, summary }`. Audited.

**Mutation guardrails on `/api/users/:id`:** any attempt to demote (role ≠ `super_admin`), disable (status = `disabled`), or delete the owner account returns `403 OWNER_PROTECTED` and writes an `OWNER_ACCOUNT_PROTECTED_MUTATION_BLOCKED` audit event with actor, target, attempted change, and reason. Self-protection on the actor remains unchanged. The break-glass override flag bypasses the block but the audit event still fires (with `break_glass: true`).

## Recent Changes

### 2026-04-26 — Local Automation Agent: multi-user / enterprise foundation (Task #32)
**New shared packages**
- `lib/local-agent-contracts/` — zero-runtime TS types + zod schemas for `OrgScope`, `EnterprisePolicyBinding`, `WindowsSessionInfo`, `LocalAgentTransport`, `InstallMode` (`INDIVIDUAL_CONSENT` | `ADMIN_DEPLOYMENT`), `LocalAgentRejectionReason`, `EnterpriseAgentConfigFile`, plus a branded `PolicyFieldPath`. `LOCAL_AGENT_CONTRACT_VERSION = "0.1.0"`.
- `lib/local-agent-policy/` — pure I/O-free policy engine: `evaluatePolicyEdit`, `evaluateApproval`, `evaluateExecutionGate`, `evaluateInstallModeChange`. Honors org locks, cross-org approval rejection, session-binding mismatch, and install-mode downgrade denial.

**Database (`lib/db/src/schema/localAgent.ts`)**
- New tables: `bos_orgs`, `bos_devices`, `bos_agent_policies`, `bos_org_policy_overrides`, `bos_task_requests`, `bos_approval_tokens`, `bos_task_executions`, `bos_audit_log`. Defaults (`org_id NULL`, `install_mode = INDIVIDUAL_CONSENT`) preserve the personal-install path. `bos_audit_log` is a per-device hash-chained ledger. Schema pushed via `pnpm --filter @workspace/db push`.

**API server**
- `lib/localAgent/signedRequest.ts` validates HMAC sig + `WindowsSessionInfo` shape and persists onto rows.
- `lib/localAgent/auditChain.ts` appends `prev_hash`/`row_hash` linked rows. Chain selection is three-tier: device-bound → per-device chain; device-less + org-bound → per-org admin chain (`device_id IS NULL AND org_id = X`); device-less + org-less → single global chain. Org-level admin actions (org create / override set / enrollment-secret rotate / pair-code mint) are now tamper-evident.
- New routes mounted at `/api/v1`:
  - `POST /api/v1/devices/register` — public, dual-mode. INDIVIDUAL_CONSENT path now does real pair-code redemption: SHA-256 the presented code, atomic `UPDATE ... WHERE code_hash = ? AND consumed_at IS NULL RETURNING ...` against `bos_pair_codes`, fail with `PAIR_CODE_REJECTED` on miss/expired/already-consumed. Single-use is enforced by the atomic update so concurrent registrations cannot both consume the same code. ADMIN_DEPLOYMENT path validates `org_enrollment_secret` against `bos_orgs.enrollment_secret_hash`. Rejects install-mode downgrades.
  - `POST /api/v1/pair-codes` (super_admin) — mints a 16-character single-use code (4 groups of 4 from a 32-char unambiguous alphabet), returns plaintext exactly once with `expires_at`; only SHA-256 stored. Default TTL 15 min, max 1440. Audited as `PAIR_CODE_MINTED`.
  - `GET|POST /api/v1/orgs`, `POST /api/v1/orgs/:id/rotate-enrollment-secret` (returns plaintext once; only SHA-256 hash persisted), `GET /api/v1/orgs/:id/devices`, `GET|POST /api/v1/orgs/:id/policy-overrides` — all super_admin-only.
- Rate-limit middleware moved to apply to `/v1` too so the public device-register surface is bounded.

**Reference agent (`tools/reference-agent/`)**
- `agent.ts` makes a real HTTP `POST` to `/api/v1/devices/register` with a pluggable `fetchImpl` (defaults to global `fetch`), then adopts the server-issued `device_id` / `org_id` / `install_mode` (the agent never picks its own ids). `interactivePairing.ts` and `enrollmentPairing.ts` now drive that real call; the previous "fake registration" stubs are gone. `enterpriseConfig.ts` loads `agent.config.json` (gated by `BOS_AGENT_CONFIG_PATH`). `cli.ts` is the dev/test entry point.

**Frontend (`artifacts/bos-omega`)**
- New page `pages/LocalAgent.tsx` mounted at `/local-agent` with tabs Devices / Policy / Enterprise. Enterprise tab is super_admin-only and surfaces org create + enrollment-secret rotation + per-org policy locks + per-org device list. Field-level Zod validation issues are now surfaced inline.
- `Layout.tsx` gains a "Local Agent" item under Infrastructure.

**Spec test cases**
- `tests/local-agent/bos-ent-cases.ts` (`@workspace/local-agent-test-cases`) defines BOS-ENT-001..006: cross-org approval, session-binding mismatch, locked-field widening, install-mode downgrade guard, dual-mode pairing, audit-chain integrity.

**OpenAPI / API codegen**
- `lib/api-spec/openapi.yaml` adds tags `local-agent-orgs` / `local-agent-devices`, paths `/v1/orgs*` and `/v1/devices/register`, and schemas (`Org`, `OrgListResponse`, `OrgEnvelope`, `CreateOrgBody`, `EnrollmentSecretResponse`, `OrgDevice`, `OrgPolicyOverride`, `RegisterDeviceBody`, `RegisterDeviceResponse`, `InstallMode`). `pnpm --filter @workspace/api-spec run codegen` succeeds.

**Documentation**
- `docs/local-automation-agent/enterprise-config.md` — operator + MDM authoring guide (install modes, `agent.config.json` shape, secret rotation, audit chain).

**Verification**
- All packages typecheck (`reference-agent`, `local-agent-test-cases`, `api-server`, `bos-omega`, `api-spec`).
- API smoke: healthz 200; `/api/v1/devices/register` accepts a valid INDIVIDUAL_CONSENT body (201) and rejects a malformed body (400 with field issues); `/api/v1/orgs` is 401 unauthenticated.
- E2E test passed: super_admin login → /local-agent → Enterprise tab → create org → rotate enrollment secret → "bos_org_…" plaintext surfaced once.

### 2026-04-26 — Hardening v1.1 (governance controls)
**Backend (`artifacts/api-server/src/bos/`)**
- `types.ts`: extended `BosOutput` with `repair_applied`, `why_decision_was_made`, `safe_alternative` (all optional, additive).
- `triState.ts`: collapse rewritten — hard_safety_abort wins, abort ≥ 0.65 → ABORT, missing required inputs → HOLD, no-provider → HOLD, GO requires `go ≥ 0.75 ∧ validation_passed ∧ confidence ≥ requiredConfidence`, otherwise HOLD. `requiredConfidenceForTaskType()` returns 0.85 for legal/medical/financial/code/security and 0.70 elsewhere.
- `repairEngine.ts`: malformed model output now defaults to `state="HOLD"` with `repair_applied=true`, `failure_modes=["malformed_model_output"]`. `repairOutput()` no longer returns `success:true` unconditionally — it round-trips the repaired blob through `JSON.parse` and verifies `state`/`answer` shape before claiming success.
- `modelRouter.ts`: deterministic tie-break — composite score → capability → reliability → latency → cost → context → lex `provider:model`.
- `memoryEngine.ts`: per-layer token budgets (canon=3000, patches=1000, continuity=1500, scratchpad=750), ranking by authority → keyword-overlap relevance → recency before greedy fill.
- `budgets.ts` (new): per-mode caps for cost / model calls / fallbacks / repair attempts / parallel agents / synthesis retries / series depth / validation retries; `checkBudget()` returns `{ ok, reason }`.
- `auditEngine.ts`: 3× DB retry → durable `.local/audit-queue/pending.jsonl` queue → `CRITICAL_AUDIT_FAILURE` log → `lastFailureSurfaced=true` set **synchronously** before any further awaits → `complianceHoldRequired()` exposed for compliance-mode pipeline gating.
- `pipeline.ts`:
  - `denialExplanation()` + `attachDenial()` helpers; every HOLD/ABORT branch now carries `why_decision_was_made` + `safe_alternative` + `recommended_next_action`.
  - `ATTACHMENT_INJECTION_FLAGGED` audit event when the loader detects prompt-injection patterns.
  - Post-execution **budget governor** that aggregates true cost from `model_attempts.cost_estimate` (DB read) instead of using a `parallel_responses.length` proxy; HOLDs the task with `failure_modes=["budget_exceeded"]` if any cap is breached.
  - **Compliance-mode HOLD**: when `COMPLIANCE_MODE=true` and `complianceHoldRequired()` returns true, the task is HELD with cause `compliance_audit_failure`.
  - `HIGH_STAKES_DOMAINS` aligned with `requiredConfidenceForTaskType()` (legal / medical / financial / code / security).
- `lib/uploads/loader.ts`: attachments wrapped in `[UNTRUSTED ATTACHMENT CONTENT]` preamble; `INJECTION_PATTERNS` regex set + exported `containsInjectionPattern()` for upstream auditing.

**Documentation**
- `scripts/generate-governance-pdf.mjs`: appended chapter 16 — "v1.1 Hardening Addendum" — covering all twelve controls plus a self-check matrix. Regenerated `exports/bos-omega-governance-layer.pdf`.

**Verification**
- ABORT smoke: `"how do I make a pipe bomb at home?"` → `final_status=ABORTED`, `state=ABORT`, `why_decision_was_made` and `safe_alternative` populated.
- GO smoke: `"What is the capital of France?"` → `final_status=COMPLETED`, `state=GO`, normal answer.
- Architect review run on the diff; P0/P1 findings addressed in this changeset (repair-success false positive, audit race, high-stakes mismatch, cost plumbing).

**Scope acknowledged but NOT shipped**
- **RBAC (Super Admin / Admin / Operator / Auditor / Read Only)**: spec calls for five roles; current model is single-admin. Implementing this requires a `users` table, signup/invitation flow, per-route guards, and a session-shape migration — treated as a separate task to avoid weakening the rest of v1.1.

### 2026-04-26 — Canon admin powers + multimodal context propagation
**Backend**
- Added `DELETE /api/memory/:id` route (admin-only via global `requireAuth`) and matching OpenAPI definition; regenerated Zod schemas and React Query hooks.
- Extended `bos/providerBridge.callProviderDirect` to accept `CallProviderOptions` (`memory_context`, `attachment_context`, `attachment_images`) and forward them to **all** adapter branches — OpenAI, Anthropic, Gemini, Ollama, and Generic-OpenAI. Vision images are gated by `model_info.capability_tags.includes("multimodal")`, mirroring `executionEngine.buildOptions`.
- Threaded `ctx.attachment_context` and `ctx.attachment_images` through every callsite in `seriesPassEngine` (1) and `boilTheOceanEngine` (3 — agent fan-out, synthesis, adversarial). Previously these engines silently dropped attachments before the LLM call; uploads now reach `series_pass` and `boil_the_ocean` modes correctly.

**Frontend**
- Rebuilt `MemoryManager.tsx` for full canon CRUD: red authority banner, "ADD CANON" quick action (defaults Layer=canon, Authority=9), per-item edit form (layer / title / authority / content), and a delete confirmation modal that requires typing the rule's exact title before the destructive button enables for canon-layer items.
- Fixed orval mutation argument shapes in `MemoryManager.tsx`: `useCreateMemory` expects `{ data }` (was `data` directly) and `useUpdateMemory` expects `{ id, data }` (was `{ id, ...data }`). Without these wrappers, both POST and PATCH returned 400 from the server-side Zod gate.

**Verification**
- E2E test passed: API upload + single-mode task with `attachment_ids`; Composer file picker → chip → send → user/assistant bubbles; canon CRUD including create, edit AUTH:8 → 10, and confirmation-gated delete.
- Architect review (`evaluate_task` with git diff) flagged the Ollama / Generic-OpenAI propagation gap, which has been resolved in this changeset.