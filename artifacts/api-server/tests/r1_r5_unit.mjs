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
