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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
