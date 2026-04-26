# R-1 + R-5 Implementation Plan

**Companion to:** `RUNTIME_AUDIT_2026-04-26.md`
**Status:** Plan only. No code applied. Awaiting approval.
**Scope discipline:** Backend runtime only. No UI, no schema migrations,
no new features outside what R-1 and R-5 require. All changes are additive
or surgical edits to existing files.

This document specifies exactly what would change, where, in what order,
with what fallback behavior, what tests, and what to roll back if a
problem surfaces.

---

## Why these two together

R-1 and R-5 are independent at the code level (different files, no shared
types) but pair together for one operational reason: **R-1 makes the
parallel/consensus modes finally produce different answers, and R-5 makes
it possible to verify, in the audit chain, *which model* actually produced
*which role's* answer and whether that call was real, proxied, or
mocked.** Without R-5, R-1's per-role attribution lives only in the
prose of the merged answer and can't be cross-checked.

Estimated total surface:

| Area | New files | Edited files | LOC delta (approx) |
|------|-----------|--------------|---------------------|
| R-1 | 1 (`bos/parallelRoles.ts`) | 2 (`executionEngine.ts`, `providerBridge.ts` *signature only*) | +180 / −20 |
| R-5 | 0 | 4 (`auditEngine.ts`, `keyResolver.ts`, `providerBridge.ts`, `executionEngine.ts`) | +120 / −15 |

No DB schema changes. No new tables, no new columns. All R-5 telemetry
rides on the existing `audit_logs.metadata` JSONB column and the existing
`model_attempts.error_type` enum (using a value already in the enum,
`unknown_exception`, paired with an audit event for the precise reason).

---

# R-1: Role-differentiated parallel & consensus modes

## R-1.0 Defect being fixed

`bos/executionEngine.ts:executeParallel` (line 126-182) sends the **same
prompt** to N models. The merge step labels them as if they were different
agents, but the underlying calls are identical except for the model
identity. The Task Console UI shows "Architect / Critic / Validator /
Researcher / Builder" as if they were independent perspectives — in
parallel/consensus mode this label is cosmetic.

## R-1.1 New file: `artifacts/api-server/src/bos/parallelRoles.ts`

Mirrors BTO's `AGENT_ROLES` / `AGENT_INSTRUCTIONS` pattern from
`boilTheOceanEngine.ts:15-54`, exported for re-use.

```ts
// Sketch only — exact final wording subject to review.

export type ParallelRole = "ARCHITECT" | "CRITIC" | "RESEARCHER" | "BUILDER" | "VALIDATOR";

export const PARALLEL_ROLES: ParallelRole[] = [
  "ARCHITECT", "CRITIC", "RESEARCHER", "BUILDER", "VALIDATOR",
];

export const PARALLEL_ROLE_INSTRUCTIONS: Record<ParallelRole, string> = {
  ARCHITECT:  "You are the ARCHITECT. Define structure, components, dependencies. Focus on HOW the answer should be organized.",
  CRITIC:     "You are the CRITIC. Find weak assumptions, gaps, contradictions, hallucination risk. Then propose corrections.",
  RESEARCHER: "You are the RESEARCHER. Distinguish known from uncertain. Block fake certainty. Flag where external sources would strengthen the answer.",
  BUILDER:    "You are the BUILDER. Convert ideas into concrete steps, schemas, code, action plans. Make it actionable.",
  VALIDATOR:  "You are the VALIDATOR. Check requirements match, completeness, safety. Your `state` field drives whether this output is used.",
};

/**
 * Assign roles round-robin across the N models the router selected.
 * Preserves model order from selectModel so the deterministic tie-break
 * still controls which model gets which role for a given (task, mode) pair.
 *
 * Returns N (model, role) pairs where N = models.length.
 *  - If models.length <= PARALLEL_ROLES.length: each model gets a unique role.
 *  - If models.length >  PARALLEL_ROLES.length: roles wrap; later roles repeat.
 *  - If models.length == 1: the single model still gets one role (ARCHITECT).
 *    The pipeline mode-selector should already prevent N==1 in parallel mode
 *    (executePipeline routes single-model parallel through executeSingle for
 *     identical behavior to today; see R-1.4).
 */
export function assignRoles(
  models: ModelScore[],
): Array<{ model: ModelScore; role: ParallelRole }>;

/**
 * Build the per-agent prompt overlay to prepend to the user's input.
 * Returns a string that becomes the model's "system" or "system-suffix"
 * depending on which adapter is being called (handled by R-1.3).
 */
export function buildRoleOverlay(role: ParallelRole, mode: "parallel" | "consensus"): string;
```

## R-1.2 Plumbing: per-call role overlay through `callProvider`

The bridge functions `callProvider` (`executionEngine.ts:253`) and
`callProviderDirect` (`providerBridge.ts:38`) already accept an `options`
bag with `persona_prompt`. Two viable approaches:

**Approach A (preferred):** Add a new optional field to `CallProviderOptions`
in `providerBridge.ts:19-24`:

```ts
export interface CallProviderOptions {
  attachment_context?: string;
  attachment_images?: VisionImage[];
  memory_context?: string;
  persona_prompt?: string;
  role_overlay?: string;   // NEW — appended after persona_prompt
}
```

Each adapter (`openaiAdapter.ts:92`, `anthropicAdapter.ts:24`,
`geminiAdapter.ts:24`) builds its system prompt as:

```
MASTER_PROMPT_KERNEL
  + (persona_prompt ? "\n\n" + persona_prompt : "")
  + (role_overlay   ? "\n\n" + role_overlay   : "")  // NEW
  + (memory_context ? "\n\n" + memory_context : "")
```

This places role_overlay *after* persona (so persona sets domain
formatting like "legal memo structure") and the role refines *what
perspective* the model takes inside that domain frame. Memory comes last
so it doesn't override role direction.

**Approach B (rejected):** Splice the overlay into the `input` string. This
would muddle the user's actual question with framing instructions and
break vision routing (the input is also where image references would go).

## R-1.3 Edit: `bos/executionEngine.ts:executeParallel`

Replace the homogeneous dispatch loop (`executionEngine.ts:134`):

```ts
// BEFORE
const calls = models.map((m) => callProvider(ctx, m, memory_context));

// AFTER
const assignments = assignRoles(models);  // [{model, role}, ...]
const calls = assignments.map(({model, role}) =>
  callProvider(ctx, model, memory_context, {
    role_overlay: buildRoleOverlay(role, ctx.mode as "parallel" | "consensus"),
  }),
);
```

`callProvider` gains an optional fifth argument (the extra options bag)
that flows into the existing `buildOptions` helper (`executionEngine.ts:48`):

```ts
function buildOptions(
  ctx: TaskContext,
  memory_context: string,
  supports_vision: boolean,
  extras?: { role_overlay?: string },  // NEW
) {
  return {
    memory_context,
    attachment_context: ctx.attachment_context,
    images: supports_vision ? ctx.attachment_images : undefined,
    persona_prompt: buildPersonaSystemSuffix(ctx.persona) || undefined,
    role_overlay: extras?.role_overlay,
  };
}
```

`mergeParallelResponses` (`executionEngine.ts:184`) is updated to preserve
role attribution in the returned `parallel_responses[].model` field —
matching the format BTO already uses
(`boilTheOceanEngine.ts:462: \`${ao.model} [${ao.role}]\``):

```ts
parallel_responses.push({
  provider: model_info.provider_name,
  model: `${model_info.model_name} (${role})`,  // CHANGED
  …
});
```

## R-1.4 Pipeline guard: do not enter parallel with N=1

`bos/pipeline.ts` mode dispatch (around the `executePipeline` call site)
should downgrade `mode === "parallel" | "consensus"` to `single` when
`selectModel` returns only one model. This is already the *de facto*
behavior of `mergeParallelResponses` (a single response just becomes the
output) but we should make it explicit and audit-event it
(`MODE_DOWNGRADED` already exists in `AuditEventType`).

Reason: with one model and one role overlay, parallel mode would produce
strictly worse output than single mode (one model talking to itself with
a forced "CRITIC" frame, no other agents to critique). The audit event
makes the downgrade visible.

## R-1.5 Behavior changes user will see

| Before | After |
|--------|-------|
| 5 parallel responses look like 5 paraphrases of the same answer | 5 parallel responses cover 5 distinct angles (structure, critique, evidence, implementation, validation) |
| Task Console "Architect" tab shows generic answer | Task Console shows answer reframed by ARCHITECT instructions |
| Consensus mode majority vote on near-duplicate answers (always passes consensus) | Consensus mode majority vote on genuinely different opinions (occasionally fails consensus, which is correct) |
| `parallel_responses[].model = "gpt-4o"` | `parallel_responses[].model = "gpt-4o (CRITIC)"` |
| Single-model parallel runs anyway, produces nothing useful | Single-model parallel auto-downgrades to single mode with `MODE_DOWNGRADED` audit event |

## R-1.6 Edge cases

1. **Persona × role interaction.** Personas (legal/engineering/cyber)
   already set output structure (sections like "Issue", "Analysis", etc.).
   Role overlay refines perspective. Order matters: persona first
   (domain frame), role second (perspective within domain). The cyber
   persona's "defensive framing only" rule wins over any role overlay
   because persona prompt is rendered first and the kernel's safety
   directives are absolute.

2. **Validator role state field.** The VALIDATOR role's instructions tell
   it that `state` drives whether its output is used. In consensus mode
   this combines naturally with the existing majority-vote logic
   (`executionEngine.ts:187-199`): a VALIDATOR returning ABORT will
   trigger the early ABORT path. This is a desirable side-effect, not a
   bug.

3. **Multimodal frames.** Images are routed by `supports_vision` which
   is a *model* property, not a *role* property. So if RESEARCHER role
   is assigned to a non-multimodal model, that model still won't get
   the images. This matches BTO's behavior and is correct.

## R-1.7 Test plan (no UI changes required to verify)

1. **Direct adapter sanity** (no DB): unit-style script that calls
   `buildRoleOverlay("CRITIC", "parallel")` and asserts the returned
   string contains the CRITIC instructions and not other roles'.

2. **End-to-end via API** (real DB, real proxy keys): POST to
   `/api/tasks` with `mode=parallel`, `max_models=5`, a non-trivial
   prompt. Assert:
   - response `parallel_responses` has 5 entries with distinct `model`
     suffixes (`(ARCHITECT)`, `(CRITIC)`, …)
   - the `answer` text from each role is materially different
     (Levenshtein distance > 30% between any two roles)
   - audit_logs for the task has 5 distinct `LLM_CALL_STARTED` events

3. **Single-model downgrade**: POST with `parallel_models: ["only-gemini"]`
   that resolves to one model. Assert `MODE_DOWNGRADED` event present
   and response shape matches single-mode output.

4. **Consensus genuine disagreement**: craft a prompt where the
   VALIDATOR role would reasonably ABORT (e.g., a high-stakes prompt
   missing a critical input). Assert the consensus result correctly
   surfaces the ABORT instead of being averaged away.

## R-1.8 Rollback

Single revert of `parallelRoles.ts` (delete) and the three edited files
restores prior behavior. No DB changes to undo. Existing tasks in the DB
remain readable — the only field shape change is `parallel_responses[].model`
gaining a `(ROLE)` suffix, which the UI renders as plain text and tolerates.

---

# R-5: Surface proxy/mock state in the audit chain

## R-5.0 Defect being fixed

`callProviderDirect` (`providerBridge.ts:38`) and `callProvider`
(`executionEngine.ts:253`) call `resolveProviderKey` and forward the
returned `base_url` for proxy substitution — but **emit no audit event**
distinguishing a vendor-direct call from a proxied call from a mock-mode
fabrication. On this workspace right now, every "live" call is going
through the Replit AI Integrations proxy and there is no way to verify
that from the Task Console.

Additionally, `mockResult` (`executionEngine.ts:300`,
`providerBridge.ts:98`) returns `success: true` with fabricated latency
and token counts. A mocked call is indistinguishable from a successful
real call in the audit chain — only the prose answer text contains a
`[MOCK MODE - …]` notice.

## R-5.1 New audit event types (additive to `AuditEventType` union)

Edit `bos/auditEngine.ts:8-65`:

```ts
type AuditEventType =
  | …existing…
  | "KEY_RESOLVED"        // NEW: emitted right after resolveProviderKey
  | "PROXY_CALL"          // NEW: emitted before a call routed via proxy
  | "MOCK_MODE_USED"      // NEW: emitted when no key resolves
  ;
```

Adding to a union is purely additive — DB column is a free-form text
field (`event_type` text), so no migration. Existing readers
(`routes/tasks.ts:209` reads everything for a task) tolerate unknown
event types gracefully.

## R-5.2 Edit: `lib/keyResolver.ts:25-48` — return key fingerprint

`ResolvedKey` already returns `source` and `base_url`. We need one more
piece for safe auditing: a non-reversible **fingerprint** of the key so
the audit shows *which* key was used (e.g., did the operator's recent
key rotation actually take effect?) without exposing the key itself.

```ts
export interface ResolvedKey {
  key: string;
  source: "db" | "env" | "legacy" | "proxy" | "none";
  base_url?: string;
  key_fingerprint?: string;   // NEW — first 4 + "..." + last 4 of SHA-256(key)
}
```

Computed once in each branch (`resolveProviderKey`):

```ts
function fingerprint(key: string): string {
  if (!key) return "";
  const h = createHash("sha256").update(key).digest("hex");
  return `${h.slice(0, 4)}…${h.slice(-4)}`;
}
```

The fingerprint is **never** the key itself, never the prefix of the
key, and is stable across calls so an operator can see "is this the
same key as last week?"

## R-5.3 Edit: `bos/providerBridge.ts:38-96` and `bos/executionEngine.ts:253-298`

Both callers of `resolveProviderKey` get the same audit-event treatment.
Refactored sketch (applied identically in both files; the duplication
between these two functions is itself a separate hygiene issue but
out of scope for R-5):

```ts
const resolved = await resolveProviderKey(model_info.provider_id, model_info.provider_name);
const { key, source, base_url, key_fingerprint } = resolved;

// New: always emit a KEY_RESOLVED event, regardless of source.
await auditLog(ctx.task_id, "KEY_RESOLVED",
  `Resolved ${model_info.provider_name} key from source=${source}`,
  {
    provider_id: model_info.provider_id,
    provider_name: model_info.provider_name,
    model: model_info.model_name,
    source,                              // db | env | legacy | proxy | none
    base_url: base_url || null,          // null for direct vendor calls
    is_proxy: source === "proxy",
    key_fingerprint: key_fingerprint || null,
    has_key: !!key,
  },
);

if (!key) {
  // R-5.4: switch from silent success to clear failure
  await auditLog(ctx.task_id, "MOCK_MODE_USED",
    `No key resolved for ${model_info.provider_name} — returning mock`,
    { provider_id: model_info.provider_id, model: model_info.model_name },
  );
  return mockResult(model_info, prompt, task_type);   // semantics changed in R-5.4
}

if (source === "proxy") {
  await auditLog(ctx.task_id, "PROXY_CALL",
    `Routing ${model_info.provider_name} call via Replit AI Integrations proxy`,
    { provider_name: model_info.provider_name, model: model_info.model_name, base_url },
  );
}
```

Three audit events fire per call (KEY_RESOLVED always, plus optionally
PROXY_CALL or MOCK_MODE_USED). The pre-existing `LLM_CALL_STARTED`
fires after, in unchanged order. Audit fan-out cost is +1-2 inserts per
call; rates are bounded by `expensiveLimiter` in `routes/tasks.ts:20` so
this is not a write-amp risk.

## R-5.4 Mock mode: become honest

Edit both `mockResult` definitions (`executionEngine.ts:300` and
`providerBridge.ts:98`).

**Behavior change:**

| Field | Before | After |
|-------|--------|-------|
| `success` | `true` | `false` |
| `error_type` | absent | `"unknown_exception"` (existing enum value) |
| `error_message` | absent | `"No API key configured for <provider>; mock response returned"` |
| `raw_response` | JSON envelope with mock answer | unchanged (so the UI can still display the explanation) |
| `latency_ms` | random 50–350 | actual elapsed (still tiny — no network call) |
| `token_input` / `token_output` | fabricated | `0` |
| `cost_estimate` | `0` | `0` (unchanged; already correct) |

Downstream effect:

1. `executePipeline` (`executionEngine.ts:76`) sees `!result.success` and
   takes the existing fallback path — but with no other key-having
   provider available it ends up in `buildSafeFailure`
   (`executionEngine.ts:122-124`), which is the *honest* outcome:
   "BOS-OMEGA could not complete this task. All available LLM providers
   have been exhausted or are unavailable."
2. `executeParallel` (`executionEngine.ts:152`) treats the mock as a
   failed parallel call. If at least one real call succeeds, the merge
   proceeds with the real responses. If every parallel call mock-fails,
   the existing `parallel_responses.length === 0` branch produces
   `buildSafeFailure` — again, honest.
3. `provider_health` `recordFailure` path runs for mocked calls. This is
   *correct*: a provider with no resolvable key is unhealthy. After the
   circuit breaker opens, `selectModel` filters it out
   (`modelRouter.ts:49`), preventing repeated futile dispatch.

The Task Console will visibly stop receiving "successful" mock answers
and start receiving HOLD with a clear failure mode listing
"No API key configured for X." This is the user-facing change R-5
delivers.

## R-5.5 Health-stats and circuit-breaker edge cases

The change from `success:true` → `success:false` for mock results means
`provider_health` will show formerly-mocked providers as failing. This
is correct but is a behavior change worth flagging:

- **Workspaces that intentionally use mock mode** (e.g. e2e tests where
  no keys are configured) will now see HOLD outcomes instead of canned
  success. This is desirable but breaks any test that asserted
  `state === "GO"` on a no-key workspace. Test fix: those tests should
  configure the proxy or assert `state === "HOLD"` with a known message.
- **Providers behind a Replit AI Integration** are unaffected — the
  proxy keys *do* resolve, source=proxy, the call proceeds normally,
  PROXY_CALL is audited.
- **Self-hosted Ollama** path
  (`executionEngine.ts:290-293`,`providerBridge.ts:88-91`) doesn't go
  through `resolveProviderKey` at all — it uses `provider.base_url ||
  process.env.OLLAMA_BASE_URL || "http://localhost:11434"`. R-5 should
  also emit a `KEY_RESOLVED` event for Ollama with `source="env"` and
  `base_url=<resolved url>`, `key_fingerprint=null`. Concretely: add the
  same audit fan-out at the Ollama branch with synthetic source.

## R-5.6 What R-5 does **not** do

- Does not log the API key. Only fingerprint (4+4 chars of SHA-256).
- Does not redact existing audit events. Backward-compatible with
  existing audit reader at `routes/tasks.ts:209`.
- Does not add a new table. Uses existing `audit_logs` with the existing
  JSONB `metadata` column (already used by other events:
  `auditEngine.ts:113-117`).
- Does not change the response shape returned to the user. Adds info
  only to the audit pane.

## R-5.7 Test plan

1. **No-keys path** (set DATABASE_URL + clear all `AI_INTEGRATIONS_*`
   and vendor envs in a scratch shell): POST to `/api/tasks` with a
   simple prompt. Assert:
   - `KEY_RESOLVED` event with `source: "none"` for each attempted
     provider.
   - `MOCK_MODE_USED` event with provider/model details.
   - Final response state is `HOLD` (not `GO`).
   - `provider_health` rows show the providers as failed
     (`recordFailure` ran).

2. **Proxy path** (current workspace state): POST a normal task. Assert:
   - `KEY_RESOLVED` event with `source: "proxy"` and a non-null
     `base_url` matching `AI_INTEGRATIONS_*_BASE_URL`.
   - `PROXY_CALL` event present immediately before `LLM_CALL_STARTED`.
   - No `MOCK_MODE_USED` event.
   - Final response succeeds normally.

3. **DB-key path** (paste a key via Settings): POST a task. Assert:
   - `KEY_RESOLVED` event with `source: "db"`.
   - No `PROXY_CALL`, no `MOCK_MODE_USED`.
   - `key_fingerprint` is present and stable across two consecutive
     calls.

4. **Direct vendor path** (set `OPENAI_API_KEY` env): POST a task. Assert
   `KEY_RESOLVED` event with `source: "legacy"` and `base_url: null`.

5. **Fingerprint privacy**: assert that the audited `key_fingerprint`
   does **not** appear as a prefix or substring of the actual key in
   any log file (grep over /tmp/logs and the durable audit queue).

## R-5.8 Rollback

R-5 is purely additive event emission plus the mock-mode honesty flip.
Three-step rollback if needed:

1. Remove the new event-type union members. (Old events stay in the DB
   but the code stops emitting them — readers tolerate unknown types.)
2. Revert the mock-mode `success: true → false` change. (One-line per
   file in two files.)
3. Revert the `key_fingerprint` field on `ResolvedKey`. (Optional; the
   field is opt-in and unused after step 1.)

No data migration to undo. Audit log entries from R-5 remain readable
and inspectable, simply no new ones generated.

---

## Sequencing & dependencies

```
R-1.1  parallelRoles.ts                       ─┐
R-1.2  CallProviderOptions.role_overlay        ├─ ship together
R-1.3  executeParallel role assignment         │   (one PR / one commit)
R-1.4  N=1 downgrade guard                     │
R-1.5  parallel_responses[].model suffix      ─┘

────────────────  independent commit  ────────────────

R-5.1  AuditEventType union additions          ─┐
R-5.2  ResolvedKey.key_fingerprint              │
R-5.3  KEY_RESOLVED / PROXY_CALL emission       ├─ ship together
R-5.4  mockResult honesty flip                  │
R-5.5  Ollama branch parity                    ─┘
```

R-1 and R-5 do not depend on each other and can ship in either order
or in parallel. R-5 is shorter and lower-risk; R-1 has more behavioral
change. If both go in the same task, recommend R-5 first so the audit
events are in place to verify R-1's per-role calls.

## Out of scope for this plan

- R-2 (decouple JSON envelope from reasoning) — bigger blast radius,
  separate task.
- R-3, R-4 (validator honesty + tri-state softening) — separate task.
- R-6 (InputGate regex retuning) — separate task.
- R-7..R-10 — separate tasks.
- Any UI work — explicitly excluded.
- Any schema change — explicitly excluded.
- Any change to the cross-tenant attachment guard, rate limits,
  circuit breaker, or modelRouter scoring — out of scope.

---

## Summary table for sign-off

| Item | Files | New events | Schema? | DB write/call | Risk |
|------|-------|-----------|---------|---------------|------|
| R-1.1 | +`parallelRoles.ts` | none | none | none | low |
| R-1.2 | `providerBridge.ts` (signature) | none | none | none | low |
| R-1.3 | `executionEngine.ts` | none | none | none | medium (changes parallel call wiring) |
| R-1.4 | `pipeline.ts` | reuses `MODE_DOWNGRADED` | none | +0-1 audit | low |
| R-1.5 | `executionEngine.ts` (merge) | none | none | none | low |
| R-5.1 | `auditEngine.ts` | +3 union members | none | none | low |
| R-5.2 | `keyResolver.ts` | none | none | none | low |
| R-5.3 | `providerBridge.ts`, `executionEngine.ts` | KEY_RESOLVED, PROXY_CALL, MOCK_MODE_USED | none | +1-2 audit per call | low |
| R-5.4 | `executionEngine.ts`, `providerBridge.ts` (mockResult) | none | none | none | medium (changes provider_health behavior on no-key workspaces) |
| R-5.5 | `executionEngine.ts`, `providerBridge.ts` (Ollama branch) | KEY_RESOLVED | none | +1 audit | low |

Total: ~300 LOC delta, 5 edited files, 1 new file, 0 schema changes,
3 new audit event types, 0 UI changes.

Awaiting approval before any code is written.
