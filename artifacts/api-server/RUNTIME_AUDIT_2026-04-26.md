# BOS-OMEGA Runtime Forensic Audit — 2026-04-26

**Scope:** Backend orchestration runtime (`artifacts/api-server`) — pipeline,
execution engines, tri-state governor, model router, provider adapters, key
resolver. Front-end is **out of scope** by user directive.
**Method:** Static read of every code path the Task Console exercises
(`runBosPipeline → executePipeline | runBoilTheOcean | runSeriesPass →
callProviderDirect → adapter → resolveProviderKey`), cross-referenced against
the live `process.env` state and the existing post-Hardening `AUDIT_REPORT.md`.
**Ground rule:** *Findings only.* No production code was modified. A
remediation plan is included at the end; nothing in it has been applied.

---

## 0. Headline summary

The user's instinct was largely correct. Three of the four concerns are real
and reproducible from the source. One (provider registry being cosmetic) is
*partially* true in a worse way than expected: the registry **is** wired to
real adapters, but **every live call right now is silently routed through
the Replit AI Integrations proxy** because no direct vendor keys are
present, and that substitution is **never audited or surfaced**.

| # | User concern | Verdict | Severity |
|---|-------------|--------|----------|
| 1 | Agents produce homogeneous outputs / not independently called | **Confirmed** for `parallel` & `consensus` modes; partial for `series_pass`; mostly false for `boil_the_ocean` | **HIGH** |
| 2 | Tri-State suppresses reasoning *pre-execution* | **Confirmed** — kernel forces JSON envelope + GO/HOLD/ABORT self-categorization on every model call | **HIGH** |
| 3 | HOLD / ABORT triggers excessively on benign prompts | **Confirmed** — collapse rule defaults to HOLD, classifier confidence drives the GO floor, high-stakes domains are nearly impossible to GO | **HIGH** |
| 4 | Quality below model-registry capability | **Confirmed downstream effect** of #1 + #2 + the synthesis collapse in BTO | **MEDIUM** |
| 5 | Provider registry cosmetic / silently proxied | **Adapters are real**, but **proxy substitution is silent and unaudited**, and **mock-mode looks identical to a successful call** in the audit chain | **HIGH** |

Severity scale: CRITICAL = produces wrong/unsafe answers; HIGH = produces
materially-degraded answers or hides truth from operator; MEDIUM = quality
ceiling; LOW = cosmetic.

---

## 1. Architecture map (as actually wired)

```
POST /api/tasks
   │
   ▼
runBosPipeline(input, mode, …)                              [bos/pipeline.ts]
   │
   ├── runInputGate(input)                                  [bos/inputGate.ts]
   │      ├─ regex UNSAFE_PATTERNS  → ABORT
   │      ├─ regex MISSING_INFO     → HOLD
   │      └─ detectIntent / assessRisk
   │
   ├── classifyTask(input)                                  [bos/taskClassifier.ts]
   │      └─ keyword scoring → { task_type, confidence∈[0,1] }
   │
   ├── selectModel(task_type, len, mode, count)             [bos/modelRouter.ts]
   │      └─ DB JOIN llm_models × llm_providers × provider_health
   │         scored by capability+reliability+context+latency+cost+health,
   │         deterministic tie-break, returns top-N ModelScore[]
   │
   ├── evaluateTriState({...,validation_passed:TRUE})       [bos/triState.ts]
   │      └─ vector math + collapse → GO | HOLD | ABORT
   │         If HOLD/ABORT → return early, NO MODEL CALL.
   │
   └── if GO:  dispatch by mode
         ├── single        → executePipeline(ctx, models[0:1])
         ├── parallel      → executePipeline(ctx, models[0:N])  ← N identical prompts
         ├── consensus     → executePipeline(ctx, models[0:N])  ← N identical prompts
         ├── series_pass   → runSeriesPass(ctx, models)         [bos/seriesPassEngine.ts]
         └── boil_the_ocean→ runBoilTheOcean(ctx, models)       [bos/boilTheOceanEngine.ts]
```

`callProviderDirect` (`bos/providerBridge.ts`) is the single funnel into all
adapters. It calls `resolveProviderKey(provider_id, name)`
(`lib/keyResolver.ts`) whose priority is **DB-encrypted → env → legacy env →
Replit AI Integrations proxy → none**. When `none`, `mockResult` is returned
with `success: true` (this is finding F-7 below).

---

## 2. Findings

Each finding lists severity, the precise file:line evidence, the user-visible
symptom, and the root cause.

---

### F-1  `parallel` and `consensus` modes have **no role differentiation** — they send the **same prompt to N models**

**Severity:** HIGH
**User-visible symptom:** "All agents say roughly the same thing." "Critic and Validator look identical."
**Files:** `bos/executionEngine.ts:executeParallel`, `bos/pipeline.ts:executePipeline`

In `executePipeline`, the prompt fed to every model in a parallel batch is a
single string built once from `input + memory_context + attachment_context`.
That string is then handed to every adapter in `executeParallel`:

```ts
// executionEngine.ts (executeParallel)
const promises = models.map(m => callProviderDirect(prompt, task_type, m, options))
//                                  ^^^^^^^^ same string for every model
```

There is **no per-model role overlay**. Persona (`legal | engineering | cyber`)
is selected per-task, not per-agent, so all parallel models also get the same
persona prompt. The "agents" the user sees in the UI for parallel/consensus
mode are **not five different agents** — they are five different *models*
answering the *same* question with the *same* JSON envelope. They will
naturally converge. The merge step (`mergeParallelResponses`) just picks the
highest-confidence response and tags the rest as supporting context with a
hardcoded "[MERGED SYNTHESIS]" footer — there is no semantic synthesis.

Role differentiation **does** exist in `series_pass`
(`DRAFTER → CRITIC → EXPANDER → ADVERSARY → SYNTHESIZER`) and `boil_the_ocean`
(`AGENT_ROLES` × `bto_models`). It does **not** exist in `parallel` /
`consensus`.

**Why this matters:** the Task Console UI advertises "Architect, Critic,
Validator, Researcher, Builder" as if they were independent personas. In
parallel/consensus modes that label is **cosmetic** — the underlying call is
the same prompt to N models. This is the largest single contributor to the
"homogeneous outputs" complaint.

---

### F-2  Master Prompt Kernel forces JSON envelope + tri-state self-report **into every reasoning call**

**Severity:** HIGH
**Files:** `providers/prompts.ts:1-36`, used unconditionally as the system
prompt in `openaiAdapter.ts:92`, `anthropicAdapter.ts:24`, `geminiAdapter.ts:24`

The kernel prepended to every model call mandates:

> You MUST return ONLY a valid JSON object with exactly this schema:
> `{ state, task_type, answer, assumptions, uncertainties, missing_inputs, failure_modes, recommended_next_action }`
> If answerable and safe: `state="GO"` …

Three downstream effects:

1. **Token budget burn on envelope.** Every response carries 6 metadata
   arrays. For short answers, the envelope is larger than the answer. This
   compounds across 5 series-pass roles or 25 BTO agents.

2. **Self-categorization perversely incentivized.** `validationEngine.computeConfidence`
   *multiplies the score by 0.8 if `uncertainties.length > 2`* and
   *by 0.9 if any `failure_modes` exist*. A model is **penalized for honesty.**
   Combined with the GO floor at confidence ≥ 0.70 (general) / 0.85
   (high-stakes), models that admit uncertainty get bumped to HOLD, while
   models that under-report uncertainty get GO. This actively trains the
   pipeline toward overconfident answers.

3. **Pre-execution governance leakage.** The kernel says "If unsafe… `state=ABORT`."
   So the **model itself** is asked to apply BOS governance categories
   *before* any external evaluator. This conflates reasoning with policy —
   the very thing the user reported. A model deciding "this is HOLD" stops
   producing the answer it would otherwise produce.

The kernel is identical for all five "agents" in BTO mode — only the
agent-role suffix differs. Persona prompts (`buildPersonaSystemSuffix`) are
appended **after** the kernel and inherit the same JSON-only constraint.

---

### F-3  Tri-State collapse is **strictly pre-execution** and biased to HOLD

**Severity:** HIGH
**Files:** `bos/pipeline.ts:226-275` (call site), `bos/triState.ts:317-358` (collapse rules)

The tri-state engine is evaluated **once, before any model is called**, with
this critical line at `pipeline.ts:256`:

```ts
const triStateInput: TriStateInput = {
  …
  validation_passed: true,   // ← hardcoded; nothing has been validated yet
  …
};
```

Collapse rules (`triState.ts:317-358`):

| Rule | Condition | Result |
|------|-----------|--------|
| 1 | `hard_safety_abort` | ABORT (vetoes vector) |
| 2 | `vector.abort ≥ 0.65` | ABORT |
| 3 | `missing_info.length > 0` | HOLD |
| 4 | `!provider_available` | HOLD |
| 5 | `vector.go ≥ 0.75` ∧ `validation_passed` ∧ `confidence ≥ requiredConfidence` | **GO** |
| 6 | otherwise | **HOLD** (safe default) |

Confidence floor (`triState.ts:68-71`):

```ts
HIGH_STAKES = {legal, medical, financial, code, security}
required = HIGH_STAKES.has(task_type) ? 0.85 : 0.70
```

The `confidence_score` fed in is `classification.confidence`
(pipeline.ts:255) — which is the **task classifier's keyword-scoring
heuristic**, not the model's confidence. A vague prompt like "Help me think
through this" yields classifier confidence around 0.5 and instantly fails
rule 5. For high-stakes (`code`, `legal`, `security`) tasks the floor is 0.85;
even well-formed prompts often score 0.6–0.75 in the classifier and
deterministically collapse to HOLD by rule 6.

Empirical accumulation toward GO:

- Starting vector: `(go=0.33, hold=0.34, abort=0.33)`.
- Big GO pushers in benign cases: `safe_request +0.20`, `required_inputs_present +0.20`, `clear_user_intent +0.20` (only fires if `intent_clarity ≥ 0.75`), `high_confidence +0.18` (only fires if `confidence_score ≥ 0.75`).
- Big HOLD pushers that fire easily: `ambiguous_user_intent +0.25` (when `intent_clarity ≤ 0.4`), `low_confidence +0.20`, `medium_risk_intent +0.18`, `high_stakes_domain +0.20` (legal/code/security).

For a **benign code question** with classifier confidence 0.7, `intent_clarity`
inherited from the same value: GO accumulates ~0.20 (safe) + 0.20 (info
present) + 0 (no `clear_user_intent`, threshold not met) + 0 (no
`high_confidence`) = `0.40` net push. After normalization the GO amplitude
typically lands around 0.55-0.65 — **below the 0.75 GO threshold**. Rule 5
fails, rule 6 collapses to HOLD. The user sees HOLD with no explanation that
it was the *classifier*, not the *content*, that triggered it.

The post-execution validation result is recorded in `validationResultsTable`
but **is not fed back into a second tri-state pass**. The governance loop is
therefore one-sided: it can suppress reasoning before it happens, but it
cannot reconsider after execution.

---

### F-4  InputGate regexes are over-broad and produce false ABORTs on benign security/IT prompts

**Severity:** MEDIUM-HIGH
**File:** `bos/inputGate.ts:3-10`

```ts
const UNSAFE_PATTERNS = [
  /\b(hack|crack|exploit|bypass)\b.*\b(system|server|database|account)\b/i,
  /\b(create|generate|make|build)\b.*\b(malware|virus|ransomware|trojan|spyware)\b/i,
  …
];
```

Triggering examples that would **incorrectly ABORT**:

- *"How do I detect a brute-force exploit attempt against my server?"*
  matches pattern 1 (`exploit … server`). Defensive question → ABORT.
- *"My account got bypassed by an attacker, what logs should I check?"*
  matches `bypass … account` → ABORT.
- *"Build a detection rule for ransomware behavior"* matches
  `build … ransomware` → ABORT, despite being a *defensive* request that the
  `cyber` persona is explicitly designed for.

`MISSING_INFO_PATTERNS` (`inputGate.ts:12-15`) is also too aggressive:

```ts
/^(help|tell me|explain|what is|how do I)\s*$/i,   // exact-match short prompts
/^.{0,5}$/,                                         // anything ≤ 5 chars
```

The exact-match form is fine, but combined with the ABORT severity above and
the HOLD-default collapse rule, the cumulative effect is what the user
reported as "HOLD/ABORT triggers too easily."

There is **no allow-list** for explicitly defensive intent (e.g. "detect",
"prevent", "audit", "investigate") and **no semantic safety judgment**
delegated to the model — only regex.

---

### F-5  Provider registry is real, but **proxy substitution is unaudited and indistinguishable from a direct call**

**Severity:** HIGH
**Files:** `lib/keyResolver.ts:25-48`, `bos/providerBridge.ts:38-96`,
`bos/auditEngine.ts` (no PROXY_USED event exists)

Live state on this workspace right now:

```
OPENAI_API_KEY                       <unset>
ANTHROPIC_API_KEY                    <unset>
GEMINI_API_KEY                       <unset>
AI_INTEGRATIONS_OPENAI_API_KEY       <set>
AI_INTEGRATIONS_OPENAI_BASE_URL      <set>
AI_INTEGRATIONS_ANTHROPIC_API_KEY    <set>
AI_INTEGRATIONS_ANTHROPIC_BASE_URL   <set>
AI_INTEGRATIONS_GEMINI_API_KEY       <set>
AI_INTEGRATIONS_GEMINI_BASE_URL      <set>
```

Every "live" call right now is therefore routed through
`AI_INTEGRATIONS_*_BASE_URL`. The adapter forwards that base URL silently
(`providerBridge.ts:60-95`). The audit log records:

```
PROVIDER_CALL_STARTED   provider=openai model=gpt-4o
PROVIDER_CALL_COMPLETED provider=openai model=gpt-4o latency=1234ms
```

There is **no event** indicating:

- which `source` returned the key (`db | env | legacy | proxy | none`),
- whether the request URL was the vendor URL or the proxy URL,
- whether the credential charged was a Replit credit or a vendor key.

If the operator inspects the audit chain to validate "we are calling the
real OpenAI," they cannot tell from BOS-OMEGA's own records. The user's
suspicion that "it might be silently proxied" is **factually correct on this
workspace** — and unobservable from the audit UI.

This is the correct architectural choice (the proxy lets the workspace work
without keys), but the **silence** is the defect.

---

### F-6  Mock mode is `success: true` and looks identical to a real successful call

**Severity:** HIGH
**File:** `bos/providerBridge.ts:98-133`

```ts
function mockResult(model_info, prompt, task_type): LLMCallResult {
  …
  return {
    success: true,                                 // ← reported as a success
    raw_response: JSON.stringify({ ...mock, ... }),
    latency_ms: Math.floor(Math.random()*300)+80, // ← fake plausible latency
    token_input: Math.floor(prompt.length / 4),   // ← fake token count
    token_output: 200,
    cost_estimate: 0,
    provider: model_info.provider_name,
    model: model_info.model_name,
  };
}
```

Trigger: `resolveProviderKey` returns `{key: ""}`. This happens for any
provider where DB+env+legacy all fail **and** no Replit AI Integration is
configured (e.g., a self-hosted Ollama with an unreachable `OLLAMA_BASE_URL`,
or a custom-OpenAI-compatible provider with missing `base_url`).

The only signal of mock-mode is the literal string
`[MOCK MODE - No API key configured]` *inside the `answer` field*. There is:

- no `success: false` flag,
- no `error_type`,
- no audit event (`MOCK_MODE_USED` does not exist),
- no marker in `model_attempts.cost_estimate` other than `0` (which a real
  free-tier call would also produce),
- no impact on `provider_health` (so a fully-broken provider stays
  `HEALTHY` forever).

Combined with F-5, an operator looking at the Task Console cannot
distinguish: real vendor call, proxied call via Replit credits, or fabricated
mock response. The "answers" tab will show the mock canned text, but the
metadata tabs say "GPT-4o, 1234 tokens, $0.00" with `state: GO`.

---

### F-7  Boil-The-Ocean synthesis collapses N independent agents through a **single synthesis call** by one model

**Severity:** MEDIUM
**File:** `bos/boilTheOceanEngine.ts:369` area (`runSynthesisCall`)

BTO genuinely does role-differentiated parallel work
(5 models × 5 roles = 25 agents, each with its own `AGENT_INSTRUCTIONS`
overlay). But the final synthesis is performed by **a single model** (the
top-ranked model from `selectModel`) which is given all 25 agent outputs
and asked to merge them.

Two consequences:

1. The final answer reflects the synthesis model's bias and writing style,
   not the diversity of the 25 agents. Adversarial findings from BTO's
   `ADVERSARY` agents survive only if the synthesis model chooses to
   foreground them.
2. If only one provider is configured (the current state of this workspace,
   given all proxy-only keys), all 5 `bto_models` collapse to the same
   provider. `selectModel` returns up to N distinct *models*, but if a
   provider exposes only one model in `llm_models`, BTO ends up with **one
   model playing 25 different roles, then synthesizing with itself**. This
   is a softer version of the audit H-2 failure mode that Series-Pass
   already guards against — BTO has no equivalent guard.

There is no minimum-distinct-providers check in BTO comparable to the
`models.length < 2` guard in `runSeriesPass`.

---

### F-8  Series-Pass propagates only the prose `answer` between passes; structured signals are dropped

**Severity:** MEDIUM
**File:** `bos/seriesPassEngine.ts:140-244`

After each pass:

```ts
current_answer = pass_output.answer;     // only the answer text survives
validation_notes.push(`Pass N (ROLE): score=…, errors=[…]`); // capped at 5
```

The `assumptions`, `uncertainties`, `missing_inputs`, `failure_modes`, and
`errors_found` from each pass are **persisted to `series_passes` table** but
**not threaded into the next prompt** beyond a 2-element preview of
`errors_found`. A CRITIC pass that identifies five real flaws will see at
most two of them appear in the EXPANDER's prompt context. The remaining
flaws are silently lost from the chain even though they are saved to the
DB for post-hoc inspection.

---

### F-9  No `selected_model` vs `invoked_model` divergence detection

**Severity:** MEDIUM
**Files:** `bos/modelRouter.ts`, `bos/providerBridge.ts`,
`bos/auditEngine.ts`

`selectModel` returns a ranked list. The pipeline uses these in order. But
there is no audit event recording the selected model **at decision time**
distinct from the model **at invocation time**, and no event when fallback
swaps the model mid-flight. `FALLBACK_TRIGGERED` exists for top-level
mode/model fallbacks, but per-agent fallback inside BTO/series_pass is not
audit-event-stamped — only DB row inserts in `model_attempts` reflect what
actually ran. If the operator wants to verify "the model the registry chose
was the model that answered," they must reconstruct it from joins across
three tables.

---

### F-10  Memory context is computed once per task and broadcast identically to all parallel agents

**Severity:** LOW-MEDIUM
**File:** `bos/pipeline.ts` (executePipeline path, calls
`getCanonMemory(input)` and `getScratchpad(input)` once)

The memory_context string is built once and passed to every model in
parallel/consensus mode (and not at all in BTO/series-pass). A poisoned or
stale canon entry therefore biases every parallel response **identically**,
amplifying F-1's homogeneity. There is no per-agent memory partitioning.

---

### F-11  `validationEngine.computeConfidence` rewards under-reporting

**Severity:** MEDIUM (referenced under F-2; isolated here for the remediation
plan)
**File:** `bos/validationEngine.ts:120-141`

```ts
if (parsed.uncertainties.length > 2) score *= 0.8;
if (parsed.failure_modes.length > 0) score *= 0.9;
```

This penalizes the only two fields the kernel asks the model to populate
honestly. A model that lists 0 uncertainties and 0 failure modes scores
strictly higher than the same model giving the same answer with honest
self-criticism. Then F-3's tri-state floor uses that score. The pipeline is
self-reinforcingly biased toward overconfident outputs.

---

## 3. What is **not** broken (so we don't accidentally "fix" it)

- **Adapters are real.** `openaiAdapter`, `anthropicAdapter`, `geminiAdapter`,
  `ollamaAdapter`, `genericAdapter` all do real HTTP calls with real
  request/response shapes per vendor. Status-code handling for 401/429/503
  is correct. Timeouts (`AbortSignal.timeout(60000)`) are in place.
- **Key resolution priority is sensible** (DB → env → legacy → proxy) and
  the proxy `base_url` forwarding fix from H-3 is correct — without it
  proxy-issued credentials would 401 against the vendor URL.
- **`series_pass` 2-model minimum guard** correctly addresses the audit
  H-2 single-model degeneracy.
- **`extractJsonCandidate`** balanced-brace + fenced-code parser is
  hardened (audit H-4 fix) and correctly handles braces inside string
  literals.
- **Vision gating** in `providerBridge.ts:65-71` correctly prevents base64
  image data from going to non-multimodal models.
- **Modelrouter deterministic tie-break** (`modelRouter.ts:91-99`) is
  sound — identical configs route identically every time.
- **Cross-tenant attachment guard** in `routes/tasks.ts:39-60` is correct
  and prevents the cross-user attachment exfiltration that the comment
  references.

---

## 4. Remediation plan (no code changes applied)

Ordered by severity × ease. Each item names file:line, the specific change,
and the expected effect on user-visible behavior.

### R-1 (HIGH, easy) — Make parallel/consensus modes role-differentiated

**Files:** `bos/executionEngine.ts:executeParallel`, new `bos/parallelRoles.ts`
**Change:** Define a small `PARALLEL_ROLES` table analogous to BTO's
`AGENT_ROLES` (e.g., `ARCHITECT, CRITIC, RESEARCHER, BUILDER, VALIDATOR`).
Build a per-model prompt by overlaying that role's instruction onto the base
prompt before calling `callProviderDirect`. Have `mergeParallelResponses`
preserve role attribution in the returned `parallel_responses[].model` field
(format `gpt-4o (CRITIC)` like series-pass already does).
**Effect:** Parallel/consensus responses become genuinely diverse. Eliminates
the largest visible cause of "homogeneous outputs."

### R-2 (HIGH, medium) — Decouple JSON envelope from reasoning

**Files:** `providers/prompts.ts`, all three vendor adapters
**Change:** Switch the kernel from "you MUST return JSON only" to "produce
your best free-form reasoning, then emit a final JSON block in fenced
\`\`\`json\`\`\`." Update `extractJsonCandidate` (already handles the fenced
case at `validationEngine.ts:57-61`). Provide a separate post-call validator
that retries with stricter framing only if the JSON block is malformed.
**Effect:** Models reason in their native voice and only structurally
serialize at the end. Token efficiency rises; quality ceiling rises.

### R-3 (HIGH, easy) — Fix `validationEngine.computeConfidence` honesty
penalty

**File:** `bos/validationEngine.ts:120-141`
**Change:** Remove the `score *= 0.8` for >2 uncertainties and `score *= 0.9`
for any failure_modes. Replace with a *bonus* for *appropriately scoped*
self-reports: e.g., `if (uncertainties.length === 0 && task_type IN
high_stakes) score *= 0.85` (suspicious silence in high-stakes domains).
**Effect:** Removes the perverse incentive to under-report, raises the
quality of model self-assessment in the field.

### R-4 (HIGH, medium) — Lower tri-state HOLD bias and add
post-execution re-evaluation

**Files:** `bos/triState.ts:347-356`, `bos/pipeline.ts`
**Change A:** Lower default-confidence floor from 0.70 → 0.60 (general),
0.85 → 0.75 (high-stakes). The 0.75/0.85 numbers were chosen for safety
during early hardening (H-1), but combined with the keyword-classifier
confidence they over-fire HOLD on benign prompts.
**Change B:** Run a second `evaluateTriState` *after* execution, this time
with the real `validation_passed` flag and the *model's* confidence (computed
from `validationEngine.computeConfidence`). Persist both pre- and post-collapse
results to `audit_logs` so the operator can see "we said HOLD pre-call but
the answer would have been GO post-call" — a key debugging signal.
**Effect:** Fewer false HOLDs for benign prompts; the governance loop
becomes bidirectional.

### R-5 (HIGH, easy) — Surface the proxy/mock state in the audit chain

**Files:** `bos/providerBridge.ts:38-96`, `bos/auditEngine.ts`
**Change:** Have `callProviderDirect` emit one new audit event per call:

```
KEY_RESOLVED  source={db|env|legacy|proxy|none}
              base_url=<final URL>  is_proxy=<bool>
              is_mock=<bool>
```

stamped with `task_id`, `attempt_id`, and the resolved `source` and final
`base_url`. Mock-mode calls additionally emit `MOCK_MODE_USED` and set
`success: false` with `error_type: "no_provider_key"` so they stop being
silently counted as successes in `provider_health` and `task_stats`.
**Effect:** Operator can verify "real vendor call vs proxied call vs mock"
from the audit tab. Fixes user concern #5 directly.

### R-6 (MEDIUM, easy) — Re-tune InputGate regexes and add defensive
allow-list

**File:** `bos/inputGate.ts:3-10`
**Change:** Narrow the unsafe patterns to require an *offensive* verb context
(e.g., `\b(perform|execute|launch|carry out)\s+a?\s*(hack|exploit|attack)\b`)
and add an early-return allow-list for defensive intent
(`detect, prevent, defend, audit, investigate, mitigate, harden, monitor`).
Where possible, escalate genuinely ambiguous cases to a *model-based* safety
judgement rather than regex (the `cyber` persona already enforces defensive
framing in its persona prompt, so the gate can be conservative knowing the
persona will refuse to weaponize).
**Effect:** Cuts the false-ABORT rate on legitimate security/IT questions.

### R-7 (MEDIUM, medium) — Add minimum-provider-distinctness guard to BTO

**File:** `bos/boilTheOceanEngine.ts`
**Change:** Mirror the `runSeriesPass` guard. If `bto_models` resolves to
fewer than ~2 distinct providers, either degrade to a labeled
"single-provider BTO with a banner explaining the limitation" or fall back
to series-pass + adversary review. Expose the distinct-provider count in the
final `merge_strategy` field so the UI can warn.
**Effect:** BTO can no longer silently masquerade as multi-provider when only
one provider has keys.

### R-8 (MEDIUM, easy) — Thread structured signals between series-pass
roles

**File:** `bos/seriesPassEngine.ts:60-80, 208-210`
**Change:** Include the previous pass's full `errors_found`, `assumptions`,
and `uncertainties` arrays in `buildSeriesPrompt` (they already exist on
`pass_output`), not just the prose `answer` and a 2-element preview. Cap by
character budget rather than by element count.
**Effect:** CRITIC findings actually reach EXPANDER and ADVERSARY. Closes
the structured-signal-loss leak.

### R-9 (LOW-MEDIUM, easy) — Per-agent memory partitioning in parallel mode

**File:** `bos/pipeline.ts:executePipeline`
**Change:** Compute `memory_context` once but allow parallel-mode role
overlays (R-1) to scope their canon retrieval to role-relevant entries.
Acceptable interim: tag each canon entry with which role(s) should see it,
default to "all" for backwards compatibility.
**Effect:** Reduces homogeneity contributor from shared memory.

### R-10 (MEDIUM, medium) — BTO synthesis as multi-model arbitration

**File:** `bos/boilTheOceanEngine.ts` synthesis call
**Change:** Replace the single-synthesis-call with either: (a) a 2-model
synthesis with an arbitration step, or (b) the existing synthesis followed by
a different-provider OMEGA_VALIDATOR pass that can demand revisions. The
goal is to prevent the synthesis model's voice from dominating 25 agents'
worth of work.
**Effect:** Final BTO answer reflects actual diversity of agent outputs.

---

## 5. What this audit deliberately does **not** recommend

- No UI changes. Per user directive.
- No new features (e.g., new modes, new personas, new providers).
- No schema migrations. All recommendations are runtime-only and additive
  for audit columns.
- No changes to the cross-tenant guards or rate limiting — those are
  correct.
- No changes to the deterministic tie-break in modelRouter — it is correct.

---

## 6. Confirmation: are real models being called?

**Conditional yes.** The adapters issue real HTTP requests with vendor-correct
shapes. On *this* workspace right now, **every live call is going through
the Replit AI Integrations proxy** (only `AI_INTEGRATIONS_*` env vars are
populated). The proxy carries the request to the vendor and bills Replit
credits. From the model's perspective the call is real; from the operator's
perspective the audit chain does not currently distinguish proxy from direct.

If `AI_INTEGRATIONS_*` were unset and no DB key existed, the call would
silently downgrade to mock mode and be reported as a successful response in
the Task Console with no warning beyond the canned answer text.

The provider registry is **not cosmetic**. It is real. But its operational
mode (proxy vs direct vs mock) is **invisible** to the operator, which is the
defect underlying user concern #5.

---

## 7. Cross-reference to existing `AUDIT_REPORT.md`

The earlier audit (post-Hardening v1.1) addressed:

- C-3 (parallel/consensus collapsing to single-shot) → fixed at the
  *engine* level, but **F-1 above is a separate, deeper defect**: the
  engine now does N calls, but the calls are still semantically identical.
- H-1 (HOLD ≠ contradiction) → fixed at the merge layer, but **F-3 above
  is the upstream cause** that this workaround partially papered over.
- H-2 (series-pass single-model degeneracy) → correctly fixed; **F-7
  notes BTO needs the same guard**.
- H-3 (proxy base_url not forwarded) → correctly fixed in
  `providerBridge.ts:60-95`; **F-5 notes the fix is silent and should be
  audited**.
- H-4 (JSON extraction fragility) → correctly fixed in
  `validationEngine.ts:55-90`.

The previous audit was scoped to surface symptoms. This audit is scoped to
the architectural causes those symptoms exposed.

---

*End of report — `artifacts/api-server/RUNTIME_AUDIT_2026-04-26.md`. No
production code was modified to produce this document.*
