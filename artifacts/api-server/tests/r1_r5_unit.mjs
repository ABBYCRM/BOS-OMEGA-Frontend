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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
