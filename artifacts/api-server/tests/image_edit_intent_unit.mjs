#!/usr/bin/env node
/**
 * Task #84 — image-edit intent detection unit tests.
 *
 * Pure-function tests for `detectImageEditIntent`. The detector is the
 * gating predicate that decides whether a follow-up message should be
 * routed against the most recent generated_attachment instead of the
 * generation bridge or text engines.
 *
 * Two contracts to enforce:
 *   1. Positive edit phrasings ("make it blue", "remove the background",
 *      "change the lighting", "in a watercolor style") match.
 *   2. Vanilla generation prompts ("generate a sunset") and unrelated
 *      questions ("what is the capital of France") do NOT match — the
 *      generation detector takes precedence and false positives would
 *      silently swallow non-image inputs into the edit branch.
 *
 * Run from artifacts/api-server:
 *   $ node --experimental-strip-types tests/image_edit_intent_unit.mjs
 */
import assert from "node:assert/strict";
import {
  detectImageEditIntent,
  detectImageIntent,
} from "../src/bos/imageIntent.ts";

let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (err) { console.log(`  FAIL ${name}\n       ${err.stack || err.message}`); fail++; }
}

console.log("image_edit_intent_unit: edit detector contract");

// === 1. Positive edit phrasings ===
const POSITIVES = [
  "make it blue",
  "make them brighter",
  "make the sneaker red",
  "remove the background",
  "remove background please",
  "change the background to a beach",
  "change its color to pastel pink",
  "change the lighting",
  "edit this image to be more vibrant",
  "modify the image so the cat is orange",
  "refine this picture",
  "turn it into a watercolor",
  "turn the sneaker into a sandal",
  "in a cyberpunk style",
  "in a watercolor style",
  "add a hat to this image",
  "make it bigger",
  "make it more vibrant",
];

for (const text of POSITIVES) {
  test(`positive: "${text}"`, () => {
    const intent = detectImageEditIntent(text);
    assert.equal(intent.is_image_edit, true, "should detect as edit");
    assert.equal(intent.prompt, text);
    assert.ok(intent.matched_phrase, "should record matched phrase");
  });
}

// === 2. Negative cases — generation prompts and unrelated text ===
const NEGATIVES = [
  "generate an image of a sunset",
  "create a picture of a red sneaker",
  "draw a logo for my company",
  "what is the capital of France",
  "summarize the attached document",
  "how do I install Node.js",
  "",
  "   ",
  "tell me a joke",
  "describe the image",
];

for (const text of NEGATIVES) {
  test(`negative: "${text}"`, () => {
    const intent = detectImageEditIntent(text);
    assert.equal(intent.is_image_edit, false, "should NOT detect as edit");
  });
}

// === 3. Generation precedence — vanilla generation prompts that happen
// to contain edit-ish substrings must still route to generation, not
// edit. The pipeline checks edit detector first but only consumes its
// result when a parent attachment is found; the detector itself must
// also defer to generation when the generation grammar matches.
test("precedence: generation-style prompt with no edit pattern routes to generation", () => {
  const text = "create an image of a blue sneaker";
  const gen = detectImageIntent(text);
  const edit = detectImageEditIntent(text);
  assert.equal(gen.is_image_generation, true, "generation should match");
  assert.equal(edit.is_image_edit, false, "edit should defer to generation");
});

// === 4. Stability — repeated calls return identical shape ===
test("stable output shape across calls", () => {
  const a = detectImageEditIntent("make it blue");
  const b = detectImageEditIntent("make it blue");
  assert.deepEqual(a, b);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
