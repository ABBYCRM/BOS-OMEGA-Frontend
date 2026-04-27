#!/usr/bin/env node
/**
 * Task #68 — unit tests for the conversation clusterer's PURE helpers.
 *
 * Validates the deterministic surface that drives auto-clustering:
 *   - tokenize:        case-fold, drop stopwords + short tokens.
 *   - jaccard:         intersection / union, 0 when either side empty.
 *   - deriveTitle:     ≤ 60 chars, single-line, ellipsised.
 *   - deriveKeywords:  ≤ 10 distinct significant tokens.
 *   - scoreCandidates: best-of-recent-inputs and topic_keywords; ties
 *                      broken by candidate order (first wins).
 *
 * DB-touching paths (assignConversation) live in the e2e suite; this
 * file is intentionally side-effect-free so it can run anywhere with no
 * env setup.
 *
 * Run from artifacts/api-server:
 *   $ node --experimental-strip-types tests/conversation_clusterer_unit.mjs
 * Exits 0 on pass, 1 on any failure.
 */
import assert from "node:assert/strict";
// Import from the pure helper module (not conversationClusterer.ts) so
// the bare `--experimental-strip-types` runner doesn't try to resolve
// `@workspace/db`'s directory import.
import {
  tokenize,
  jaccard,
  deriveTitle,
  deriveKeywords,
  scoreCandidates,
  SIMILARITY_THRESHOLD,
} from "../src/bos/conversationClustererPure.ts";

let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (err) { console.log(`  FAIL ${name}\n       ${err.message}`); fail++; }
}

console.log("conversation_clusterer_unit: pure helpers");

test("tokenize lowercases, drops stopwords + short tokens", () => {
  const t = tokenize("The Vendor Risk Review for ACME-Corp");
  // "the" (stopword), "for" (stopword) are dropped.
  // "the" is also length 3 but in stopwords; survives if not stopword.
  assert.ok(t.has("vendor"));
  assert.ok(t.has("risk"));
  assert.ok(t.has("review"));
  assert.ok(t.has("acme"));
  assert.ok(t.has("corp"));
  assert.ok(!t.has("the"));
  assert.ok(!t.has("for"));
});

test("tokenize returns empty set for empty / whitespace input", () => {
  assert.equal(tokenize("").size, 0);
  assert.equal(tokenize("   ").size, 0);
  assert.equal(tokenize("a b c").size, 0); // all length<3
});

test("jaccard = 0 when either side is empty", () => {
  assert.equal(jaccard(new Set(), new Set(["foo"])), 0);
  assert.equal(jaccard(new Set(["foo"]), new Set()), 0);
});

test("jaccard = 1 for identical sets", () => {
  const a = new Set(["foo", "bar", "baz"]);
  const b = new Set(["foo", "bar", "baz"]);
  assert.equal(jaccard(a, b), 1);
});

test("jaccard symmetry: jaccard(a,b) === jaccard(b,a)", () => {
  const a = new Set(["alpha", "beta", "gamma"]);
  const b = new Set(["beta", "gamma", "delta"]);
  assert.equal(jaccard(a, b), jaccard(b, a));
});

test("jaccard known value: 2/4 = 0.5", () => {
  const a = new Set(["x", "y", "z"]);
  const b = new Set(["y", "z", "q"]);
  // intersection = {y,z}=2, union = {x,y,z,q}=4, score = 0.5
  assert.equal(jaccard(a, b), 0.5);
});

test("deriveTitle returns 'Untitled conversation' for empty input", () => {
  assert.equal(deriveTitle(""), "Untitled conversation");
  assert.equal(deriveTitle("   \n\t  "), "Untitled conversation");
});

test("deriveTitle preserves short single-line input verbatim", () => {
  assert.equal(deriveTitle("Vendor risk review"), "Vendor risk review");
});

test("deriveTitle truncates >60 chars with ellipsis", () => {
  const long = "A".repeat(120);
  const t = deriveTitle(long);
  assert.equal(t.length, 60);
  assert.ok(t.endsWith("…"));
});

test("deriveTitle collapses internal whitespace to single spaces", () => {
  const t = deriveTitle("foo\n\nbar  \tbaz");
  assert.equal(t, "foo bar baz");
});

test("deriveKeywords returns at most KEYWORDS_MAX=10 tokens", () => {
  const words = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
  const kw = deriveKeywords(words);
  assert.ok(kw.length <= 10);
  assert.ok(kw.length > 0);
});

test("scoreCandidates: empty candidates → null, score=0", () => {
  const r = scoreCandidates("anything", []);
  assert.equal(r.conversation_id, null);
  assert.equal(r.score, 0);
});

test("scoreCandidates: picks best by recent_inputs jaccard", () => {
  const r = scoreCandidates(
    "vendor risk review for ACME corporation",
    [
      { id: "c1", topic_keywords: [], recent_inputs: ["completely unrelated taxes filing"] },
      { id: "c2", topic_keywords: [], recent_inputs: ["vendor risk approval ACME inc"] },
    ],
  );
  assert.equal(r.conversation_id, "c2");
  assert.ok(r.score > 0);
});

test("scoreCandidates: also considers topic_keywords", () => {
  const r = scoreCandidates(
    "review the contract liability cap and indemnity clauses",
    [
      { id: "c1", topic_keywords: [], recent_inputs: ["zzz"] },
      { id: "c2", topic_keywords: ["contract", "liability", "indemnity"], recent_inputs: ["yyy"] },
    ],
  );
  assert.equal(r.conversation_id, "c2");
  assert.ok(r.score > 0);
});

test("scoreCandidates: per-candidate best-of-N (max over recent_inputs)", () => {
  const r = scoreCandidates(
    "vendor risk review",
    [
      {
        id: "c1",
        topic_keywords: [],
        recent_inputs: [
          "totally unrelated content",
          "vendor risk review",       // perfect match — should drive c1's score
        ],
      },
    ],
  );
  assert.equal(r.conversation_id, "c1");
  assert.ok(r.score >= 0.99);
});

test("scoreCandidates: ties broken by first-encountered (deterministic order)", () => {
  // Two perfect matches → first wins.
  const r = scoreCandidates(
    "vendor risk review",
    [
      { id: "c1", topic_keywords: [], recent_inputs: ["vendor risk review"] },
      { id: "c2", topic_keywords: [], recent_inputs: ["vendor risk review"] },
    ],
  );
  assert.equal(r.conversation_id, "c1");
});

test("SIMILARITY_THRESHOLD is exposed and stable at 0.18", () => {
  // Pinned because the value is part of the user-visible behaviour
  // contract — bumping it without a migration plan changes which
  // historical threads new tasks land in.
  assert.equal(SIMILARITY_THRESHOLD, 0.18);
});

test("scoreCandidates: matched score below threshold still returned (caller decides)", () => {
  // Caller (assignConversation) is responsible for comparing against
  // SIMILARITY_THRESHOLD. The pure scorer must not silently drop weak
  // matches — that would hide useful telemetry from the audit log.
  const r = scoreCandidates(
    "alpha beta gamma delta",
    [
      { id: "c1", topic_keywords: [], recent_inputs: ["epsilon zeta eta theta alpha"] },
    ],
  );
  assert.ok(r.conversation_id === "c1");
  assert.ok(r.score > 0);
  assert.ok(r.score < SIMILARITY_THRESHOLD);
});

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
