#!/usr/bin/env node
/**
 * BOP.PERSONA_SLOTS.v1 unit-style tests (no DB / no network required).
 *
 * Run with Node's native TS support:
 *   $ node --experimental-strip-types artifacts/api-server/tests/persona_slots_unit.mjs
 *
 * Exits 0 on pass, 1 on any failure.
 *
 * We test:
 *   - personaSlotId() is deterministic and produces the documented ids
 *     (this is a hard contract because seed idempotency relies on it).
 *   - PERSONA_SLOTS exposes A,B,C in order with non-empty defaults.
 *   - buildPersonaOverlay() wraps title+content in the DOMAIN PERSONA
 *     header, upper-cases the title, returns "" for empty content, and
 *     handles edge cases (missing title, whitespace-only content).
 *
 * The DB-touching seedPersonaSlots() idempotency invariant is exercised
 * by the e2e tests (see persona_slots_e2e.mjs).
 */
import assert from "node:assert/strict";
// Pulled from the no-deps constants module so the bare strip-types loader
// doesn't have to walk @workspace/db (personaCanonSeed.ts imports it).
import { PERSONA_SLOTS, personaSlotId } from "../src/bos/personaSlotConstants.ts";
import { buildPersonaOverlay } from "../src/bos/personaOverlay.ts";

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

console.log("BOP.PERSONA_SLOTS.v1 personaCanonSeed");

test("PERSONA_SLOTS exposes exactly A, B, C in order", () => {
  assert.equal(PERSONA_SLOTS.length, 3);
  assert.deepEqual([...PERSONA_SLOTS], ["A", "B", "C"]);
});

test("personaSlotId(A|B|C) returns the documented deterministic ids", () => {
  assert.equal(personaSlotId("A"), "persona_slot_a");
  assert.equal(personaSlotId("B"), "persona_slot_b");
  assert.equal(personaSlotId("C"), "persona_slot_c");
});

test("personaSlotId is idempotent (same input → same id, no randomness)", () => {
  for (const slot of ["A", "B", "C"]) {
    assert.equal(personaSlotId(slot), personaSlotId(slot));
  }
});

console.log("BOP.PERSONA_SLOTS.v1 personaOverlay");

test("buildPersonaOverlay wraps title+content in DOMAIN PERSONA header", () => {
  const out = buildPersonaOverlay({ title: "Legal Counsel", content: "Cite jurisdictions." });
  assert.match(out, /=== DOMAIN PERSONA: LEGAL COUNSEL ===/);
  assert.match(out, /Cite jurisdictions\.$/);
});

test("buildPersonaOverlay upper-cases the title in the header", () => {
  const out = buildPersonaOverlay({ title: "engineer", content: "x" });
  assert.match(out, /DOMAIN PERSONA: ENGINEER/);
});

test("buildPersonaOverlay returns '' when content is empty or whitespace", () => {
  assert.equal(buildPersonaOverlay({ title: "x", content: "" }), "");
  assert.equal(buildPersonaOverlay({ title: "x", content: "   \n\t " }), "");
});

test("buildPersonaOverlay returns '' for null/undefined input", () => {
  assert.equal(buildPersonaOverlay(null), "");
  assert.equal(buildPersonaOverlay(undefined), "");
});

test("buildPersonaOverlay falls back to UNTITLED when title is blank", () => {
  const out = buildPersonaOverlay({ title: "   ", content: "real content" });
  assert.match(out, /=== DOMAIN PERSONA: UNTITLED ===/);
});

test("buildPersonaOverlay starts with two newlines so it doesn't fuse to the kernel", () => {
  const out = buildPersonaOverlay({ title: "x", content: "y" });
  assert.ok(out.startsWith("\n\n"), "overlay must begin with \\n\\n");
});

console.log("");
console.log(`pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
