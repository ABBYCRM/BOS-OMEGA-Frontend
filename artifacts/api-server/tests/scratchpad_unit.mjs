#!/usr/bin/env node
/**
 * Task #67 — unit tests for the deterministic scratchpad summary builder.
 *
 * The strict contract these tests pin (see canon row "BOS-OMEGA
 * Scratchpad Summary Contract"):
 *   - Output is a SINGLE PARAGRAPH (no embedded newlines).
 *   - At most THREE sentences. Two when no notes are present, three
 *     when the writer folds in a top uncertainty/assumption.
 *   - Sentence one identifies the task (id, type, state) AND folds in
 *     the user's request head — combining keeps us within the budget.
 *   - Sentence two is the answer head (truncated).
 *   - Sentence three (optional) is the single most-relevant note —
 *     uncertainty wins over assumption; extras are dropped.
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

function countSentences(s) {
  return s.split(/\.(?=\s|$)/).filter((p) => p.trim().length > 0).length;
}

console.log("scratchpad_unit: buildAutoSummary contract (≤ 3 sentence summary)");

test("opening sentence identifies task_id, task_type, state, and folds in request head", () => {
  const out = buildAutoSummary({
    task_id: "abc-1234",
    task_type: "general",
    state: "GO",
    answer: "Hello world",
    input_text: "What is 2+2?",
  });
  // Single sentence captures task identity + the user's request. The
  // `?` from the request is stripped by `preview()` to keep the
  // structural sentence count stable regardless of input punctuation.
  assert.match(out.content, /^Task abc-1234 \(general\) completed with state GO for request "What is 2\+2"\./);
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

test("truncates very long answer with ellipsis (and stays bounded)", () => {
  const huge = "A".repeat(2000);
  const out = buildAutoSummary({
    task_id: "x",
    task_type: "general",
    state: "GO",
    answer: huge,
    input_text: "ask",
  });
  assert.match(out.content, /Answer: A+…\.$/);
  // Total content stays well under the raw answer size.
  assert.ok(out.content.length < 600, `content too long: ${out.content.length}`);
});

test("with no notes, output has EXACTLY 2 sentences (task+request, then answer)", () => {
  const out = buildAutoSummary({
    task_id: "x", task_type: "general", state: "GO",
    answer: "yes", input_text: "ask",
  });
  assert.equal(countSentences(out.content), 2,
    `expected 2 sentences, got ${countSentences(out.content)}: ${out.content}`);
});

test("with notes, output has EXACTLY 3 sentences (never 4)", () => {
  // Even when BOTH uncertainties and assumptions are supplied, the
  // writer picks ONE (uncertainty wins) so the contract-mandated
  // 3-sentence ceiling is never breached.
  const out = buildAutoSummary({
    task_id: "x", task_type: "general", state: "GO",
    answer: "yes", input_text: "ask",
    uncertainties: ["maybe wrong", "second uncertainty", "third"],
    assumptions: ["assumed thing"],
  });
  assert.equal(countSentences(out.content), 3,
    `expected 3 sentences, got ${countSentences(out.content)}: ${out.content}`);
  // Uncertainty picked over assumption.
  assert.match(out.content, /Top uncertainty: maybe wrong\.$/);
});

test("when only assumptions are supplied, the assumption is folded in", () => {
  const out = buildAutoSummary({
    task_id: "x", task_type: "general", state: "GO",
    answer: "yes", input_text: "ask",
    assumptions: ["assumed thing"],
  });
  assert.equal(countSentences(out.content), 3);
  assert.match(out.content, /Top assumption: assumed thing\.$/);
});

test("punctuation-heavy inputs cannot inflate the sentence count above 3", () => {
  // Architect-found regression: an `input_text` like "A. B." or an
  // `answer` containing internal periods would silently breach the
  // 2–3 sentence ceiling because the regex used for counting
  // sentences split on every `.`. The writer now strips
  // sentence-terminating punctuation from interpolated text.
  const cases = [
    { input_text: "A. B.", answer: "X. Y." },
    { input_text: "First sentence. Second sentence! Third?",
      answer: "First sentence. Second sentence! Third?" },
    { input_text: "ellipsis…in input", answer: "ellipsis…in answer" },
    { input_text: "Mr. Smith asked: what's 2+2?",
      answer: "It's 4. That's it." },
    { input_text: "", answer: "" },
  ];
  for (const c of cases) {
    const out = buildAutoSummary({
      task_id: "x", task_type: "general", state: "GO", ...c,
    });
    const n = countSentences(out.content);
    assert.ok(n <= 2, `no-notes case must be ≤ 2 sentences, got ${n}: ${out.content}`);

    const withNote = buildAutoSummary({
      task_id: "x", task_type: "general", state: "GO", ...c,
      uncertainties: ["maybe? sure! definitely."],
    });
    const m = countSentences(withNote.content);
    assert.ok(m <= 3,
      `with-notes case must be ≤ 3 sentences, got ${m}: ${withNote.content}`);
  }
});

test("is deterministic for identical inputs (mock-mode safety)", () => {
  const args = {
    task_id: "stable",
    task_type: "general",
    state: "GO",
    answer: "the answer",
    input_text: "the input",
    uncertainties: ["u1", "u2"],
  };
  const a = buildAutoSummary(args);
  const b = buildAutoSummary(args);
  assert.deepEqual(a, b);
});

console.log(`\nscratchpad_unit: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
