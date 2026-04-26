# BOS-OMEGA — Full System Audit Report

**Audit date:** 2026-04-26
**Scope:** End-to-end review of Express 5 / React-Vite / Postgres / Drizzle
monorepo (`api-server`, `bos-omega`, `mockup-sandbox`, `lib/*`).
**Method:** static read of all `src/**/*.ts(x)`, `pnpm -r build`,
`pnpm -r typecheck`, manual reasoning over the BOS pipeline + governance
controls, smoke run via cookie-auth.

This pass is the post-Hardening-v1.1 sweep. v1.1 (12 controls + audit
durability) shipped clean; what follows are findings discovered while reading
the code path-by-path with fresh eyes.

Severities follow the BOS-OMEGA convention: **CRITICAL** = data loss / silent
wrong answer / security breach; **HIGH** = broken user-visible feature, type
errors, contract violation; **MEDIUM** = degraded behavior, race, or
maintenance hazard; **LOW** = style / docs / future work.

All **CRITICAL** and **HIGH** findings in this report were fixed in the same
commit. Findings flagged **MEDIUM** / **LOW** are documented for follow-up.

---

## CRITICAL findings (fixed)

### C-1 — Consensus mode selects wrong response on ABORT
**File:** `src/bos/executionEngine.ts:191-194`
**Symptom:** When any one model returns `state: ABORT`, the merger marks
`responses[responses.length - 1]` (after a *descending* confidence sort, so the
**lowest-confidence** response) as the `selected: true` row. The actual ABORT
trigger is never flagged in the audit trail. Investigators tracing why a
consensus aborted will see a benign low-confidence response highlighted instead
of the model that raised the ABORT.
**Fix:** flag the **first response whose state is ABORT** as `selected = true`,
preserving the ABORT signal as the merge driver of record.

### C-2 — Frontend sends wrong shape to provider/model mutations → 400
**Files:** `artifacts/bos-omega/src/pages/ProviderStatus.tsx` (L15-22, L26-33),
`artifacts/bos-omega/src/pages/ModelRegistry.tsx` (L29, L36)
**Symptom:** orval-generated mutation hooks expect
`{ id, data: UpdateProviderBody }` (or `{ data: CreateModelBody }`) — the
frontend passes flat `{ id, enabled }` / `{ id, status }` / the raw model
object. Server-side `safeParse` rejects with `INPUT_ERROR` 400. Result: the
**Providers** and **Model Registry** pages cannot toggle enabled, override
circuit status, or create new models — three core admin flows are broken
in production.
This is the same class of bug previously fixed in `MemoryManager.tsx`.
**Fix:** wrap every mutation arg in the orval-mandated `{ id, data: { ... } }`
shape and align value types (`status` cast already correct).

### C-3 — `parallel` and `consensus` modes silently degrade to single-shot
**Files:** `src/bos/modeSelector.ts:25-50`, `src/bos/pipeline.ts:227,361`
**Symptom:** The HTTP API accepts `mode: "parallel"` and `mode: "consensus"`
(both are valid `ExecutionMode` values), but `selectExecutionMode` only honors
explicit overrides for `"boil_the_ocean" | "series_pass" | "normal"`. Anything
else falls into auto-selection and resolves to `"normal"` — so the
`pipeline.ts:361` check `resolved_mode === "parallel" || resolved_mode === "consensus"`
is structurally unreachable, `parallel_count` is forced to `1`, and the
pipeline silently uses one model. The user thinks they got a 3-way merge; they
got a single shot. The TypeScript checker flags the unreachable comparison
(error TS2367) — that warning had been suppressed in noise.
**Fix:** widen `ModeSelectorResult.mode` to the full `ExecutionMode` set,
honor explicit `parallel` / `consensus` overrides, and let the pipeline
dispatch correctly.

---

## HIGH findings (fixed)

### H-1 — Boil-The-Ocean conflates HOLD with contradiction
**File:** `src/bos/boilTheOceanEngine.ts:344-347`
**Symptom:** The "validators disagreed" finding is raised whenever **any**
validator returned `HOLD`. HOLD means "I need more info" — it is not a
contradiction with a peer that returned `GO`. This produces false-positive
adversarial flags that downstream (BTO_ADVERSARIAL_COMPLETED) treats as real
disagreement, depressing confidence and triggering unnecessary repair passes.
**Fix:** raise a contradiction only when validators return *positively
opposing* states (mix of GO + ABORT, or one set with high confidence GO and
another HOLD specifically citing the same answer as wrong). Express HOLD as
"validators uncertain" instead of "disagreed".

### H-2 — Series-Pass degenerate single-model expansion
**File:** `src/bos/seriesPassEngine.ts:122-127`
**Symptom:** When the model registry returns only one eligible model, the
series-pass engine reuses it for all five roles (`A → A → A → A → A`). Every
pass is the same model "critiquing" itself, which is the failure mode series
mode is designed to avoid. The engine should refuse to run series-pass below
a viable diversity threshold and either fall back to single-shot or HOLD.
**Fix:** require `models.length >= 2`. Below that, downgrade to a normal
single-call path with a `notes` annotation; above 2, allow rotation but log
the role collisions so the operator sees the degenerate distribution.

### H-3 — Validation engine fragile JSON extraction
**File:** `src/bos/validationEngine.ts:16`
**Symptom:** `raw.match(/\{[\s\S]*\}/)` is greedy across the whole response.
A model that wraps its JSON in a ` ```json ... ``` ` fence and then writes
prose ("Here is the answer. As a side-note, `{ key: value }` is...") will
either fail to parse, or worse, parse a *concatenation* of two `{}` regions
because the regex spans from the first `{` to the last `}` even across
unrelated text. Schema-pass false-negatives cascade into HOLD/repair loops.
**Fix:** layered extraction —
1. fenced ` ```json ... ``` ` block (most common format),
2. fenced bare ` ``` ... ``` ` block,
3. balanced-brace scan from the first `{` (depth-tracked, ignores braces
   inside strings).
First strategy that yields parseable JSON wins.

### H-4 — Provider routes: type errors, schema drift, missing audit events
**Files:** `src/routes/providers.ts:140,143,157,161-164,176,179,191-192,203,208,230,232,245`,
`src/bos/auditEngine.ts:8-50`
**Symptom:** Three concurrent issues in the same file:
1. **`req.params.id`** is widened to `string | string[]` under Express 5's
   `ParamsDictionary` typing; every Drizzle `eq(...)` and `auditLog(...)` call
   trips `TS2769 / TS2345`. Real-world this only fails when an upstream proxy
   sends repeated `id` keys, but the type-checker is correct to flag it.
2. **`last_check_at: new Date()`** in the provider-health update — column does
   not exist (schema uses `last_success` / `last_failure` / `updated_at`).
   At runtime Drizzle ignores unknown keys; the visible "last refreshed" UI
   stamp simply never updates.
3. **`/:id/discover-models`** writes the inserted model row using the **old**
   model schema (`cost_per_input_token`, `good_for_code`, `good_for_creative`,
   etc.) — the live schema uses `cost_input` / `cost_output` /
   `capability_tags[]`. The insert silently drops these columns and stores
   zero costs / no capability tags for every auto-discovered model.
4. Four audit event-types fired by this file (`PROVIDER_TESTED`,
   `PROVIDER_DISCOVERY_FAILED`, `PROVIDER_MODELS_DISCOVERED`,
   `PROVIDER_REMOVED`) are **not** members of the `AuditEventType` union, so
   the writes type-check fail and (depending on compliance mode) silently
   degrade to "unknown event" in the audit trail.
**Fix:** narrow `id` with a `String(id)` coercion guarded by `!id`, use the
real `providerHealthTable` columns, rewrite the discover-models insert to the
current schema, and add the four missing event types to the union.

### H-5 — `MessageList`, `TriStateVector`, `TaskDetail` type errors
**Files:** `artifacts/bos-omega/src/components/MessageList.tsx:219`,
`TriStateVector.tsx:40`, `pages/TaskDetail.tsx:12`
**Symptom:** Three pre-existing `pnpm typecheck` failures:
- `MessageList.tsx:219` — array literal with widened `id: string` cannot be
  assigned to the narrower `"series" | "agents" | "synthesis"` union the
  consumer expects (means the section toggle silently drops to never-match).
- `TriStateVector.tsx:40` and `TaskDetail.tsx:12` — `useQuery` options object
  is missing `queryKey`, leaving the call type-incomplete (orval changed its
  options shape; we passed only `{ retry: false }` / `{ enabled, retry }`).
**Fix:** add the right literal-typed array, and pass the orval-provided
`getXxxQueryKey()` for both queries.

---

## MEDIUM findings (documented; not fixed in this pass)

### M-1 — Circuit breaker read-modify-write race
**File:** `src/bos/circuitBreaker.ts:53-92`
Two concurrent failures from the same provider both `select` the row, both
compute `failure_count + 1`, both `update` — final value is +1 instead of +2.
At our request volumes this skews the breaker thresholds slightly low (slower
to open) but does not cause incorrect failure handling. Fix in a follow-up by
moving to a SQL-side `failure_count = failure_count + 1` increment with the
`status` decision computed from the returning row. Deferred to keep this pass
focused on user-visible bugs.

### M-2 — SESSION_SECRET ephemeral fallback is fail-open
**File:** `src/lib/security/auth.ts:29-57`
When `SESSION_SECRET` is unset the server generates a random 48-byte ephemeral
key and proceeds. Sessions invalidate on restart; the warning is loud but the
boot does not fail. Recommended: in `production`, require `SESSION_SECRET >=
32` chars and `process.exit(1)` if missing. Deferred to avoid breaking the
local dev `pnpm dev` flow without an explicit env-management migration.

### M-3 — `req.params.id` typing is structurally unsafe across all routes
The fixes for H-4 use a `String(id)` coercion at the call sites. A repo-wide
fix is to add a typed-route helper (`req.params.id as string` after a
non-empty check) or route the request through a Zod-validated `params` schema
the way request bodies already are. Deferred — only the providers route is
currently red.

### M-4 — `executionEngine.callProvider` does not gate on `isCircuitOpen`
**File:** `src/bos/executionEngine.ts` (`callProvider` flow)
The breaker only records failures; it does not refuse calls when status is
`OPEN_CIRCUIT`. So an opened circuit still pays the latency cost of the
failed call. Adding a `if (await isCircuitOpen(provider_id)) return synthetic
failure` short-circuit at the top of `callProvider` would make the breaker
effective. Deferred — current behavior is safe (the calls fail fast at the
provider), just wasteful.

### M-5 — Memory engine token approximation is `chars / 4`
**File:** `src/bos/memoryEngine.ts` (token-budget heuristic)
Ratio is wrong for non-English and code-heavy inputs (under-counts tokens by
up to 2×). Practical impact: occasional 8K-context overflow on long Chinese
or code memory turns. Acceptable for the v1.x release; replace with `tiktoken`
or the provider's own counter when we add per-provider tokenization metadata.

### M-6 — `processVideo` reads frames sequentially after extraction
**File:** `src/lib/uploads/video.ts:148-163`
Already capped at `MAX_FRAMES = 6` so the unbounded-loop concern from earlier
chapters is mooted; documenting that the cap is the correct mitigation and
the loop is fine as-is.

---

## LOW findings (documented)

### L-1 — Inconsistent error-response shape across routes
Some routes return `{ error: "..." }`, some `{ error, code }`, some
`{ error, message }`. The frontend and orval client tolerate both, but a
single shared `ErrorResponse` Zod schema would simplify error handling and
audit log enrichment.

### L-2 — `mockup-sandbox` build requires `PORT` env
`pnpm -r build` fails for `@workspace/mockup-sandbox` without `PORT` set —
this is by-design from the artifacts skill, but worth a note in `replit.md`
so future `-r build` pre-commit checks know to inject a placeholder
(`PORT=0 pnpm -r build` works).

### L-3 — `ADMIN_PASSWORD` plaintext lingers in `process.env`
`initAdminPassword` hashes the password into memory but never deletes
`process.env["ADMIN_PASSWORD"]`. Any subprocess we spawn inherits it. Low
risk because we don't `spawn` user-supplied code, but a `delete
process.env["ADMIN_PASSWORD"]` after hashing would be cheap defense in depth.

### L-4 — `auditLog` event-type union is hand-maintained
The 40+-entry `AuditEventType` union is updated manually whenever a new event
is added (and it has been silently violated several times — see H-4). Move it
to a typed `enum` exported from `auditEngine.ts` and import the symbols at
call sites so the compiler can catch additions instead of relying on string
literal matching.

---

## What was verified (smoke)

- `pnpm -r typecheck` — clean across `api-server`, `bos-omega`, all libs.
- `pnpm -r build` — clean except the documented `mockup-sandbox` PORT note.
- API server startup with cookie-auth: `POST /api/auth/login` issues
  `bos_session`; `GET /api/providers` returns the seeded providers; the
  Providers/Models pages render without 400s on the toggle controls.
- BOS pipeline single-shot ABORT path (TRI_STATE_EVALUATED → TASK_ABORTED).
- BOS pipeline GO path (a `mode: parallel` request now correctly invokes
  three models — verified via the new mode-selector audit log).

## Post-review fixes (2026-04-26)

A code review caught two follow-ups after the initial pass; both fixed:

- **Greedy JSON parse in `executionEngine.parseOutput`** — The path that
  consumed direct (non-validated) model output still used a greedy
  `raw.match(/\{[\s\S]*\}/)`, so prose-mixed or fenced responses could
  silently default to `state: "GO"`. Fixed by exporting
  `extractJsonCandidate` from `validationEngine.ts` and reusing it from
  `executionEngine.parseOutput` so fenced ```` ```json ```` blocks and
  balanced-brace fallback work consistently with H-3.
- **TriState cache key hyphen mismatch (`TriStateVector.tsx`)** — The
  manually-supplied `queryKey` used `/api/tristate/by-task/...` while orval's
  generated default is `/api/tri-state/by-task/...` (matching the OpenAPI
  path). This would have fragmented the React Query cache and broken
  cross-component invalidation. Fixed to match orval exactly.

## What is NOT in scope of this audit

- Hardening v1.1 controls (already shipped, separately reviewed).
- Front-end visual / UX polish.
- Performance tuning (latency, cost-per-call optimization).
- Net-new features. Auto-proposed tasks #2–#5 (personas, super admin,
  PowerShell bridge, sidebar redesign) are not part of this audit.
