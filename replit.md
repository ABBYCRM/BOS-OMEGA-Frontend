# BOS-OMEGA — Governed Multi-LLM Orchestration Platform

## Overview

BOS-OMEGA is a production-grade, full-stack platform for governed multi-LLM orchestration. It enables multi-provider routing, parallel execution, circuit breakers, tri-state evaluation, validation/repair, audit logging, and an administrative dashboard. The platform's core purpose is to provide a robust and secure environment for leveraging multiple large language models effectively for various domain-specific tasks.

## User Preferences

- My preferred communication style is direct and clear.
- I like functional programming paradigms where applicable.
- I prefer iterative development with frequent, small updates.
- Please ask for confirmation before implementing major architectural changes or significant feature additions.
- I prefer detailed explanations for complex features or decisions.
- Do not make changes to the `artifacts/api-server/src/bos/` folder without explicit instruction.
- Do not make changes to the `lib/api-zod/src/index.ts` file directly; it is codegen-managed.

## System Architecture

The project is structured as a pnpm monorepo, utilizing a Node.js/Express 5 backend, a React/Vite frontend, and a PostgreSQL database.

### Backend

The backend uses Express 5 with Drizzle ORM. The core component, the **BOS Engine**, manages the LLM orchestration pipeline, including input gating, task classification, tri-state evaluation (GO/HOLD/ABORT), model routing, execution (single, parallel, consensus modes), validation and repair, audit logging, and memory management. It includes adapters for various LLMs (OpenAI, Anthropic, Gemini, Ollama, Generic). The system supports multimodal pipelines for attachments, including text extraction (PDF, DOCX), image metadata, and video frame/audio transcription via `ffmpeg`.

### Frontend

The frontend is built with React 19, Vite 7, TailwindCSS v4, React Query, and Wouter. It features an administrative dashboard with pages for:
- **Task Console**: A ChatGPT-style conversation interface with persistent messages, structured details, and accessibility features.
- **Management Panels**: Provider Status, Model Registry, Task Logs, Fallback Events, Memory Manager (server-side and local browser storage), Audit Log, and Settings.

### Domain Personas

Three one-tap quick-launch personas (Legal Counsel, Engineer/Coder, Cyber Analyst) compose with the Master Prompt Kernel, providing structured outputs for specific domains.

### Local Memory Layer

Browser-stored memory (IndexedDB/localStorage) mirrors server memory items and is layered below server canon. Top-ranked items are prepended to task inputs, capped at a 500-token equivalent budget. A full CRUD UI for local memory is available.

### Image Generation & Edit (Task #83 + Task #84)

The pipeline detects vanilla image-generation prompts ("generate an image of a red sneaker") via `detectImageIntent` and edit follow-ups ("make it blue", "remove background", "in a watercolor style") via `detectImageEditIntent` (`artifacts/api-server/src/bos/imageIntent.ts`). The edit branch fires before the generation branch but only consumes the input when the active conversation has a prior `generated_attachment` task — otherwise it falls through. Both routes flow through `imageProviderBridge.ts` which plans attempts across enabled image-capable providers (OpenAI gpt-image-1 via `/images/generations` or `/images/edits`, Gemini image preview via `generateContent` with inline_data parts) and falls back to a deterministic mock PNG when no live API key is configured. Each completed image persists via `ingestUpload` and writes a full audit chain (`IMAGE_REQUESTED`/`GENERATED`/`FAILED` for new images, `IMAGE_EDIT_REQUESTED`/`COMPLETED`/`FAILED` for refinements). Edited attachments carry `parent_attachment_id`, `parent_storage_path`, and `parent_mime` on the `GeneratedImageRef`, which the chat UI uses to render the original→edited pair side by side with `BEFORE` / `EDITED` badges. An "Edit this" affordance under each generated image dispatches a `bos:edit-image` window event that pre-fills the composer with `Edit this image to ` so the user can chain follow-up refinements. Tests: `tests/image_edit_intent_unit.mjs` (30 cases) + `tests/image_edit_e2e.mjs` (6 cases) on top of the pre-existing `image_generation_unit.mjs` / `image_generation_e2e.mjs`.

### Cross-AI Continuity Bundle (Task #64)

Server-side, hash-verified text format (`bos-omega.continuity-bundle.v1`) for moving a single task or whole conversation between AIs or BOS-OMEGA workspaces. The bundle is a human-readable header (canon hash + summary, persona slot, layer budgets, scratchpad, continuity, turns) with a fenced JSON trailer carrying a SHA-256 fidelity hash over the canonicalised payload. The serializer/parser lives in `artifacts/api-server/src/bos/continuityBundle.ts`; its helpers (`canonicalJSON`, `sha256Hex`, `computeFidelityHash`) are intentionally inlined so the unit-test runner can exercise the module without dragging the `@workspace/db` resolver chain. HTTP endpoints (`/api/continuity-bundle`, `/preview`, `/import`) are in `routes/continuityBundle.ts`. Imports are user-scoped and transactional: scratchpad/continuity rows upsert under the importer's user_id (canon is never touched), and rehydrated turns are inserted as new tasks under a freshly created "Imported …" conversation. UI surfaces: TaskConsole header (Copy bundle + Rehydrate), TaskDetail header (Copy + Resume in console), TaskLogs (Resume column), Local Memory page (Rehydrate card + docs blurb). A live `ScratchpadPanel` on TaskConsole/TaskDetail lists task-scoped scratchpad rows and supports pin/edit/delete; the panel auto-refreshes when a task completes. Round-trip coverage: `tests/continuity_bundle_unit.mjs` (20 cases) and `tests/continuity_bundle_e2e.mjs` (14 cases against a live server).

### UI/UX Design

The UI ships eleven instantly-swappable themes registered in `artifacts/bos-omega/src/lib/theme.ts` and rendered as `:root.theme-<id>` blocks in `artifacts/bos-omega/src/index.css`: `retro95` (default Win95 bevels), `retro98`, `modern` (Claude/Linear/Stripe warm-cream), `cyberdine` (Terminator HUD), `umbrella` (basic crimson-on-black), `umbrella-corp` (full tactical command-console — pitch black + corporate red, hex-grid background, beveled cards, command-strip header, confidential sidebar footer, optional `public/branding/umbrella-logo.svg` override), `capybara`, `anime`, `steampunk`, `neonpunk`, and `ultraclean`. The active theme is persisted in localStorage under `bos.theme.v1` and synced across tabs. The umbrella-corp theme adds a reusable `<CorporateLogo />` (pure SVG octagonal mark with `mark` / `lockup` variants and `sm`/`md`/`lg` sizes; falls back to the inline SVG if the public override asset is missing) and CSS-gated header chips + sidebar confidential block in `Layout.tsx`. The visual switch is the only behavior change: routing, auth, RBAC, lattice/memory/provider, and BOS engine logic remain untouched.

### Technical Implementations

- **API Codegen**: Orval generates Zod schemas and React Query hooks from an OpenAPI 3.1 specification.
- **Validation**: Zod v4 and drizzle-zod ensure robust input/output validation.
- **Security Posture**: Defense-in-depth measures include single-admin authentication, HMAC-SHA256-signed cookies, `helmet` for HTTP hardening, strict CSP, rate limiting, body limits, SSRF protection, input validation, sanitized errors, and AES-256-GCM encryption for API keys at rest.
- **Governance Controls**: Hardening features include extended `BosOutput` with denial explanations, stricter tri-state evaluation, improved repair engine, deterministic model routing, per-layer token budgets for memory, robust audit engine with durable queuing, budget governors, and compliance-mode pipeline gating. Attachment content is prefixed with `[UNTRUSTED ATTACHMENT CONTENT]` and checked for injection patterns.

### Authentication & Self-Signup

Users live in the `users` table with role (`user` | `admin` | `super_admin`) and status (`active` | `disabled`). The auth router (`artifacts/api-server/src/routes/auth.ts`) exposes:

- `GET /api/auth/me` — returns current session user; `{ authenticated: false }` for pollers without a cookie (does not 401, so the SPA's poller doesn't loop).
- `POST /api/auth/login` — bcrypt verify + HMAC-SHA256-signed cookie. Rate-limited 10/15min/IP via `loginLimiter`.
- `POST /api/auth/signup` — public self-signup. Creates `role:user` / `status:active` accounts immediately. Validates email format + password length (≥ 8 chars). Returns `400 INVALID_EMAIL` / `400 WEAK_PASSWORD` / `409 EMAIL_TAKEN`. Auto-issues session cookie on success. Rate-limited 5/hour/IP via `signupLimiter`. Audit events: `AUTH_SIGNUP_SUCCESS` / `AUTH_SIGNUP_FAILED`.
- `POST /api/auth/logout` — clears the cookie.

The login page is a thin container (`artifacts/bos-omega/src/pages/Login.tsx`) that owns form state + auth mutations and renders one of two visual skins from `artifacts/bos-omega/src/pages/login/`:

- **`CleanSkin.tsx` (default)** — ultra-minimalist: centered card, "BOS · Omega" wordmark, sentence-case `Sign in` / `Create account` tabs, standard shadcn-themed inputs and primary button. Inherits the active app theme tokens.
- **`UmbrellaSkin.tsx`** — Umbrella Corporation: mouse-tracked 3D card tilt (framer-motion + CSS perspective), animated octagonal logo with red bloom, CRT scanlines, biohazard watermark, terminal-style typography, and `AUTHENTICATE` / `REQUEST CLEARANCE` tabs.

Skin selection is persisted in `localStorage["bos:loginSkin"]`. The default is `clean`. After a successful login, the container calls `skinForRole(user.role)` and writes the result back to storage — `super_admin` flips the device to `umbrella`, every other role resets it to `clean`. Both skins also expose a discreet "switch theme" button (`data-testid="button-switch-skin"`) so anyone can toggle manually for the current session/device. Behaviour is locked down by `Login.test.tsx` (5 tests covering: default skin, stored umbrella preference, manual flip persistence, super_admin → umbrella, regular user → clean).

### Self-signup Data-Leak Hardening

Pre-self-signup, the per-route visibility filters in `tasks.ts`, `audit.ts`, `runs.ts`, `fallback.ts`, `triState.ts`, and `memory.ts` returned rows where `user_id IS NULL` (or `task.user_id IS NULL`) to non-`super_admin` callers. The original assumption was that NULL-tagged rows were legacy single-admin-era data and the lone authenticated account (the bootstrap admin) should keep seeing them. Once `POST /api/auth/signup` opened the door to arbitrary `role: user` accounts, the NULL fallback became a privilege-escalation vector — any new account inherited read access to ~69 legacy admin tasks + 463 audit rows, and (via `loadOwnedMemory`) PATCH/DELETE access to 15 NULL-owned global canon memory rows.

The fix tightens every visibility predicate so non-`super_admin` callers see ONLY rows where `user_id = req.user.id`. NULL-tagged rows are reachable only via the `super_admin` unfiltered branch. Note: by existing codebase convention only `super_admin` is privileged for visibility — the `admin` role is currently filtered identically to `user` and the pre-fix code had the same shape, so this fix did not change the effective view for `admin` accounts. The `audit.ts` `nullTaskSelfClause` (NULL-task audit rows where the caller is the actor or target — login attempts, password resets, etc.) is preserved so users can still see their own auth events. The `loadOwnedMemory` mutation auth in `memory.ts` was tightened in lock-step with the read filter so the same account can no longer mutate NULL-owned canon. Regression locked down by `artifacts/api-server/tests/role_visibility_e2e.mjs` (9 tests, wired into `pnpm --filter @workspace/api-server run test`): plants NULL-tagged sentinels in tasks, audit, and memory; signs up a fresh user; asserts no read or PATCH/DELETE leaks; asserts `super_admin` still sees the legacy data. Known follow-ups (architect-flagged, lower priority): orphan `task_id IS NULL` rows in `runs.ts`/`fallback.ts` are still surfaced to all authenticated users (currently 0 in production); the `audit.ts` `nullTaskSelfClause` could be additionally gated by an allow-list of auth-related `event_type`s as defense-in-depth against future spoofable metadata producers.

### Host PowerShell Capability + OpenClaw Notes

`POST /api/powershell` lets a `super_admin` operator run a PowerShell expression on the host (`pwsh` preferred, `powershell.exe` fallback). The endpoint is OFF by default and only mounts when `POWERSHELL_ENDPOINT_ENABLED=1` is set in the environment; without the flag it returns `404 POWERSHELL_DISABLED`. When enabled it stays behind `requireAuth` + `requireRole("super_admin")`, inherits the platform's `writeLimiter` (60/min/IP), caps the command body at 4 KB, the output buffer at 1 MB, and the wall-clock at 30 s, and writes a `POWERSHELL_EXECUTED` / `POWERSHELL_FAILED` row to the audit chain (with actor `user_id`, role, IP, command summary, byte counts) on every invocation. Helper at `artifacts/api-server/src/tools/runPowerShell.ts`; route at `artifacts/api-server/src/routes/powershell.ts`; tests at `artifacts/api-server/tests/powershell_unit.mjs`. Companion notes for the OpenClaw reference project (MIT, upstream-only — not vendored into this repo) live in `docs/openclaw-integration.md`.

## External Dependencies

- **PostgreSQL**: Primary database.
- **OpenAI API**: LLM models and Whisper transcription.
- **Anthropic API**: LLM models.
- **Google Gemini API**: LLM models.
- **Ollama**: Local and self-hosted LLM models.
- **`pdf-parse`**: PDF text extraction.
- **`mammoth`**: DOCX text extraction.
- **`sharp`**: Image metadata extraction and thumbnail generation.
- **`ffmpeg` / `fluent-ffmpeg`**: Video processing (frame extraction, audio stripping).
- **Replit AI Integrations Proxy**: Provides no-key access to OpenAI, Anthropic, and Gemini models within Replit.
- **`express-rate-limit`**: API rate limiting.
- **`helmet`**: HTTP header security.