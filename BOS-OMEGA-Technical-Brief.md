# BOS-OMEGA — Technical Brief for Claude Code

---

## What It Is

**BOS-OMEGA** (Bioweapon Orchestration System Omega) is a full-stack AI orchestration platform styled after the Umbrella Corporation's Resident Evil universe. It accepts a user task, classifies it, selects the optimal LLM execution strategy, routes it across one or more providers, validates the output, and returns a structured `GO / HOLD / ABORT` **Tri-State** decision. It is a working product, not a demo — it has real auth, multi-tenant memory, image generation, audit logging, and conversation continuity.

---

## Monorepo Layout

```
pnpm workspace (pnpm-workspace.yaml)
├── artifacts/
│   ├── api-server/          — Express API + BOS pipeline (TypeScript)
│   ├── bos-omega/           — React 19 + Vite frontend (TypeScript)
│   └── mockup-sandbox/      — Vite component preview server (canvas/design use only)
├── lib/
│   ├── db/                  — Drizzle ORM schema + client (@workspace/db)
│   ├── api-spec/            — OpenAPI YAML spec (openapi.yaml)
│   ├── api-zod/             — Orval-generated Zod validation schemas
│   ├── api-client-react/    — Orval-generated TanStack Query v5 hooks
│   ├── local-agent-contracts/ — Types for local agent integration
│   └── local-agent-policy/  — Policy definitions
└── scripts/                 — Utility scripts
```

**Routing**: A shared reverse proxy routes by path prefix. `/api` → api-server, `/` → bos-omega. No cross-artifact direct calls.

---

## Backend — `artifacts/api-server`

**Stack**: Express.js · TypeScript · Drizzle ORM · PostgreSQL · pino logger · express-session · zod

**Entry**: `src/index.ts` → calls `bootstrap()` (seeds super-admin + providers) then listens on `$PORT`

**Route prefix** `/api`, mounted in `src/routes/index.ts`:

| Route | Description |
|---|---|
| `GET/POST /api/auth` | Login, signup, logout, `/me` — session-cookie auth |
| `GET/POST/PATCH /api/tasks` | Create & list tasks (core submission endpoint) |
| `GET /api/tasks/:id` | Task detail + tri-state result |
| `GET /api/tasks/:id/memory-context` | What memory was injected for this task |
| `GET /api/tasks/:id/attempts` | Per-model attempt records |
| `GET /api/runs` · `/runs/:id` | Execution run records per task |
| `GET /api/runs/:id/series` | Series-pass sub-runs |
| `GET /api/runs/:id/parallel-agents` | Parallel agent records |
| `GET /api/runs/:id/synthesis` | Consensus synthesis report |
| `GET/POST/PATCH/DELETE /api/providers` | LLM provider CRUD |
| `PUT/DELETE /api/providers/:id/api-key` | AES-256-GCM encrypted key storage |
| `POST /api/providers/:id/test` | Live key validation |
| `POST /api/providers/:id/discover-models` | Auto-fetch model catalog |
| `GET /api/providers/preflight` | "Is any reachable key configured?" health check |
| `GET /api/models` | Model registry |
| `PATCH /api/models/:slot` | Update model config |
| `GET/PATCH /api/personas` | 3 persona slots (A/B/C) with prompt overlays |
| `GET/PUT/DELETE /api/memory/budgets` | Per-user per-layer token budget overrides |
| `GET/POST/DELETE /api/scratchpad` | Per-user continuity scratchpad |
| `POST /api/scratchpad/pin` | Pin an assistant message as a scratchpad note |
| `GET /api/lattice/export` | Export full continuity bundle (JSON) |
| `POST /api/lattice/import` | Import and restore continuity bundle |
| `GET /api/lattice/exports` | Last 10 export records |
| `GET /api/conversations` | Conversation list |
| `GET/PATCH /api/conversations/:id` | Conversation detail / rename |
| `GET /api/fallbacks` | Fallback event log (provider failovers) |
| `GET /api/audit` | Audit log |
| `GET/POST/PATCH /api/users` | User management (admin/super_admin only) |
| `POST /api/users/owner/repair` | Reset super-admin from bootstrap password |
| `POST /api/users/:id/reset-password` | Password reset |
| `GET /api/image-quota` | Daily image-gen spend cap usage |
| `PUT /api/overrides/users/:id/override` | Per-user image quota override |
| `GET/POST/DELETE /api/uploads` | File upload / attachment CRUD |
| `GET /api/health` | Health check |
| `GET /api/tri-state` | Tri-state stats (GO/HOLD/ABORT counts) |

**Auth**: `express-session` with `SESSION_SECRET`. Roles: `user` · `admin` · `super_admin`. Bootstrap via `OWNER_SUPERADMIN_BOOTSTRAP_PASSWORD`. Rate-limited via `expensiveLimiter` on task creation and provider test/discover.

---

## The BOS Pipeline (`src/bos/pipeline.ts` — 1,160 lines)

This is the core. Every `POST /api/tasks` call runs through it:

```
Input
  └─ Input Gate (content safety)
  └─ Front Door Interpreter → GREETING / EMPTY / UNDER_SPECIFIED / LIKELY_NON_TASK?
       └─ yes → return guidance response (no LLM spend)
  └─ Task Classifier → task_type
       (legal / code / math / research / summarization /
        extraction / planning / creative / safety_review / general)
  └─ Image Intent Detector → route to imageProviderBridge if image-gen/edit
  └─ Memory Engine → load canon + continuity + patches + scratchpad
       (4 layers, per-user token-budgeted)
  └─ Persona Overlay → inject slot A/B/C prompt if requested
  └─ Mode Selector → pick ExecutionMode
       single | parallel | consensus | series_pass | boil_the_ocean | auto
  └─ Model Router → score all enabled models by capability matrix + health + cost
  └─ Execution Engine → call LLM(s)
       ├─ single:        one model
       ├─ parallel:      N models concurrently → pick best by confidence score
       ├─ consensus:     N models → ConsensusMerge picks winner
       ├─ series_pass:   draft → critique → refine (sequential passes)
       └─ boil_the_ocean: exhaustive multi-pass (for high-stakes tasks)
  └─ Validation Engine → schema / safety / instruction / completeness checks
  └─ Repair Engine → attempt structured repair if validation fails
  └─ Tri-State Decision → GO / HOLD / ABORT
  └─ Audit Engine → write to audit_logs
  └─ Scratchpad Writer → auto-summary written post-task
  └─ Circuit Breaker → update provider health on success/failure
Output → BosOutput
```

**Key types** (in `src/bos/types.ts`):

```typescript
type TriState = "GO" | "HOLD" | "ABORT"

type ExecutionMode =
  | "single" | "parallel" | "consensus"
  | "series_pass" | "boil_the_ocean" | "auto"

type TaskType =
  | "legal" | "code" | "math" | "research" | "summarization"
  | "extraction" | "planning" | "creative" | "safety_review" | "general"

interface BosOutput {
  state: TriState
  task_type: TaskType | string
  answer: string
  assumptions: string[]
  uncertainties: string[]
  missing_inputs: string[]
  failure_modes: string[]
  recommended_next_action: string
  why_decision_was_made?: string      // HOLD/ABORT only
  safe_alternative?: string           // HOLD/ABORT only
  front_door_route?: string           // "GREETING" | "EMPTY" | "UNDER_SPECIFIED" | "LIKELY_NON_TASK"
  front_door_examples?: string[]
  parallel_responses?: ParallelResponse[]
  generated_attachments?: GeneratedImageRef[]  // image-gen output
  repair_applied?: boolean
}

interface TaskContext {
  task_id: string
  input: string
  task_type: TaskType | string
  tri_state: TriState
  mode: ExecutionMode
  parallel_models: number
  memory_context?: string             // pre-rendered, shared across all engines
  persona_prompt_text?: string
  attachment_context?: string
  attachment_images?: VisionImage[]
}
```

**Mode selector heuristics** (when mode = "auto"):
- Keywords like "exhaustive", "comprehensive", "production ready" → `boil_the_ocean`
- Keywords like "refine", "improve", "check my work" → `series_pass`
- High-stakes task types (legal, research, planning, code) + input > 200 chars → `boil_the_ocean`
- Complex types + input > 100 chars → `series_pass`
- Default → `normal` (single-model)

**Model scoring** weights: capability match ×3, reliability ×2, provider health, context fit, latency, cost.

---

## Database (`lib/db`)

**ORM**: Drizzle ORM · PostgreSQL via `DATABASE_URL`

30 tables across `lib/db/src/schema/`:

| Table | Purpose |
|---|---|
| `users` | Accounts with roles (user / admin / super_admin) |
| `llm_providers` | Provider config (name, base_url, priority, enabled) |
| `llm_models` | Model catalog (capability_tags, context_window, cost, latency_score) |
| `provider_health` | Circuit breaker state per provider |
| `tasks` | Every task submission + final BosOutput |
| `model_attempts` | Per-model-per-task call record (latency_ms, tokens, cost) |
| `execution_runs` | Run record per task |
| `parallel_agents` | Per-agent record in parallel mode |
| `series_passes` | Each pass in series_pass mode |
| `synthesis_reports` | Consensus merge report |
| `tri_state_decisions` | Governance decision log |
| `fallback_events` | Provider failover events |
| `audit_logs` | Compliance audit trail |
| `memory_items` | 4-layer memory (canon / continuity / patches / scratchpad) |
| `user_memory_budgets` | Per-user token ceiling overrides per layer |
| `conversations` | Task groupings (auto-clustered by topic) |
| `attachments` | Uploaded files (bytes stored, served via /api/uploads) |
| `lattice_exports` | Continuity bundle snapshot records (sha256 + byte size) |
| `image_quota_overrides` | Per-user daily image spend cap overrides |
| `validation_results` | Output validation report per task |
| `personas` | 3 persona slots (A/B/C) with editable prompt overlays |
| `bos_task_requests` | Local agent task request queue |
| `bos_task_executions` | Local agent execution records |
| `bos_org_*` | Multi-org / device pairing tables (local agent) |

---

## Code Generation (OpenAPI → Client)

```
lib/api-spec/openapi.yaml
  └─ pnpm --filter @workspace/api-spec run codegen
       ├─ lib/api-zod/          — Zod schemas (used on server for input validation)
       └─ lib/api-client-react/ — TanStack Query v5 hooks (useListProviders, etc.)
```

The server validates request bodies with the Zod schemas. The frontend uses generated hooks for all data fetching. If you add/modify an endpoint: update `openapi.yaml` → run codegen → update server handler → update frontend.

---

## Frontend — `artifacts/bos-omega`

**Stack**: React 19 · Vite · TypeScript · Tailwind CSS v4 · shadcn/ui · TanStack Query v5 · wouter · framer-motion · lucide-react

**Pages** (all auth-gated, session cookie):

| Route | Page | Purpose |
|---|---|---|
| `/console` | `TaskConsole.tsx` | Main chat — submit tasks, view GO/HOLD/ABORT output |
| `/memory` | `MemoryManager.tsx` | Browse/edit the 4-layer memory system |
| `/providers` | `ProviderStatus.tsx` | Ambient provider display (classified codenames, for show) |
| `/users` | `Users.tsx` | User management (super_admin only) |
| `/settings` | `Settings.tsx` | Appearance (11 themes) + memory budgets + scratchpad |

**Nav structure**:
- **Intel**: Console, Memory
- **System**: Providers, Users (super_admin only), Settings

**Key components**:

| Component | Purpose |
|---|---|
| `Layout.tsx` | Sidebar (w-52) + top bar + main content wrapper. Renders MatrixRain under Umbrella Corp theme |
| `MatrixRain.tsx` | Animated canvas — red katakana + latin glyphs. 7% of columns spell hidden messages in white |
| `ConversationsList.tsx` | Conversation sidebar panel under Intel nav section |
| `ProviderPreflightBanner.tsx` | Warning banner when no provider key is reachable |
| `MessageList.tsx` | Renders task output: Tri-State badges, image attachments, scratchpad pin button |
| `CorporateLogo.tsx` | Umbrella Corp SVG brand lockup |
| `StatusBadge.tsx` | GO/HOLD/ABORT pill badges |

**Theming**: 11 skins (Windows 95, Windows 98, Modern, Cyberdyne, Umbrella, Umbrella Corp, Capybara, Anime, Steampunk, Neon Punk, Ultra Clean). Applied via class on `:root`. Umbrella Corp styles scoped under `:root.theme-umbrella-corp`. Persisted to localStorage via `useTheme()`.

**Auth flow**: `fetchAuthState()` → `GET /api/auth/me`. Unauthenticated → `<Login />`. Session cookie automatic.

---

## Environment Variables / Secrets

| Variable | Service | Purpose |
|---|---|---|
| `DATABASE_URL` | api-server | PostgreSQL connection string |
| `SESSION_SECRET` | api-server | express-session signing key |
| `OWNER_SUPERADMIN_BOOTSTRAP_PASSWORD` | api-server | Seeds the first super_admin on cold start |
| `PORT` | both | Assigned per-service by Replit reverse proxy |

**Provider API keys** are stored in the database encrypted with AES-256-GCM — never returned in plaintext. Optional env var fallbacks if no DB key: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OLLAMA_BASE_URL`.

---

## Testing & Typechecking

```bash
# Frontend unit tests (Vitest + React Testing Library)
pnpm --filter @workspace/bos-omega run test

# Full typecheck (builds libs first, then checks all leaf packages)
pnpm run typecheck

# Codegen after OpenAPI changes
pnpm --filter @workspace/api-spec run codegen
```

119 tests across `artifacts/bos-omega/src/pages/*.test.tsx`.

Known pre-existing TS error: `MessageList.tsx` references `BosOutput.front_door_route` — not in the generated Zod type because the OpenAPI spec was not regenerated when that field was added. Non-blocking.

---

## Deployment

Hosted on Replit. Each artifact binds to `$PORT` and is proxied at its path prefix. Published via Replit's deployment system to a `.replit.app` domain. PostgreSQL is Replit's managed database. All secrets managed via Replit Secrets (never in code).
