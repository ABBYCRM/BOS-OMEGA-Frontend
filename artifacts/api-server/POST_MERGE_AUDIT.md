# BOS-OMEGA — Post-Merge Audit (Tasks #1 + #2)

**Audit date:** 2026-04-26
**Scope:** Independent second-pass audit of `main` after Task #1 (full system audit & bug-fix pass) and Task #2 (personas + local memory + Win95 retro skin) merged. Intended to catch anything the first pass missed and any drift Task #2 introduced on its way through.
**Method:** static read of every file Task #1 or Task #2 touched, `pnpm -r typecheck`, `pnpm -r build`, regression check against `AUDIT_REPORT.md`, end-to-end smoke against the running stack.
**Posture:** read-only. **No code was changed in this pass.** Every finding below is logged for the user to schedule as a follow-up if they choose.

> Tone note: per the user's request, each finding carries a one-line roast of the *code* (not the agent who wrote it). The professional fix recommendation always follows.

Severity convention matches `AUDIT_REPORT.md`:
- **CRITICAL** — data loss / silent wrong answer / security breach
- **HIGH** — broken user-visible feature, type error, contract violation, multi-tenant leak
- **MEDIUM** — degraded behavior, race, or maintenance hazard
- **LOW** — style / docs / future work

---

## Headline result

| Block | Status |
|---|---|
| `pnpm -r typecheck` | **clean** across all 8 typed packages |
| `pnpm -r build` (with `PORT=8888 BASE_PATH=/mockup-sandbox/`) | **clean** for `api-server` and `bos-omega`; mockup-sandbox builds when both env vars are set |
| Regression check on Task #1 Critical/High fixes (C-1, C-2, C-3, H-1..H-5) | **all 8 intact** — verified inline below |
| Live API smoke (`/api/health`, `/api/auth/me`, `/api/auth/login`, `/api/providers`, `/api/models`, `/api/audit`, `/api/tasks/stats`) | **all 200** under super-admin and user roles |
| New defects introduced by Task #2 | **1 HIGH, 4 MEDIUM, 4 LOW** — see "New findings" below |

---

## Regression check — Task #1 fixes

Every Critical and High the first audit claimed to fix was re-verified in the merged tree. Result: **all eight held**. Quick log:

| ID | File | Verified |
|---|---|---|
| **C-1** consensus mode picks the actual aborter, not last-by-confidence | `bos/executionEngine.ts:196-197` — `const aborter = responses.find(r => r.state === "ABORT") ?? responses[0]!; aborter.selected = true;` | ✅ |
| **C-2** orval `{id,data}` envelope on provider/model mutations | `pages/ProviderStatus.tsx:18`, `pages/ModelRegistry.tsx:30,38` — both use `{ id, data: {...} }` | ✅ |
| **C-3** parallel/consensus modes no longer collapse to single | `bos/modeSelector.ts:29` widened union; `bos/pipeline.ts:384` dispatches both branches | ✅ |
| **H-1** BTO HOLD ≠ contradiction | `bos/boilTheOceanEngine.ts:344-362` — HOLD now adds a "validators uncertain" consensus point; only opposing GO/ABORT counts as contradiction | ✅ |
| **H-2** series-pass requires ≥2 models, with graceful downgrade | engine throws at `bos/seriesPassEngine.ts:127-131`; pipeline downgrades at `bos/pipeline.ts:358-367` and emits `MODE_DOWNGRADED` | ✅ |
| **H-3** robust JSON extraction reused everywhere | `extractJsonCandidate` exported from `bos/validationEngine.ts:55`; reused in `executionEngine`, `seriesPassEngine:177`, `boilTheOceanEngine:381` (and synthesis/adversarial parses) | ✅ |
| **H-4** provider routes — `paramId`, real columns, full audit union | `routes/providers.ts:138,173`; `bos/auditEngine.ts:46-50` includes `PROVIDER_TESTED`, `PROVIDER_DISCOVERY_FAILED`, `PROVIDER_MODELS_DISCOVERED`, `PROVIDER_REMOVED`, `MODE_DOWNGRADED` | ✅ |
| **H-5** frontend `as const` + explicit `queryKey` | `components/MessageList.tsx:223-225`; `components/TriStateVector.tsx:43` (path uses `tri-state` hyphen, matches orval); `pages/TaskDetail.tsx:13-16` passes an explicit literal-array `queryKey: [\`/api/tasks/${id}\`]` to satisfy orval's `UseQueryOptions` | ✅ |

> Roast (general, on the regression suite, not any agent): *Eight Critical/High fixes survived an entire feature merge without a single one un-fixing itself. The bar was on the floor and the codebase cleared it. Confetti.*

No fix regressed. No fix was only partial. The `MODE_DOWNGRADED` event added during Task #1's post-review round is correctly wired into the union, the audit writer, and the new pipeline branch.

---

## New findings introduced or exposed by Task #2

### HIGH

#### H-PM-1 — Local memory leaks across users on the same browser
- **Severity:** HIGH (privacy / multi-tenant)
- **Category:** security / regression-against-Task-#3
- **Files:** `artifacts/bos-omega/src/lib/localMemory.ts:33-36`, `pages/TaskConsole.tsx:152-156` (auto-inject site)
- **Evidence:** The IndexedDB name is the literal `"bos-omega-local-memory"` and the localStorage fallback key is `"bos.localMemory.items.v1"`. Neither incorporates `auth.user.id`. `grep -rn "user_id\|uid" artifacts/bos-omega/src/lib/localMemory.ts artifacts/bos-omega/src/lib/auth.ts` returns **zero** matches.
- **Repro:** sign in as `alice@test.com`, open Local Memory, add an item ("My private API key is ..."). Sign out. Sign in as `bob@test.com` on the same browser — Bob sees Alice's memory item, AND `buildLocalMemoryInjection` will silently prepend it to every task Bob submits. If Bob's task hits a remote provider, Alice's data exfiltrates over Bob's session.
- **Fix:** key the IDB database name and LS key by `auth.user.id` (e.g. `bos-omega-local-memory:${uid}` / `bos.localMemory.items.v1.${uid}`). Hook a logout-time purge of any unkeyed legacy data. Also add a sign-in/sign-out listener to flush in-memory caches.
- **Roast:** *"Local memory" turned out to be a feature that taught the app to share secrets enthusiastically with every roommate who happened to use the same Chrome profile. Truly the spirit of the late 90s file share.*

### MEDIUM

#### M-PM-1 — Persona is never persisted on the `tasks` row
- **Severity:** MEDIUM
- **Category:** contract / observability
- **Files:** `lib/db/src/schema/tasks.ts` (no `persona` column), `bos/pipeline.ts:164,347` (only logged in audit metadata)
- **Evidence:** `grep persona lib/db/src/schema/tasks.ts` returns nothing; `grep persona artifacts/api-server/src/db/` returns nothing. Persona ends up only in the `audit_log.metadata` JSONB at `TASK_RECEIVED`. Anyone replaying or analyzing a task by `task_id` cannot recover which persona drove it without joining audit.
- **Fix:** add `persona text` (nullable) to `tasks_table`, write it inside `pipeline.saveTask` alongside `user_id`, and surface it in `GET /api/tasks/:id` and the task list. Backfill existing rows from audit metadata if desired.
- **Roast:** *We charge for a "governed multi-LLM platform" but the audit story for personas is "go grep the metadata blob." Compliance officers love a good scavenger hunt.*

#### M-PM-2 — Persona invisible in Audit Log + Task Detail UI
- **Severity:** MEDIUM
- **Category:** UX / governance
- **Files:** `artifacts/bos-omega/src/pages/AuditLog.tsx`, `pages/TaskDetail.tsx`
- **Evidence:** `grep -n persona artifacts/bos-omega/src/pages/AuditLog.tsx pages/TaskDetail.tsx` returns zero matches. There is no persona column in the audit list, no filter, and no chip in the task summary header.
- **Fix:** add a Persona column / chip to both views, derived from the audit `TASK_RECEIVED` metadata (or from M-PM-1's new column once added). Add a Persona filter on Audit Log alongside the existing Event Type / Severity filters.
- **Roast:** *We built a Persona feature and then asked our governance UI to pretend it didn't happen. Object permanence is for the weak, apparently.*

#### M-PM-3 — Win95 retro skin collapses semantic colors on status badges
- **Severity:** MEDIUM
- **Category:** UX / a11y / regression
- **Files:** `artifacts/bos-omega/src/index.css:268-353` (`.theme-retro95` block), `components/StatusBadge.tsx`
- **Evidence:** In `.theme-retro95` `--accent`, `--primary`, and several other semantic vars all map to navy `#000080` or grey `#c0c0c0`. The Tri-State badges (GO / HOLD / ABORT) and TaskStatus badges that rely on the modern theme's vivid green/amber/red lose the at-a-glance distinction. Retro is the **default** theme on first visit, so this is the experience every new user gets.
- **Fix:** either (a) keep the modern semantic colors for status badges even inside `.theme-retro95`, or (b) supplement the badges in retro mode with a unique glyph per state (✓ / ⏸ / ✗) so color is not the only signal. Verify WCAG AA contrast (4.5:1) on every `text-*` over `bg-*` combo in the retro palette.
- **Roast:** *We shipped a beautiful retro skin and then made every traffic light the same color. "Shall we proceed? Yes; the answer is grey."*

#### M-PM-4 — Local-memory `clearLocalMemory` races against in-flight writes
- **Severity:** MEDIUM
- **Category:** reliability
- **Files:** `artifacts/bos-omega/src/lib/localMemory.ts:212-222` (clear path), surrounding CRUD helpers
- **Evidence:** `clearLocalMemory()` clears IDB or LS but does not coordinate with `createLocalMemoryItem()` / `updateLocalMemoryItem()` already in flight. If the user clicks "Clear all" while a previous create is mid-`put`, the cleared store can re-acquire the in-flight row, leaving a "ghost" item with no UI representation until the next list query.
- **Fix:** introduce a tiny per-store mutex (a chained `Promise<void>` queue would do) or close the IDB connection inside `clearLocalMemory` and reopen on the next call. The localStorage path is moot once the IDB path is mutex'd.
- **Roast:** *"Clear all" with a side helping of "clear most." It's the IndexedDB equivalent of a magic eraser that occasionally writes its name on the wall.*

#### M-PM-5 — `pnpm -r build` requires both `PORT` *and* `BASE_PATH` to succeed
- **Severity:** MEDIUM
- **Category:** build hygiene / docs drift
- **Files:** `artifacts/mockup-sandbox/vite.config.ts` (validates both at config-load), `replit.md`, `AUDIT_REPORT.md` L-2
- **Evidence:** `AUDIT_REPORT.md` L-2 documented "`PORT=0 pnpm -r build` works" as a workaround. In the merged tree this is no longer true: `PORT=0` errors with "Invalid PORT value: '0'", and `PORT=8888` then errors "BASE_PATH environment variable is required". `PORT=8888 BASE_PATH=/mockup-sandbox/ pnpm -r build` does build cleanly. Either the workaround needs updating in `replit.md`, or the sandbox `vite.config.ts` should accept a sensible default in build mode.
- **Fix:** in `vite.config.ts`, default `BASE_PATH` to `/` and `PORT` to a fixed integer when `command === "build"`. As a doc fallback, update `replit.md`'s build-from-clean instructions.
- **Roast:** *The previous audit confidently said "PORT=0 works." Reader, it does not. The build server now demands two env vars by name like a maître d' at a velvet rope.*

### LOW

#### L-PM-1 — `TaskContext.persona` typed as `Persona | string`
- **Severity:** LOW
- **Category:** type hygiene / future-proofing
- **Files:** `artifacts/api-server/src/bos/types.ts:113`, `providers/prompts.ts:148`
- **Evidence:** `TaskContext.persona?: Persona | string`. Today the route handler at `routes/tasks.ts:71` casts to the closed union before passing in, so prompt-injection via persona is not currently exploitable. The `string` half exists as a forward-compat hatch and `buildPersonaSystemSuffix` already gates on `PERSONA_PROMPTS[id]`, so unknown values become empty strings. If anyone later wires a "custom persona" field, this loose type lets attacker text reach the prompt builder.
- **Fix:** narrow to `Persona | undefined`. If custom personas are later added, keep them in a separate `customPersonaSuffix: string` and sanitize at the gate.
- **Roast:** *The type system already drew a line in the sand and then politely added "or anything else, sure, whatever you want."*

#### L-PM-2 — Retro-skin bevels can occlude focus rings
- **Severity:** LOW
- **Category:** a11y
- **Files:** `artifacts/bos-omega/src/index.css:345-353` (`.shadow-card` overrides)
- **Evidence:** Retro mode replaces the modern `box-shadow` with `inset` borders that simulate Win95 bevels. Tailwind's default `ring-2` outline sits *outside* the element, but in retro the `.shadow-card-hover` inset overrides the visual treatment of focus on cards — the keyboard-focus indicator is muted compared to modern.
- **Fix:** add a `.theme-retro95 *:focus-visible { outline: 2px dashed #000; outline-offset: 1px; }` rule, or restore modern's `ring-*` cascade above the inset bevel. Verify with a keyboard-only walk of the Task Console.
- **Roast:** *We shipped the look of an OS that was famously keyboard-driven and immediately made the focus ring optional. Bill is rolling in his rolling office chair.*

#### L-PM-4 — Persona-aware routing (enhancement, not a defect)
- **Severity:** LOW (enhancement)
- **Category:** product
- **Files:** `artifacts/api-server/src/bos/taskClassifier.ts`, `bos/modelRouter.ts`, `bos/pipeline.ts` (where classifier/router are called)
- **Evidence:** Per the OpenAPI contract, persona is purely a prompt overlay — it does not influence task classification or model selection. A user picking "Legal Counsel" therefore gets the prompt of a senior litigator but the model the registry would have picked from the input alone. This is *intentional* under the merged contract; flagging it here as a future product opportunity rather than a bug.
- **Fix (if product wants persona-aware routing):** widen the contract — pass `persona` into `classifyTask` and `selectModel` and let it set a floor on `min_capability_tags` (e.g. long-context + reasoning for `legal`). Update OpenAPI to reflect the new behavior, audit the routing decision, and document the trade-off.
- **Roast:** *Not a bug, just a gentle nudge that the senior litigator persona currently rides whichever model was going to handle the task anyway. Sometimes that model is excellent. Sometimes it's the cost-optimized one normally trusted with "write me a haiku."*

#### L-PM-3 — FOUC on slow first paint before `initTheme()` runs
- **Severity:** LOW
- **Category:** UX polish
- **Files:** `artifacts/bos-omega/src/main.tsx`, `index.css`
- **Evidence:** Theme is applied via `classList` on `<html>` inside `initTheme()`, called *before* `createRoot().render()` but *after* the bundle has parsed. On a cold-cache load the user sees the modern (default) palette for a frame, then the retro skin snaps on.
- **Fix:** inline a tiny `<script>` at the top of `index.html` that reads `localStorage.getItem("bos.theme.v1")` and adds `theme-retro95` to `document.documentElement` synchronously, before the React bundle loads. The persisted-key snapshot is enough; no React state needed for the boot frame.
- **Roast:** *The retro skin loads with all the punctuality of a beige PC booting from a floppy. Five out of five for authenticity, three out of five for first-paint experience.*

---

## Items the audit explicitly checked and found clean

To keep this report honest, here is what was inspected and *not* flagged:

- **End-to-end smoke under both roles** — login flow works for `admin@bos-omega.local` and `alice@test.com`. Tri-state pipeline returns a structured BOS output. Audit log shows the new `TASK_RECEIVED` entries with persona metadata and the `MODE_DOWNGRADED` event when conditions trigger.
- **Persona prompt propagation** — `buildPersonaSystemSuffix` is correctly invoked at every adapter call site that runs a model: `executionEngine.ts:53`, `seriesPassEngine.ts:160`, `boilTheOceanEngine.ts:218,373,403`. The synthesis and adversarial passes both receive persona. (Repair engine intentionally does not receive persona — repair is a structural fix, not a content rewrite, and reapplying persona there would risk the repair drifting back to a non-conformant shape.)
- **Persona is a prompt overlay by design, not a routing input** — the OpenAPI description explicitly states: *"Composes with the Master Prompt Kernel — does not replace it. Personas reshape the answer content while preserving BOS schema and governance."* So `taskClassifier`/`modelRouter` not consuming persona is **per-contract behavior**, not a defect. (See L-PM-4 below for the related enhancement opportunity if the product later wants persona-aware routing.)
- **OpenAPI / zod / react-query alignment for persona** — `lib/api-spec/openapi.yaml:1048-1051` declares `CreateTaskBody.persona`; the regenerated `lib/api-zod` and `lib/api-client-react` both expose the new union; the route handler accepts and casts it; the React `TaskConsole` sends it. No drift.
- **Win95 skin does not break existing flows** — login, providers page, models page, memory page, audit page, task console all render without layout-breaking overflow in the retro palette. (See M-PM-3 for the badge contrast caveat.)
- **Local-memory injection footprint** — confirmed that `buildLocalMemoryInjection`'s 500-token cap (chars/4 heuristic, a known M-5 in `AUDIT_REPORT.md`) is enforced before the `=== USER REQUEST ===` separator; the injection is **client-side only** and never sent to the audit log or stored server-side.
- **Task #3 isolation guarantees still hold** — `alice@test.com` cannot read `admin@bos-omega.local`'s tasks/runs/audit/uploads/tri-state; super-admin sees everything; reasons are required on every override and user-mutation; bootstrap awaits both seeds before listening. None of these were weakened by Task #1 or Task #2 changes.

---

## Recommended next tasks

Titles only. Grouped by area. Schedule and assignment are left to the user.

- **Privacy / multi-tenant**
  - Key local memory storage by signed-in user
- **Persona surface area**
  - Persist persona on each task row
  - Surface persona in audit log filters and task detail
  - Narrow persona type to the closed union
  - Persona-aware model routing (product enhancement)
- **Retro skin polish**
  - Restore semantic color contrast on tri-state badges under Win95 theme
  - Restore visible keyboard focus rings under Win95 theme
  - Apply saved theme before first paint to eliminate FOUC
- **Reliability / build hygiene**
  - Serialize Local Memory clear against in-flight writes
  - Make `pnpm -r build` succeed without hand-supplying every env var

> The Medium/Low items pre-existing in `AUDIT_REPORT.md` (M-1 circuit-breaker race, M-2 SESSION_SECRET fail-open in dev, M-3 params typing, M-4 isCircuitOpen short-circuit, M-5 token heuristic, L-1..L-4) remain unfixed by design and are still valid follow-ups. They were not re-litigated here.

---

## Out of scope of this audit

- Task #3 (super-admin), Task #4 (PowerShell bridge), Task #5 (PowerShell sidebar) and any Task #6+ work — those are in flight or queued and will get their own review.
- Performance benchmarking, load testing, architectural rewrites, new features.
- Fixing any finding in this report. Read-only by task scope.
