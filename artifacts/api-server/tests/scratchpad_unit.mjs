#!/usr/bin/env node
/**
 * Task #67 — unit tests for the deterministic scratchpad summary builder.
 *
 * The contract these tests pin (see canon row "BOS-OMEGA Scratchpad
 * Summary Contract"):
 *   - Output is a SINGLE PARAGRAPH (no embedded newlines).
 *   - Three required sentences: task header, user-asked, answer.
 *   - Optional fourth sentence collapsing uncertainties+assumptions.
 *   - Long inputs are truncated with "…" rather than wrapped.
 *   - Identical inputs produce identical output (deterministic; required
 *     so mock-mode and offline tests see the same output as production).
 *
 * Run from artifacts/api-server:
 *   $ node --experimental-strip-types tests/scratchpad_unit.mjs
 * Exits 0 on pass, 1 on any failure.
 */
import assert from "node:assert/strict";
import { buildAutoSummary } from "../src/bos/scratchpadSummary.ts";

let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (err) { console.log(`  FAIL ${name}\n       ${err.message}`); fail++; }
}

console.log("scratchpad_unit: buildAutoSummary contract (2–3 sentence summary)");

test("includes task_id, task_type and state in opening sentence", () => {
  const out = buildAutoSummary({
    task_id: "abc-1234",
    task_type: "general",
    state: "GO",
    answer: "Hello world",
    input_text: "What is 2+2?",
  });
  assert.match(out.content, /^Task abc-1234 \(general\) completed with state GO\./);
});

test("title uses first line of answer when available", () => {
  const out = buildAutoSummary({
    task_id: "id-x",
    task_type: "general",
    state: "GO",
    answer: "First line is a good title\nSecond line is body",
    input_text: "ask",
  });
  assert.equal(out.title, "Auto: First line is a good title");
});

test("title falls back to task_id slice when answer is empty", () => {
  const out = buildAutoSummary({
    task_id: "ffffffff-aaaa-bbbb-cccc-1234567890ab",
    task_type: "general",
    state: "ABORT",
    answer: "",
    input_text: "ask",
  });
  assert.equal(out.title, "Auto: task ffffffff");
});

test("output is a single paragraph (no embedded newlines)", () => {
  const out = buildAutoSummary({
    task_id: "x",
    task_type: "general",
    state: "GO",
    answer: "Line one\nLine two\nLine three",
    input_text: "Multi\nline\ninput",
  });
  assert.equal(out.content.includes("\n"), false, "content must not contain newlines");
  assert.equal(out.title.includes("\n"), false, "title must not contain newlines");
});

test("truncates very long answer with ellipsis", () => {
  const huge = "A".repeat(2000);
  const out = buildAutoSummary({
    task_id: "x",
    task_type: "general",
    state: "GO",
    answer: huge,
    input_text: "ask",
  });
  assert.match(out.content, /Answer: A+…\.$/);
  // The Answer sentence body (between "Answer: " and final ".") must be
  // bounded and not 2000+ chars.
  const m = out.content.match(/Answer: ([^.]+)\.$/);
  assert.ok(m, "Answer sentence not found");
  assert.ok(m[1].length < 400, `answer body too long: ${m[1].length}`);
});

test("emits Notes line only when uncertainties / assumptions non-empty", () => {
  const without = buildAutoSummary({
    task_id: "x",
    task_type: "general",
    state: "GO",
    answer: "ok",
    input_text: "ask",
  });
  assert.equal(without.content.includes("Notes:"), false);

  const withBoth = buildAutoSummary({
    task_id: "x",
    task_type: "general",
    state: "GO",
    answer: "ok",
    input_text: "ask",
    uncertainties: ["maybe wrong"],
    assumptions: ["assumed thing"],
  });
  assert.match(withBoth.content, /Notes: uncertainties — maybe wrong \| assumptions — assumed thing\./);
});

test("is deterministic for identical inputs (mock-mode safety)", () => {
  const args = {
    task_id: "stable",
    task_type: "general",
    state: "GO",
    answer: "the answer",
    input_text: "the input",
  };
  const a = buildAutoSummary(args);
  const b = buildAutoSummary(args);
  assert.deepEqual(a, b);
});

test("3 sentences when no notes, 4 sentences when notes present", () => {
  const a = buildAutoSummary({
    task_id: "x", task_type: "general", state: "GO", answer: "yes", input_text: "ask",
  });
  // Count sentence-terminating periods that are followed by space-or-EOS.
  const a_sentences = a.content.split(/\.(?=\s|$)/).filter((s) => s.trim().length > 0);
  assert.equal(a_sentences.length, 3, `expected 3 sentences, got ${a_sentences.length}: ${a.content}`);

  const b = buildAutoSummary({
    task_id: "x", task_type: "general", state: "GO", answer: "yes", input_text: "ask",
    uncertainties: ["u1"],
  });
  const b_sentences = b.content.split(/\.(?=\s|$)/).filter((s) => s.trim().length > 0);
  assert.equal(b_sentences.length, 4, `expected 4 sentences, got ${b_sentences.length}: ${b.content}`);
});

console.log(`\nscratchpad_unit: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
