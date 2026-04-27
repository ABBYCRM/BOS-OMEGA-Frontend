#!/usr/bin/env node
/**
 * Task #67 — Lattice continuity scratchpad unit tests.
 *
 * Pure tests for the deterministic summary builder used by the scratchpad
 * auto-writer. Mirrors the bare-node convention used by the other suites
 * in this directory (no Vitest, no DB, no network) so the file can run
 * with the project's existing `node --experimental-strip-types` loader:
 *
 *   $ node --experimental-strip-types tests/scratchpad_unit.mjs
 *
 * The DB-touching writer (scratchpadWriter.ts) is exercised end-to-end by
 * the API server in development; we don't test the DB insert here because
 * the bare ESM loader can't walk @workspace/db.
 */
import assert from "node:assert/strict";
import { buildAutoSummary } from "../src/bos/scratchpadSummary.ts";

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    pass++;
  } catch (err) {
    console.log(`  FAIL ${name}\n      ${err?.message || err}`);
    fail++;
  }
}

console.log("scratchpad_unit: buildAutoSummary deterministic format");

t("includes task_id, task_type and state in first line", () => {
  const out = buildAutoSummary({
    task_id: "task-abc-123",
    task_type: "general",
    state: "GO",
    answer: "Hello world",
    input_text: "say hi",
  });
  const firstLine = out.content.split("\n")[0];
  assert.ok(firstLine.includes("task-abc-123"), `missing task_id: ${firstLine}`);
  assert.ok(firstLine.includes("general"), `missing task_type: ${firstLine}`);
  assert.ok(firstLine.includes("GO"), `missing state: ${firstLine}`);
});

t("title uses first line of answer when available", () => {
  const out = buildAutoSummary({
    task_id: "t1",
    task_type: "qa",
    state: "GO",
    answer: "Capital of France is Paris.\nMore detail follows…",
    input_text: "what is the capital of France?",
  });
  assert.ok(out.title.startsWith("Auto: "), `bad title prefix: ${out.title}`);
  assert.ok(out.title.includes("Capital of France"), `title missing head: ${out.title}`);
  assert.ok(!out.title.includes("\n"), `title must be single-line: ${out.title}`);
});

t("title falls back to task_id slice when answer is empty", () => {
  const out = buildAutoSummary({
    task_id: "12345678-aaaa-bbbb",
    task_type: "general",
    state: "HOLD",
    answer: "",
    input_text: "something",
  });
  assert.ok(out.title.startsWith("Auto: task "), `bad fallback title: ${out.title}`);
  assert.ok(out.title.includes("12345678"), `fallback should embed task_id slice: ${out.title}`);
  assert.ok(out.content.includes("Answer: (empty)"), `empty answer marker missing`);
});

t("truncates very long answer at 360 chars + ellipsis", () => {
  const longAnswer = "x".repeat(2000);
  const out = buildAutoSummary({
    task_id: "t2",
    task_type: "general",
    state: "GO",
    answer: longAnswer,
    input_text: "produce a long answer",
  });
  const answerLine = out.content.split("\n").find((l) => l.startsWith("Answer:")) ?? "";
  // "Answer: " prefix (8) + 360 truncated payload (incl. trailing …)
  assert.ok(answerLine.length <= 8 + 360 + 1, `answer line too long: ${answerLine.length}`);
  assert.ok(answerLine.endsWith("…"), `truncation marker missing`);
});

t("truncates very long input_text in User asked line", () => {
  const longInput = "y".repeat(2000);
  const out = buildAutoSummary({
    task_id: "t3",
    task_type: "general",
    state: "GO",
    answer: "ok",
    input_text: longInput,
  });
  const askedLine = out.content.split("\n").find((l) => l.startsWith("User asked:")) ?? "";
  assert.ok(askedLine.length <= 11 + 200 + 1, `user-asked line too long: ${askedLine.length}`);
  assert.ok(askedLine.endsWith("…"), `truncation marker missing on user-asked line`);
});

t("emits Uncertainties / Assumptions only when arrays non-empty", () => {
  const without = buildAutoSummary({
    task_id: "t4",
    task_type: "general",
    state: "GO",
    answer: "fine",
    input_text: "ask",
  });
  assert.ok(!without.content.includes("Uncertainties:"), "should omit Uncertainties when empty");
  assert.ok(!without.content.includes("Assumptions:"),  "should omit Assumptions when empty");

  const withBoth = buildAutoSummary({
    task_id: "t4",
    task_type: "general",
    state: "GO",
    answer: "fine",
    input_text: "ask",
    uncertainties: ["maybe", "perhaps", "could be", "fourth dropped"],
    assumptions: ["a1", "a2"],
  });
  assert.ok(withBoth.content.includes("Uncertainties: maybe · perhaps · could be"),
    "uncertainties should be joined with · and capped at 3");
  assert.ok(!withBoth.content.includes("fourth dropped"), "uncertainties cap should drop the 4th");
  assert.ok(withBoth.content.includes("Assumptions: a1 · a2"), "assumptions should join cleanly");
});

t("is deterministic for identical inputs (mock-mode safety)", () => {
  const a = buildAutoSummary({
    task_id: "det",
    task_type: "general",
    state: "GO",
    answer: "answer body",
    input_text: "ask body",
    uncertainties: ["u"],
    assumptions: ["a"],
  });
  const b = buildAutoSummary({
    task_id: "det",
    task_type: "general",
    state: "GO",
    answer: "answer body",
    input_text: "ask body",
    uncertainties: ["u"],
    assumptions: ["a"],
  });
  assert.equal(a.title, b.title);
  assert.equal(a.content, b.content);
});

t("title ignores trailing whitespace and newlines in head", () => {
  const out = buildAutoSummary({
    task_id: "t5",
    task_type: "general",
    state: "GO",
    answer: "   line one with leading space   \nline two",
    input_text: "ask",
  });
  assert.ok(!out.title.endsWith(" "), `title should be trimmed: "${out.title}"`);
  assert.ok(!out.title.includes("line two"), `title must use only first line`);
});

console.log(`\nscratchpad_unit: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
