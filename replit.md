# BOS-OMEGA — Governed Multi-LLM Orchestration Platform

## Overview

Production-grade governed multi-LLM orchestration platform. Full-stack: Node.js/Express 5 backend, React/Vite frontend, PostgreSQL database. Features multi-provider routing, parallel execution, circuit breakers, tri-state evaluation, validation/repair engine, audit logging, and admin dashboard.

## Architecture

```
pnpm monorepo
├── artifacts/
│   ├── api-server/          — Express 5 API server (port via PORT env)
│   │   └── src/
│   │       ├── bos/         — BOS engine modules
│   │       │   ├── pipeline.ts        — Main BOS orchestrator
│   │       │   ├── executionEngine.ts — Parallel/single/consensus execution
│   │       │   ├── inputGate.ts       — Input safety gating
│   │       │   ├── taskClassifier.ts  — Task type classification
│   │       │   ├── triState.ts        — GO/HOLD/ABORT evaluator
│   │       │   ├── modelRouter.ts     — Capability-based model routing
│   │       │   ├── circuitBreaker.ts  — Provider circuit breakers
│   │       │   ├── validationEngine.ts — Output validation
│   │       │   ├── repairEngine.ts    — Output repair/retry
│   │       │   ├── auditEngine.ts     — Audit trail logging
│   │       │   └── memoryEngine.ts    — Memory layer access
│   │       ├── providers/   — LLM adapters (OpenAI, Anthropic, Gemini, Ollama, Generic)
│   │       ├── routes/      — Express routes (tasks, providers, models, health, audit, memory, fallbacks)
│   │       └── db/          — Drizzle ORM + seed data
│   └── bos-omega/           — React/Vite frontend (port via PORT env)
│       └── src/
│           ├── pages/       — 8 admin pages
│           ├── components/  — Layout, StatusBadges
│           └── lib/         — utils
├── lib/
│   ├── api-spec/            — OpenAPI 3.1 spec
│   ├── api-zod/             — Zod schemas (codegen output)
│   ├── api-client-react/    — React Query hooks (codegen output)
│   └── db/                  — Drizzle schema (9 tables)
```

## Stack

- **Monorepo**: pnpm workspaces
- **Node.js**: 24, TypeScript 5.9
- **Backend**: Express 5, Drizzle ORM, PostgreSQL
- **Frontend**: React 19, Vite 7, TailwindCSS v4, React Query, Wouter
- **API codegen**: Orval (OpenAPI → Zod + React Query hooks)
- **Validation**: Zod v4, drizzle-zod
- **Build**: esbuild (CJS bundle)
- **Theme**: Claude-grade enterprise — warm cream background (`hsl(40 25% 97%)`), deep slate primary (`hsl(220 28% 18%)`), clay coral accent for agentic CTAs (`hsl(15 60% 50%)`). Source Serif 4 headlines, Inter body, JetBrains Mono only for IDs/code. Light mode default with optional `.dark` warm-slate variant.

## UI design system

- **Surfaces**: warm cream bg, pure white cards with soft warm borders, `shadow-card` for elevation (no neon glows).
- **Type**: serif for page titles + section headers, sans for body, sentence-case labels (no all-caps headers). Mono reserved for IDs, env var names, base URLs, code.
- **Color tokens**: status badges use `bg-{color}-50 / text-{color}-800 / border-{color}-200` for light-mode contrast. Avoid hardcoded `text-*-400` (dark-only).
- **CTAs**: deep slate (`bg-primary`) for primary destructive/save actions; clay coral (`bg-accent`) for agentic actions (Discover models, Submit task).
- **Trust signals**: badge-secure pill ("All systems operational"), top bar shows "SOC2-ready · encrypted", sidebar footer surfaces Tri-State + AES-256-GCM.

## Key Commands

```bash
pnpm run typecheck                          # Full typecheck all packages
pnpm run build                              # Typecheck + build all packages
pnpm --filter @workspace/api-spec run codegen  # Regenerate API hooks from OpenAPI spec
pnpm --filter @workspace/db run push        # Push DB schema changes (dev only)
```

## BOS Engine Pipeline

1. **Input Gate** — Safety/content check → GO/HOLD/ABORT signal
2. **Task Classifier** — Classify task type (analysis, coding, creative, extraction, etc.)
3. **Tri-State Evaluator** — GO (execute), HOLD (insufficient info), ABORT (unsafe/policy violation)
4. **Model Router** — Route to best provider/model based on task type + capability tags + circuit breaker state
5. **Execution Engine** — Single / Parallel / Consensus modes
6. **Validation Engine** — Schema, safety, instruction, completeness checks
7. **Repair Engine** — Retry with repair prompt on validation failure
8. **Audit Engine** — Log all pipeline events to DB
9. **Memory Engine** — Access canon/patches/continuity layers

## Frontend Pages

- `/console` — Task Console (submit tasks, view structured BOS output)
- `/providers` — Provider Status Dashboard with circuit breaker controls
- `/models` — Model Registry with capability tags and scoring
- `/tasks` — Task Logs with pagination
- `/tasks/:id` — Task Detail with full pipeline trace
- `/fallbacks` — Fallback Events log
- `/memory` — Memory Manager (layered memory CRUD)
- `/audit` — Full Audit Log stream
- `/settings` — Provider configuration

## Database Tables

- `providers` — LLM provider registry
- `models` — Model registry with capability tags
- `tasks` — Task execution records
- `model_attempts` — Per-model attempt records
- `validation_results` — Output validation results
- `repair_attempts` — Repair attempt records
- `fallback_events` — Provider fallback events
- `audit_logs` — Full pipeline audit trail
- `memory_items` — Layered memory store

## Important Notes

- `lib/api-zod/src/index.ts` must only export `export * from "./generated/api"` — codegen regenerates it with double export; fix manually after each codegen run
- Providers run in MOCK MODE when no API key is configured — full pipeline still executes but LLM responses are simulated
- Seed data is idempotent (skips if providers already exist)
- API keys configured as env vars: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`
