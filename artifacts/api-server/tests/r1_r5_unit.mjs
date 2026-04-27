#!/usr/bin/env node
/**
 * R-1 + R-5 unit-style tests (no DB / no network required).
 *
 * Per plan §R-1.7 (1) and §R-5.7 (5). These exercise the pure functions
 * exported from parallelRoles.ts plus reproduce the fingerprintKey
 * formula to assert the privacy property holds.
 *
 * Run with Node's native TS support:
 *   $ node --experimental-strip-types tests/r1_r5_unit.mjs
 *
 * Exits 0 on pass, 1 on any failure. We deliberately do not import
 * keyResolver.ts because it transitively imports the @workspace/db
 * package which is not resolvable from a bare node loader; the
 * fingerprint formula is short and reproduced here, so any drift in
 * the keyResolver implementation will cause the format assertions to
 * fail when run against a stored fingerprint.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  PARALLEL_ROLES,
  PARALLEL_ROLE_INSTRUCTIONS,
  assignRoles,
  buildRoleOverlay,
} from "../src/bos/parallelRoles.ts";
// Follow-up #41: helpers live in finalStateHelpers.ts (no DB imports) so
// the bare node ESM loader can resolve them.
import {
  assessSeriesPassFinalState,
  assessBtoFinalState,
} from "../src/bos/finalStateHelpers.ts";
// #43: consensus merge is pure given a ParallelResponse[]. Imported from
// the no-deps consensusMerge module so the strip-types loader doesn't have
// to walk @workspace/db (executionEngine.ts pulls in the schema directory,
// which the bare ESM resolver can't handle).
import { mergeParallelResponses } from "../src/bos/consensusMerge.ts";
// Task #46: pure helpers for the memory layer live in memoryHelpers.ts so
// the bare ESM loader doesn't have to walk @workspace/db.
import {
  relevanceScore,
  buildContextFromMemory,
  approxTokenCount,
  selectWithinBudget,
  DROPPED_TITLES_CAP,
} from "../src/bos/memoryHelpers.ts";
// BOP.FRONT_DOOR.v1 — pure, no-deps classifier + UX response builder.
import { classifyFrontDoorInput } from "../src/bos/frontDoorInterpreter.ts";
import { buildFrontDoorBosOutput, safeInputPreview } from "../src/bos/frontDoorResponses.ts";

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    pass++;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
    fail++;
  }
}

console.log("R-1 parallelRoles");

test("PARALLEL_ROLES contains expected roles in order", () => {
  assert.deepEqual(
    [...PARALLEL_ROLES],
    ["ARCHITECT", "CRITIC", "RESEARCHER", "BUILDER", "VALIDATOR"],
  );
});

test("buildRoleOverlay(CRITIC) contains CRITIC and no other role names (plan §R-1.7 #1)", () => {
  const overlay = buildRoleOverlay("CRITIC");
  assert.match(overlay, /CRITIC/);
  for (const other of ["ARCHITECT", "RESEARCHER", "BUILDER", "VALIDATOR"]) {
    assert.ok(!overlay.includes(other), `overlay leaked role name: ${other}`);
  }
});

test("buildRoleOverlay returns full instruction text per role", () => {
  for (const role of PARALLEL_ROLES) {
    const overlay = buildRoleOverlay(role);
    assert.equal(overlay, PARALLEL_ROLE_INSTRUCTIONS[role]);
    assert.ok(overlay.length > 50, `overlay for ${role} too short`);
  }
});

test("assignRoles is deterministic and stable", () => {
  assert.deepEqual(assignRoles(2), ["ARCHITECT", "CRITIC"]);
  assert.deepEqual(assignRoles(3), ["ARCHITECT", "CRITIC", "RESEARCHER"]);
  assert.deepEqual(assignRoles(5), [
    "ARCHITECT",
    "CRITIC",
    "RESEARCHER",
    "BUILDER",
    "VALIDATOR",
  ]);
});

test("assignRoles cycles for N>5", () => {
  const r = assignRoles(7);
  assert.equal(r.length, 7);
  assert.equal(r[5], "ARCHITECT");
  assert.equal(r[6], "CRITIC");
});

test("assignRoles handles N=0 / N=1 (downgrade is caller's responsibility)", () => {
  assert.deepEqual(assignRoles(0), []);
  assert.deepEqual(assignRoles(1), ["ARCHITECT"]);
});

test("each role's overlay starts with 'ROLE:' prefix", () => {
  for (const role of PARALLEL_ROLES) {
    assert.match(buildRoleOverlay(role), /^ROLE: /);
  }
});

test("CRITIC overlay populates errors_found / failure_modes hint", () => {
  const overlay = buildRoleOverlay("CRITIC");
  assert.match(overlay, /errors_found/);
  assert.match(overlay, /failure_modes/);
});

test("VALIDATOR overlay populates recommended_next_action hint", () => {
  const overlay = buildRoleOverlay("VALIDATOR");
  assert.match(overlay, /recommended_next_action/);
});

console.log("\nR-5 fingerprintKey formula (privacy invariant)");

// Reproduce the keyResolver.fingerprintKey formula. If R-5.2 is changed
// (e.g. expanded to 8+8) this block must be updated in lockstep.
function fingerprintLikeKeyResolver(key) {
  if (!key || !key.trim()) return "";
  const h = createHash("sha256").update(key).digest("hex");
  return `${h.slice(0, 4)}…${h.slice(-4)}`;
}

test("fingerprint of empty/whitespace key is empty", () => {
  assert.equal(fingerprintLikeKeyResolver(""), "");
  assert.equal(fingerprintLikeKeyResolver("   "), "");
});

test("fingerprint is stable for the same key", () => {
  const k = "sk-fake-1234567890abcdef";
  assert.equal(fingerprintLikeKeyResolver(k), fingerprintLikeKeyResolver(k));
});

test("fingerprint is different for different keys", () => {
  assert.notEqual(
    fingerprintLikeKeyResolver("sk-fake-A"),
    fingerprintLikeKeyResolver("sk-fake-B"),
  );
});

test("fingerprint format is exactly 4 + '…' + 4 hex chars", () => {
  const f = fingerprintLikeKeyResolver("sk-fake-1234567890abcdef");
  assert.match(f, /^[0-9a-f]{4}…[0-9a-f]{4}$/);
});

test("fingerprint never leaks the key as a prefix or substring (plan §R-5.7 #5)", () => {
  const keys = [
    "sk-proj-abcdef1234567890_supersecret_value_zzzz",
    "AIzaSy0123456789-very-fake-google-key-abcd",
    "anthropic-fake-key-ABCDEFGHIJKLMNOP",
    "ollama-no-key",
  ];
  for (const k of keys) {
    const f = fingerprintLikeKeyResolver(k);
    const halves = f.replace("…", "");
    assert.ok(!k.toLowerCase().includes(halves.toLowerCase()),
      `key ${k} contains fingerprint halves ${halves}`);
    assert.ok(!f.includes(k), `fingerprint ${f} contains key ${k}`);
  }
});

console.log("\nFollow-up #41 series_pass / boil_the_ocean degradation");

test("series_pass with all passes failed (mock-mode/no-key) returns HOLD", () => {
  const passes = [
    { state: "HOLD", success: false },
    { state: "HOLD", success: false },
    { state: "HOLD", success: false },
    { state: "HOLD", success: false },
    { state: "HOLD", success: false },
  ];
  const r = assessSeriesPassFinalState(passes);
  assert.equal(r.final_state, "HOLD");
  assert.equal(r.reason, "all_passes_failed");
  assert.equal(r.failed_count, 5);
  assert.equal(r.succeeded_count, 0);
});

test("series_pass with at least one GO pass returns GO", () => {
  const passes = [
    { state: "HOLD", success: false },
    { state: "GO", success: true },
    { state: "HOLD", success: false },
    { state: "GO", success: true },
    { state: "GO", success: true },
  ];
  const r = assessSeriesPassFinalState(passes);
  assert.equal(r.final_state, "GO");
  assert.equal(r.reason, "at_least_one_GO_pass");
  assert.equal(r.failed_count, 2);
  assert.equal(r.succeeded_count, 3);
});

test("series_pass with all-success but no GO state returns HOLD", () => {
  // Real provider returned, but every pass output state was HOLD/ABORT.
  // success:true on the call doesn't entitle us to claim GO.
  const passes = [
    { state: "HOLD", success: true },
    { state: "ABORT", success: true },
    { state: "HOLD", success: true },
  ];
  const r = assessSeriesPassFinalState(passes);
  assert.equal(r.final_state, "HOLD");
  assert.equal(r.reason, "no_pass_returned_GO");
});

test("series_pass with empty input returns HOLD with no_passes_executed", () => {
  const r = assessSeriesPassFinalState([]);
  assert.equal(r.final_state, "HOLD");
  assert.equal(r.reason, "no_passes_executed");
});

test("series_pass never emits GO when every call was a mock-mode failure (acceptance criterion 1)", () => {
  // R-5.4 mock-mode contract: success=false. Even with the "look like a
  // valid output" raw_response shape, success=false must dominate.
  for (let n = 1; n <= 10; n++) {
    const passes = Array.from({ length: n }, () => ({ state: "HOLD", success: false }));
    assert.equal(assessSeriesPassFinalState(passes).final_state, "HOLD");
  }
});

test("BTO with zero successful agents returns HOLD (preserves existing branch)", () => {
  const r = assessBtoFinalState({ successful_agents: 0, total_agents: 25, synthesis_success: false });
  assert.equal(r.final_state, "HOLD");
  assert.equal(r.reason, "all_agents_failed");
});

test("BTO with successful agents but failed synthesis returns HOLD (acceptance criterion 2)", () => {
  // The R-5.4 mock-as-failure leak this follow-up exists to close: agents
  // succeeded, but the synthesis call itself was a no-key mock failure,
  // so the "answer" is just placeholder text. Must not be GO.
  const r = assessBtoFinalState({ successful_agents: 10, total_agents: 25, synthesis_success: false });
  assert.equal(r.final_state, "HOLD");
  assert.equal(r.reason, "synthesis_failed");
});

test("BTO with successful agents and successful synthesis returns GO", () => {
  const r = assessBtoFinalState({ successful_agents: 10, total_agents: 25, synthesis_success: true });
  assert.equal(r.final_state, "GO");
  assert.equal(r.reason, "synthesis_succeeded");
});

test("BTO with no agents dispatched returns HOLD", () => {
  const r = assessBtoFinalState({ successful_agents: 0, total_agents: 0, synthesis_success: true });
  assert.equal(r.final_state, "HOLD");
  // First branch (all_agents_failed) wins because successful_agents===0.
  assert.equal(r.reason, "all_agents_failed");
});

test("BTO never emits GO when synthesis failed regardless of successful agent count (acceptance criterion 3)", () => {
  for (const n of [1, 5, 10, 25, 100]) {
    const r = assessBtoFinalState({ successful_agents: n, total_agents: n, synthesis_success: false });
    assert.equal(r.final_state, "HOLD", `n=${n} produced GO with failed synthesis`);
  }
});

// =====================================================================
// #43: consensus mode merge — majority_vote_consensus + ABORT veto rules.
// These cover the deterministic merge logic that the live-API e2e cannot
// safely exercise (real LLM calls cannot be coaxed into returning ABORT
// reliably, and we will not inject test fixtures into prod request paths).
// =====================================================================

function mkResp({ provider = "p", model = "m", state = "GO", confidence = 0.5, latency = 100 } = {}) {
  return {
    provider,
    model,
    state,
    answer: `answer from ${model}`,
    confidence_score: confidence,
    latency_ms: latency,
    selected: false,
  };
}

console.log("\n#43 consensus merge (majority_vote_consensus + ABORT veto)");

test("consensus all-GO emits merge_strategy='majority_vote_consensus' and state=GO", () => {
  const responses = [
    mkResp({ model: "lo", state: "GO", confidence: 0.6 }),
    mkResp({ model: "mid", state: "GO", confidence: 0.7 }),
    mkResp({ model: "hi", state: "GO", confidence: 0.9 }),
  ];
  const merged = mergeParallelResponses(responses, "consensus");
  assert.equal(merged.merge_strategy, "majority_vote_consensus");
  assert.equal(merged.state, "GO");
  // parallel_responses must be sorted desc by confidence (the merge function
  // mutates the input in place; assert via the returned reference).
  assert.equal(merged.parallel_responses[0].model, "hi");
});

test("consensus all-GO selects the highest-confidence response (selected:true on top)", () => {
  const responses = [
    mkResp({ model: "lo", state: "GO", confidence: 0.4 }),
    mkResp({ model: "hi", state: "GO", confidence: 0.95 }),
    mkResp({ model: "mid", state: "GO", confidence: 0.7 }),
  ];
  const merged = mergeParallelResponses(responses, "consensus");
  const selected = merged.parallel_responses.filter((r) => r.selected);
  assert.equal(selected.length, 1, "exactly one response should be selected");
  assert.equal(selected[0].model, "hi", "highest-confidence response should be selected");
  assert.equal(selected[0].confidence_score, 0.95);
});

test("consensus with any ABORT vetoes the merge to ABORT regardless of GO majority", () => {
  // 3 GO + 1 ABORT — majority is GO but the ABORT must veto.
  const responses = [
    mkResp({ model: "go-hi", state: "GO", confidence: 0.95 }),
    mkResp({ model: "go-mid", state: "GO", confidence: 0.8 }),
    mkResp({ model: "go-lo", state: "GO", confidence: 0.6 }),
    mkResp({ model: "aborter", state: "ABORT", confidence: 0.4 }),
  ];
  const merged = mergeParallelResponses(responses, "consensus");
  assert.equal(merged.state, "ABORT", "any ABORT must veto consensus");
});

test("consensus ABORT veto marks the aborting response selected:true (audit chain identifies the aborter)", () => {
  // The pre-fix bug was that responses[length-1] (lowest confidence after
  // sort) got selected; the fix searches for the actual ABORT row.
  const responses = [
    mkResp({ model: "go-hi", state: "GO", confidence: 0.95 }),
    mkResp({ model: "aborter-mid", state: "ABORT", confidence: 0.7 }),
    mkResp({ model: "go-lo", state: "GO", confidence: 0.3 }),
  ];
  const merged = mergeParallelResponses(responses, "consensus");
  const selected = merged.parallel_responses.filter((r) => r.selected);
  assert.equal(selected.length, 1, "exactly one response should be selected");
  assert.equal(selected[0].state, "ABORT", "the aborter (not the lowest-confidence row) must be selected");
  assert.equal(selected[0].model, "aborter-mid");
});

test("consensus ABORT output shape includes parallel_responses + merge_strategy (refactor invariant — architect medium fix)", () => {
  // After the consensusMerge.ts extraction, the ABORT branch now attaches
  // both parallel_responses and merge_strategy to the BosOutput. Earlier,
  // buildAbortOutput returned a bare BosOutput. Pin this contract so a
  // future refactor can't silently drop the fields and leave the audit
  // chain unable to identify the aborter.
  const responses = [
    mkResp({ model: "go-1", state: "GO", confidence: 0.8 }),
    mkResp({ model: "aborter", state: "ABORT", confidence: 0.5 }),
  ];
  const merged = mergeParallelResponses(responses, "consensus");
  assert.equal(merged.state, "ABORT", "ABORT veto should produce state=ABORT");
  assert.equal(merged.merge_strategy, "majority_vote_consensus", "ABORT output must carry merge_strategy");
  assert.ok(Array.isArray(merged.parallel_responses), "ABORT output must carry parallel_responses");
  assert.equal(merged.parallel_responses.length, responses.length, "all responses must be present in ABORT output");
  const aborter = merged.parallel_responses.find((r) => r.state === "ABORT");
  assert.ok(aborter?.selected, "the ABORT row must be selected:true so the audit chain identifies the aborter");
});

test("consensus with multiple ABORT responses selects one ABORT row (sorted-first by confidence)", () => {
  // After the desc-by-confidence sort, the higher-confidence ABORT comes first
  // and is the one .find() lands on. This pins the deterministic tiebreak.
  const responses = [
    mkResp({ model: "abort-lo", state: "ABORT", confidence: 0.4 }),
    mkResp({ model: "go-mid", state: "GO", confidence: 0.6 }),
    mkResp({ model: "abort-hi", state: "ABORT", confidence: 0.9 }),
  ];
  const merged = mergeParallelResponses(responses, "consensus");
  assert.equal(merged.state, "ABORT");
  const selected = merged.parallel_responses.filter((r) => r.selected);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].model, "abort-hi", "highest-confidence ABORT should be selected after desc sort");
});

test("consensus all-HOLD (no GO majority, no ABORT) returns HOLD with majority_vote_consensus strategy", () => {
  const responses = [
    mkResp({ state: "HOLD", confidence: 0.3 }),
    mkResp({ state: "HOLD", confidence: 0.5 }),
    mkResp({ state: "HOLD", confidence: 0.4 }),
  ];
  const merged = mergeParallelResponses(responses, "consensus");
  assert.equal(merged.merge_strategy, "majority_vote_consensus");
  assert.equal(merged.state, "HOLD");
});

test("non-consensus mode (parallel) uses best_confidence_merge, not majority_vote_consensus", () => {
  // Guards against accidentally routing parallel mode through the consensus
  // branch — the merge_strategy string is the public marker for this.
  const responses = [
    mkResp({ state: "GO", confidence: 0.9 }),
    mkResp({ state: "GO", confidence: 0.5 }),
  ];
  const merged = mergeParallelResponses(responses, "parallel");
  assert.equal(merged.merge_strategy, "best_confidence_merge");
});

test("BTO synthesis success-flag with empty body is treated as failure by the engine (architect medium fix)", () => {
  // The helper itself only knows the boolean. The engine computes
  // synthesis_usable = result.success && !!result.raw_response and feeds
  // that into the helper. Replay that contract here: an empty-body
  // success must reach the helper as false, not true.
  const synthesis_result = { success: true, raw_response: "" };
  const synthesis_usable = synthesis_result.success && !!synthesis_result.raw_response;
  assert.equal(synthesis_usable, false);
  const r = assessBtoFinalState({ successful_agents: 5, total_agents: 5, synthesis_success: synthesis_usable });
  assert.equal(r.final_state, "HOLD");
  assert.equal(r.reason, "synthesis_failed");
});

console.log("\nTask #46 memory layer");

test("relevanceScore matches singular task token to plural item token", () => {
  // The stored continuity content uses plural ("elephants") while the user
  // query phrases the same noun in the singular ("elephant"). The plural-
  // variant equivalence in withPluralVariants must rescue this so the seeded
  // continuity row reaches the model prompt across all execution modes.
  // Asymmetric tokens are required here: shared exact tokens would pass
  // even without the plural-variant logic and would not exercise it.
  const score = relevanceScore("we counted twelve elephants today", "describe the elephant we saw");
  assert.ok(score > 0, `expected > 0, got ${score}`);
});

test("relevanceScore matches plural task token to singular item token", () => {
  const score = relevanceScore("the elephant is grey", "tell me about elephants");
  assert.ok(score > 0, `expected > 0, got ${score}`);
});

test("relevanceScore substring fallback awards small positive score when no token overlap", () => {
  // Both sides lose every token to STOPWORDS / length filter, so token
  // overlap is zero — but the item phrase appears verbatim inside the
  // query. Substring fallback must rescue it with a small positive score.
  const score = relevanceScore("be it so", "to be or not to be it so then");
  assert.ok(score > 0 && score <= 0.1, `expected (0, 0.1], got ${score}`);
});

test("relevanceScore returns 0 for fully unrelated text", () => {
  const score = relevanceScore("kubernetes pod scheduler quirks", "banana bread baking time");
  assert.equal(score, 0);
});

test("buildContextFromMemory emits all four section headers when every layer is non-empty", () => {
  const ctx = buildContextFromMemory(
    ["[CANON:a] one"],
    ["[CONTINUITY:b] two"],
    ["[PATCHES:c] three"],
    ["[SCRATCHPAD:d] four"],
  );
  assert.match(ctx, /=== CANON CONTEXT ===/);
  assert.match(ctx, /=== CONTINUITY ===/);
  assert.match(ctx, /=== PATCHES ===/);
  assert.match(ctx, /=== SCRATCHPAD ===/);
});

test("buildContextFromMemory omits empty layers entirely (no stray empty headers)", () => {
  const ctx = buildContextFromMemory([], ["[CONTINUITY:b] two"], [], []);
  assert.match(ctx, /=== CONTINUITY ===/);
  assert.ok(!ctx.includes("=== CANON CONTEXT ==="), "canon header leaked when empty");
  assert.ok(!ctx.includes("=== PATCHES ==="), "patches header leaked when empty");
  assert.ok(!ctx.includes("=== SCRATCHPAD ==="), "scratchpad header leaked when empty");
});

test("buildContextFromMemory returns empty string when all layers are empty", () => {
  assert.equal(buildContextFromMemory([], [], [], []), "");
});

test("approxTokenCount uses ~4-chars-per-token heuristic", () => {
  assert.equal(approxTokenCount(""), 0);
  assert.equal(approxTokenCount("abcd"), 1);
  assert.equal(approxTokenCount("abcde"), 2);
});

// =============================================================================
// BOP.FRONT_DOOR.v1_PRODUCTION — classifier test matrix
// =============================================================================

// --- GREETING ---
test("front door: 'hello' → GREETING, no engine", () => {
  const c = classifyFrontDoorInput("hello");
  assert.equal(c.route, "GREETING");
  assert.equal(c.shouldInvokeBosEngine, false);
  assert.ok(c.confidence >= 0.95);
});
test("front door: 'Hi!' → GREETING (case + punctuation tolerant)", () => {
  const c = classifyFrontDoorInput("Hi!");
  assert.equal(c.route, "GREETING");
});
test("front door: 'good morning' → GREETING (multi-word)", () => {
  assert.equal(classifyFrontDoorInput("good morning").route, "GREETING");
});
test("front door: 'thanks.' → GREETING (acknowledgement)", () => {
  assert.equal(classifyFrontDoorInput("thanks.").route, "GREETING");
});

// --- EMPTY ---
test("front door: '' → EMPTY, no engine", () => {
  const c = classifyFrontDoorInput("");
  assert.equal(c.route, "EMPTY");
  assert.equal(c.shouldInvokeBosEngine, false);
  assert.equal(c.confidence, 1.0);
});
test("front door: '   \\n  ' (whitespace) → EMPTY", () => {
  assert.equal(classifyFrontDoorInput("   \n  ").route, "EMPTY");
});
test("front door: null/undefined → EMPTY", () => {
  assert.equal(classifyFrontDoorInput(null).route, "EMPTY");
  assert.equal(classifyFrontDoorInput(undefined).route, "EMPTY");
});

// --- UNDER_SPECIFIED ---
test("front door: 'this' → UNDER_SPECIFIED, no engine", () => {
  const c = classifyFrontDoorInput("this");
  assert.equal(c.route, "UNDER_SPECIFIED");
  assert.equal(c.shouldInvokeBosEngine, false);
});
test("front door: 'fix this' (no attachments) → UNDER_SPECIFIED", () => {
  assert.equal(classifyFrontDoorInput("fix this").route, "UNDER_SPECIFIED");
});
test("front door: 'review' (verb only, no object) → UNDER_SPECIFIED", () => {
  assert.equal(classifyFrontDoorInput("review").route, "UNDER_SPECIFIED");
});
test("front door: 'thoughts?' → UNDER_SPECIFIED", () => {
  assert.equal(classifyFrontDoorInput("thoughts?").route, "UNDER_SPECIFIED");
});

// --- Attachments rescue UNDER_SPECIFIED → VALID_TASK ---
test("front door: 'fix this' WITH attachments → VALID_TASK, engine invoked", () => {
  const c = classifyFrontDoorInput("fix this", { has_attachments: true });
  assert.equal(c.route, "VALID_TASK");
  assert.equal(c.shouldInvokeBosEngine, true);
});

// --- LIKELY_NON_TASK ---
test("front door: 'how is it going?' → LIKELY_NON_TASK", () => {
  assert.equal(classifyFrontDoorInput("how is it going?").route, "LIKELY_NON_TASK");
});
test("front door: 'tell me a joke' → LIKELY_NON_TASK", () => {
  assert.equal(classifyFrontDoorInput("tell me a joke").route, "LIKELY_NON_TASK");
});
test("front door: 'who are you?' → LIKELY_NON_TASK", () => {
  assert.equal(classifyFrontDoorInput("who are you?").route, "LIKELY_NON_TASK");
});

// --- VALID_TASK ---
test("front door: 'Should we approve this vendor?' → VALID_TASK", () => {
  const c = classifyFrontDoorInput("Should we approve this vendor?");
  assert.equal(c.route, "VALID_TASK");
  assert.equal(c.shouldInvokeBosEngine, true);
  assert.ok(c.confidence >= 0.7);
});
test("front door: 'Review this contract for risk before we sign' → VALID_TASK", () => {
  assert.equal(
    classifyFrontDoorInput("Review this contract for risk before we sign").route,
    "VALID_TASK",
  );
});
test("front door: 'Build a step-by-step plan to fix this workflow' → VALID_TASK", () => {
  assert.equal(
    classifyFrontDoorInput("Build a step-by-step plan to fix this workflow").route,
    "VALID_TASK",
  );
});
test("front door: 'What are the risks of merging this PR?' → VALID_TASK", () => {
  assert.equal(
    classifyFrontDoorInput("What are the risks of merging this PR?").route,
    "VALID_TASK",
  );
});
test("front door: 'Review contract' (imperative short task) → VALID_TASK", () => {
  assert.equal(classifyFrontDoorInput("Review contract").route, "VALID_TASK");
});
test("front door: 'Plan migration' (imperative short task) → VALID_TASK", () => {
  assert.equal(classifyFrontDoorInput("Plan migration").route, "VALID_TASK");
});

// --- Mixed-intent regression: smalltalk preface + real task → must NOT block ---
test("front door: 'who are you and review this contract' → VALID_TASK (mixed intent task wins)", () => {
  const c = classifyFrontDoorInput("who are you and review this contract");
  assert.equal(c.route, "VALID_TASK");
  assert.equal(c.shouldInvokeBosEngine, true);
});
test("front door: 'tell me a joke then analyze this PR for risk' → VALID_TASK (mixed intent task wins)", () => {
  const c = classifyFrontDoorInput("tell me a joke then analyze this PR for risk");
  assert.equal(c.route, "VALID_TASK");
  assert.equal(c.shouldInvokeBosEngine, true);
});
test("front door: 'how is it going, can we approve this vendor?' → VALID_TASK (mixed intent task wins)", () => {
  const c = classifyFrontDoorInput("how is it going, can we approve this vendor?");
  assert.equal(c.route, "VALID_TASK");
  assert.equal(c.shouldInvokeBosEngine, true);
});

// --- Low-confidence safety rule (fallthrough → engine) ---
test("front door: ambiguous unknown text → low-confidence VALID_TASK fallthrough", () => {
  const c = classifyFrontDoorInput("the quick brown fox jumps over the lazy dog");
  assert.equal(c.route, "VALID_TASK");
  assert.equal(c.shouldInvokeBosEngine, true);
  assert.ok(c.confidence < 0.7, `expected confidence < 0.7, got ${c.confidence}`);
  assert.ok(c.signals.includes("low_confidence_fallthrough"));
});

// --- Always emits required fields ---
test("front door: always returns route + confidence + rationale + signals", () => {
  for (const input of ["hello", "", "fix this", "Should we approve this?", "blah blah blah"]) {
    const c = classifyFrontDoorInput(input);
    assert.ok(typeof c.route === "string");
    assert.ok(typeof c.confidence === "number" && c.confidence >= 0 && c.confidence <= 1);
    assert.ok(typeof c.rationale === "string" && c.rationale.length > 0);
    assert.ok(Array.isArray(c.signals));
    assert.ok(typeof c.shouldInvokeBosEngine === "boolean");
  }
});

// --- UX response builder ---
test("front door response: GREETING → friendly answer + examples + front_door_route marker", () => {
  const c = classifyFrontDoorInput("hello");
  const out = buildFrontDoorBosOutput(c);
  assert.equal(out.front_door_route, "GREETING");
  assert.equal(out.task_type, "front_door_guidance");
  assert.equal(out.state, "HOLD"); // internal db state, but UI keys off front_door_route
  assert.ok(/Hello\. BOS-OMEGA is ready/.test(out.answer));
  assert.ok(/Examples:/.test(out.answer));
  assert.ok(Array.isArray(out.front_door_examples) && out.front_door_examples.length >= 3);
  assert.ok(out.recommended_next_action.length > 0);
  assert.ok(typeof out.why_decision_was_made === "string");
  assert.ok(typeof out.safe_alternative === "string");
});

test("front door response: EMPTY → 'No task received' answer", () => {
  const out = buildFrontDoorBosOutput(classifyFrontDoorInput(""));
  assert.equal(out.front_door_route, "EMPTY");
  assert.ok(/No task received/.test(out.answer));
  assert.ok(out.missing_inputs.includes("task_text"));
});

test("front door response: UNDER_SPECIFIED → asks for object/context", () => {
  const out = buildFrontDoorBosOutput(classifyFrontDoorInput("fix this"));
  assert.equal(out.front_door_route, "UNDER_SPECIFIED");
  assert.ok(/need more context/i.test(out.answer));
  assert.ok(out.missing_inputs.length > 0);
});

test("front door response: LIKELY_NON_TASK → explains BOS scope", () => {
  const out = buildFrontDoorBosOutput(classifyFrontDoorInput("tell me a joke"));
  assert.equal(out.front_door_route, "LIKELY_NON_TASK");
  assert.ok(/structured decisions/i.test(out.answer));
});

test("front door response: throws on VALID_TASK (must call engine instead)", () => {
  const c = classifyFrontDoorInput("Should we approve this vendor?");
  assert.throws(() => buildFrontDoorBosOutput(c), /VALID_TASK/);
});

// --- safeInputPreview ---
test("safeInputPreview: short input passes through, no truncation", () => {
  const r = safeInputPreview("hello world");
  assert.equal(r.preview, "hello world");
  assert.equal(r.truncated, false);
  assert.equal(r.original_length, 11);
});
test("safeInputPreview: long input truncated to 200 chars by default", () => {
  const long = "a".repeat(500);
  const r = safeInputPreview(long);
  assert.equal(r.truncated, true);
  assert.equal(r.preview.length, 201); // 200 + ellipsis
  assert.equal(r.original_length, 500);
});
test("safeInputPreview: strips control chars", () => {
  const r = safeInputPreview("hello\x00\x07world");
  assert.equal(r.preview, "helloworld");
});

console.log("\nTask #48 budget-fit dropped count");

test("selectWithinBudget reports zero dropped when every ranked item fits", () => {
  // Three items, total tokens = 30, budget = 100 — everything fits.
  const ranked = [
    { rendered: "[CANON:a] one", tokens: 10 },
    { rendered: "[CANON:b] two", tokens: 10 },
    { rendered: "[CANON:c] three", tokens: 10 },
  ];
  const { items, dropped } = selectWithinBudget(ranked, 100);
  assert.equal(items.length, 3);
  assert.equal(dropped, 0);
});

test("selectWithinBudget reports non-zero dropped count when input exceeds budget (acceptance criterion)", () => {
  // Five items at 200 tokens each = 1000 total; canon budget here is 750
  // so only the first three (600 tokens) fit and the remaining two are
  // dropped. The dropped count is what the audit metadata exposes so the
  // user can see "your note ranked but didn't fit the budget".
  const ranked = Array.from({ length: 5 }, (_, i) => ({
    rendered: `[CANON:item-${i}] payload`,
    tokens: 200,
  }));
  const { items, dropped } = selectWithinBudget(ranked, 750);
  assert.equal(items.length, 3, "first three items fit the 750-token budget");
  assert.ok(dropped > 0, `expected dropped > 0, got ${dropped}`);
  assert.equal(dropped, 2, "the two ranked-but-overflowing items are counted as dropped");
});

test("selectWithinBudget skips an oversized item but keeps filling with later ones that fit", () => {
  // Greedy fill: a single big item that blows the budget is dropped, but
  // smaller items after it can still slip in. This matches the existing
  // selectLayer behaviour (continue, not break).
  const ranked = [
    { rendered: "[CANON:small-1] x", tokens: 100 },
    { rendered: "[CANON:huge] y", tokens: 5000 },
    { rendered: "[CANON:small-2] z", tokens: 100 },
  ];
  const { items, dropped } = selectWithinBudget(ranked, 500);
  assert.equal(items.length, 2, "both small items fit even though the huge one is skipped");
  assert.equal(dropped, 1, "the huge item is the only one dropped");
});

test("selectWithinBudget on an empty ranked list returns zero items and zero dropped", () => {
  const { items, dropped, dropped_items } = selectWithinBudget([], 1000);
  assert.equal(items.length, 0);
  assert.equal(dropped, 0);
  assert.deepEqual(dropped_items, []);
});

console.log("\nTask #52 dropped titles (specific notes, not just a count)");

test("selectWithinBudget echoes dropped_items so callers can extract titles", () => {
  // Five items at 200 tokens, budget 750 → first 3 fit, last 2 overflow.
  // The dropped_items array must contain *those exact two items*, in the
  // same iteration order the greedy fit skipped them. This is what
  // selectLayer maps to .title for the audit log so the user can
  // identify which specific notes were trimmed.
  const ranked = [
    { title: "alpha",   rendered: "[CANON:alpha] x",   tokens: 200 },
    { title: "beta",    rendered: "[CANON:beta] x",    tokens: 200 },
    { title: "gamma",   rendered: "[CANON:gamma] x",   tokens: 200 },
    { title: "delta",   rendered: "[CANON:delta] x",   tokens: 200 },
    { title: "epsilon", rendered: "[CANON:epsilon] x", tokens: 200 },
  ];
  const { items, dropped, dropped_items } = selectWithinBudget(ranked, 750);
  assert.equal(items.length, 3);
  assert.equal(dropped, 2);
  // Mirror what selectLayer does: pick the .title from each dropped row.
  const dropped_titles = dropped_items.map((i) => i.title);
  assert.deepEqual(dropped_titles, ["delta", "epsilon"],
    "dropped_titles must list exactly the items the greedy fit skipped, in order");
  // The kept items must NOT appear in dropped_items (and vice versa).
  const kept_titles = items.map((i) => i.title);
  for (const t of dropped_titles) {
    assert.ok(!kept_titles.includes(t), `kept items leaked into dropped_items: ${t}`);
  }
  for (const t of kept_titles) {
    assert.ok(!dropped_titles.includes(t), `dropped items leaked into kept items: ${t}`);
  }
  // The dropped count must equal the dropped_items length — they are
  // two views of the same set, never out of sync.
  assert.equal(dropped, dropped_items.length);
});

test("selectWithinBudget reports the oversized-but-skipped item by title (greedy-continue path)", () => {
  // The huge item is dropped, but the small items after it still fit.
  // dropped_items must contain exactly the huge one — not the smalls.
  const ranked = [
    { title: "small-1", rendered: "[CANON:small-1] x", tokens: 100 },
    { title: "huge",    rendered: "[CANON:huge] y",    tokens: 5000 },
    { title: "small-2", rendered: "[CANON:small-2] z", tokens: 100 },
  ];
  const { items, dropped, dropped_items } = selectWithinBudget(ranked, 500);
  assert.equal(items.length, 2);
  assert.equal(dropped, 1);
  assert.deepEqual(dropped_items.map((i) => i.title), ["huge"],
    "only the huge item ranked-but-overflowed; smalls fit and must not appear");
});

test("selectWithinBudget returns empty dropped_items when everything fits", () => {
  // Symmetric to the dropped > 0 cases: when nothing overflows, the
  // titles array must be empty so the audit log records [] not undefined.
  const ranked = [
    { title: "a", rendered: "[CANON:a] one",   tokens: 10 },
    { title: "b", rendered: "[CANON:b] two",   tokens: 10 },
    { title: "c", rendered: "[CANON:c] three", tokens: 10 },
  ];
  const { items, dropped, dropped_items } = selectWithinBudget(ranked, 100);
  assert.equal(items.length, 3);
  assert.equal(dropped, 0);
  assert.deepEqual(dropped_items, []);
});

test("dropped_titles list (as exposed by selectLayer) is bounded to a sane cap", () => {
  // Replays the cap selectLayer applies on top of selectWithinBudget so
  // the MEMORY_INJECTED audit metadata stays cheap to render even when a
  // user has hundreds of low-authority notes overflowing the budget.
  // Imports DROPPED_TITLES_CAP from the production module so this test
  // never drifts out of sync with the engine when the cap is tuned.
  assert.ok(typeof DROPPED_TITLES_CAP === "number" && DROPPED_TITLES_CAP > 0,
    "DROPPED_TITLES_CAP must be a positive number");
  const ranked = Array.from({ length: DROPPED_TITLES_CAP * 5 }, (_, i) => ({
    title: `note-${i}`,
    rendered: `[CANON:note-${i}] x`,
    tokens: 100,
  }));
  // Budget = 100 → only the first item fits; everything else overflows.
  const { items, dropped_items } = selectWithinBudget(ranked, 100);
  assert.equal(items.length, 1);
  assert.equal(dropped_items.length, ranked.length - 1,
    "selectWithinBudget itself returns the full overflow list");
  // The cap is applied at the selectLayer boundary before audit logging.
  const dropped_titles = dropped_items.slice(0, DROPPED_TITLES_CAP).map((i) => i.title);
  assert.equal(dropped_titles.length, DROPPED_TITLES_CAP,
    `selectLayer caps dropped_titles at ${DROPPED_TITLES_CAP} for the audit blob`);
  // Ordering invariant: capped slice still starts with the first overflow.
  assert.equal(dropped_titles[0], "note-1",
    "capped dropped_titles preserves overflow iteration order from the head");
  assert.equal(dropped_titles[DROPPED_TITLES_CAP - 1], `note-${DROPPED_TITLES_CAP}`,
    "capped dropped_titles preserves overflow iteration order at the tail of the cap");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
