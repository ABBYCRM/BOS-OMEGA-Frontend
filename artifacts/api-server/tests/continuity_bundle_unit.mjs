#!/usr/bin/env node
/**
 * Task #64 — unit tests for the continuity bundle helpers
 * (continuityBundle.ts).
 *
 * Contract these tests pin:
 *   - buildContinuityBundle → parseContinuityBundle round-trips
 *     losslessly; payload identity holds under canonicalJSON equality.
 *   - The fidelity hash recomputes on parse and verifies for an
 *     untouched blob.
 *   - Tampering with any byte in the JSON envelope drops hash_ok=false.
 *   - A missing fence raises BUNDLE_NO_FENCE.
 *   - An unsupported format_version raises BUNDLE_UNSUPPORTED_VERSION.
 *   - A missing fidelity_hash field raises BUNDLE_NO_HASH.
 *   - Bundles over MAX_BUNDLE_BYTES raise BUNDLE_TOO_LARGE.
 *   - Section caps (MAX_TURNS, MAX_SCRATCHPAD_ITEMS, MAX_CONTINUITY_ITEMS)
 *     are applied at build time.
 *   - computeCanonHash is deterministic and order-invariant.
 *   - previewContinuityBundle correctly flags scratchpad/continuity
 *     overwrites against an existing-id set.
 *
 * Run from artifacts/api-server:
 *   $ node --experimental-strip-types tests/continuity_bundle_unit.mjs
 * Exits 0 on pass, 1 on any failure.
 */
import assert from "node:assert/strict";
import {
  canonicalJSON,
  buildContinuityBundle,
  parseContinuityBundle,
  previewContinuityBundle,
  computeCanonHash,
  summarizeCanon,
  CONTINUITY_BUNDLE_FENCE,
  CONTINUITY_BUNDLE_VERSION,
  MAX_BUNDLE_BYTES,
  MAX_TURNS,
  MAX_SCRATCHPAD_ITEMS,
  MAX_CONTINUITY_ITEMS,
  BundleParseError,
} from "../src/bos/continuityBundle.ts";

let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (err) { console.log(`  FAIL ${name}\n       ${err.message}`); fail++; }
}

console.log("continuity_bundle_unit: format helpers contract");

function samplePayload() {
  return {
    exported_at: "2026-04-27T00:00:00.000Z",
    source_session_id: "sess-1234",
    scope: "task",
    task_id: "task-1",
    conversation_id: "conv-1",
    conversation_title: "Onboarding",
    canon: {
      hash: "a".repeat(64),
      summary: "2 canon rows: Tone, Greet",
      items_count: 2,
    },
    persona_slot: { slot: "A", title: "Legal Counsel", content: "Be precise about jurisdiction." },
    budgets: { canon: 3000, continuity: 1500, patches: 1000, scratchpad: 750 },
    scratchpad: [
      { id: "s1", title: "Pin: alpha", content: "Always greet by name.", authority_level: 5, source: "manual_pin", source_task_id: "task-1", created_at: "2026-04-27T00:00:00.000Z" },
      { id: "s2", title: "Auto: task-1", content: "Summary text", authority_level: 3, source: "auto_summary", source_task_id: "task-1", created_at: "2026-04-27T00:00:00.000Z" },
    ],
    continuity: [
      { id: "k1", title: "Project", content: "BOS-OMEGA is the lattice host.", authority_level: 5 },
    ],
    turns: [
      { task_id: "task-1", created_at: "2026-04-27T00:00:00.000Z", user_input: "Hi", assistant_output: "Hello.", tri_state: "GO", task_type: "general", mode: "single" },
    ],
  };
}

// ---------- Round-trip ----------

test("buildContinuityBundle → parseContinuityBundle is a perfect round-trip", () => {
  const built = buildContinuityBundle(samplePayload());
  assert.match(built.blob, /^# BOS-OMEGA Continuity Bundle/);
  assert.ok(built.blob.includes("```" + CONTINUITY_BUNDLE_FENCE), "blob must contain the fence");
  assert.equal(typeof built.hash, "string");
  assert.match(built.hash, /^[a-f0-9]{64}$/);
  const parsed = parseContinuityBundle(built.blob);
  assert.equal(parsed.hash_ok, true);
  assert.equal(parsed.recomputed_hash, built.hash);
  // Canonical equality: the parsed payload (which carries the
  // fidelity_hash from the envelope) matches the sealed payload.
  assert.equal(canonicalJSON(parsed.payload), canonicalJSON(built.payload));
});

test("parsed payload has format_version === '1.0' and scope is preserved", () => {
  const built = buildContinuityBundle(samplePayload());
  const parsed = parseContinuityBundle(built.blob);
  assert.equal(parsed.payload.format_version, CONTINUITY_BUNDLE_VERSION);
  assert.equal(parsed.payload.scope, "task");
});

test("byte_size equals UTF-8 byte length of blob", () => {
  const built = buildContinuityBundle(samplePayload());
  assert.equal(built.byte_size, Buffer.byteLength(built.blob, "utf8"));
});

// ---------- Tampering ----------

test("tampering inside the JSON envelope flips hash_ok=false", () => {
  const built = buildContinuityBundle(samplePayload());
  const tampered = built.blob.replace('"Pin: alpha"', '"Pin: alphaX"');
  assert.notEqual(tampered, built.blob, "tampering must actually mutate the blob");
  const parsed = parseContinuityBundle(tampered);
  assert.equal(parsed.hash_ok, false);
  assert.notEqual(parsed.recomputed_hash, parsed.payload.fidelity_hash);
});

// ---------- Failure modes ----------

test("parseContinuityBundle throws BUNDLE_NO_FENCE when fence is missing", () => {
  let err = null;
  try { parseContinuityBundle("just some text\n"); } catch (e) { err = e; }
  assert.ok(err instanceof BundleParseError, "should be a BundleParseError");
  assert.equal(err.code, "BUNDLE_NO_FENCE");
});

test("parseContinuityBundle throws BUNDLE_UNSUPPORTED_VERSION on a future v2 blob", () => {
  const built = buildContinuityBundle(samplePayload());
  const bad = built.blob.replace('"format_version": "1.0"', '"format_version": "2.0"');
  let err = null;
  try { parseContinuityBundle(bad); } catch (e) { err = e; }
  assert.ok(err instanceof BundleParseError);
  assert.equal(err.code, "BUNDLE_UNSUPPORTED_VERSION");
});

test("parseContinuityBundle throws BUNDLE_NO_HASH when fidelity_hash is missing", () => {
  const built = buildContinuityBundle(samplePayload());
  const bad = built.blob.replace(/"fidelity_hash": "[a-f0-9]{64}"/, '"fidelity_hash": ""');
  let err = null;
  try { parseContinuityBundle(bad); } catch (e) { err = e; }
  assert.ok(err instanceof BundleParseError);
  assert.equal(err.code, "BUNDLE_NO_HASH");
});

test("parseContinuityBundle throws BUNDLE_TOO_LARGE above MAX_BUNDLE_BYTES", () => {
  // Use a fake blob over the cap — we don't need it to be valid JSON
  // because the size guard runs first.
  const huge = "x".repeat(MAX_BUNDLE_BYTES + 10);
  let err = null;
  try { parseContinuityBundle(huge); } catch (e) { err = e; }
  assert.ok(err instanceof BundleParseError);
  assert.equal(err.code, "BUNDLE_TOO_LARGE");
});

test("parseContinuityBundle throws BUNDLE_BAD_SCOPE when scope is missing/invalid", () => {
  const built = buildContinuityBundle(samplePayload());
  const bad = built.blob.replace('"scope": "task"', '"scope": "weird"');
  let err = null;
  try { parseContinuityBundle(bad); } catch (e) { err = e; }
  assert.ok(err instanceof BundleParseError);
  assert.equal(err.code, "BUNDLE_BAD_SCOPE");
});

// ---------- Section caps ----------

test("buildContinuityBundle caps scratchpad to MAX_SCRATCHPAD_ITEMS", () => {
  const p = samplePayload();
  p.scratchpad = Array.from({ length: MAX_SCRATCHPAD_ITEMS + 5 }, (_, i) => ({
    id: `s-${i}`, title: `t-${i}`, content: "c", authority_level: 3,
    source: "auto_summary", source_task_id: null,
    created_at: "2026-04-27T00:00:00.000Z",
  }));
  const built = buildContinuityBundle(p);
  assert.equal(built.payload.scratchpad.length, MAX_SCRATCHPAD_ITEMS);
});

test("buildContinuityBundle caps continuity to MAX_CONTINUITY_ITEMS", () => {
  const p = samplePayload();
  p.continuity = Array.from({ length: MAX_CONTINUITY_ITEMS + 3 }, (_, i) => ({
    id: `c-${i}`, title: `t-${i}`, content: "c", authority_level: 5,
  }));
  const built = buildContinuityBundle(p);
  assert.equal(built.payload.continuity.length, MAX_CONTINUITY_ITEMS);
});

test("buildContinuityBundle caps turns to MAX_TURNS", () => {
  const p = samplePayload();
  p.turns = Array.from({ length: MAX_TURNS + 2 }, (_, i) => ({
    task_id: `t-${i}`, created_at: "2026-04-27T00:00:00.000Z",
    user_input: "u", assistant_output: "a",
    tri_state: "GO", task_type: "general", mode: "single",
  }));
  const built = buildContinuityBundle(p);
  assert.equal(built.payload.turns.length, MAX_TURNS);
});

// ---------- Canon hash helper ----------

test("computeCanonHash is deterministic", () => {
  const rows = [
    { id: "c1", title: "Tone", content: "Be concise." },
    { id: "c2", title: "Greet", content: "Greet warmly." },
  ];
  const h1 = computeCanonHash(rows);
  const h2 = computeCanonHash(rows);
  assert.equal(h1, h2);
  assert.match(h1, /^[a-f0-9]{64}$/);
});

test("computeCanonHash is order-invariant on row order", () => {
  const a = [
    { id: "c1", title: "Tone", content: "Be concise." },
    { id: "c2", title: "Greet", content: "Greet warmly." },
  ];
  const b = [a[1], a[0]];
  assert.equal(computeCanonHash(a), computeCanonHash(b));
});

test("computeCanonHash changes when content changes", () => {
  const a = [{ id: "c1", title: "Tone", content: "Be concise." }];
  const b = [{ id: "c1", title: "Tone", content: "Be terse." }];
  assert.notEqual(computeCanonHash(a), computeCanonHash(b));
});

test("summarizeCanon produces a useful snippet", () => {
  const s = summarizeCanon([
    { id: "c1", title: "Tone", content: "" },
    { id: "c2", title: "Greet", content: "" },
  ]);
  assert.match(s, /2 canon rows/);
  assert.match(s, /Tone/);
  assert.match(s, /Greet/);
});

test("summarizeCanon handles the empty case without crashing", () => {
  assert.equal(summarizeCanon([]), "(no canon rows loaded)");
});

// ---------- Preview / diff ----------

test("previewContinuityBundle reports overwrites against an existing id set", () => {
  const built = buildContinuityBundle(samplePayload());
  const parsed = parseContinuityBundle(built.blob);
  const preview = previewContinuityBundle(parsed, built.byte_size, {
    local_canon_hash: built.payload.canon.hash,
    existing_scratchpad_ids: new Set(["s1"]),
    existing_continuity_ids: new Set([]),
  });
  assert.equal(preview.canon_match, true);
  assert.deepEqual(preview.conflicts.scratchpad_overwrites, ["s1"]);
  assert.deepEqual(preview.conflicts.continuity_overwrites, []);
  assert.equal(preview.counts.turns, 1);
});

test("previewContinuityBundle marks canon_match=false on hash mismatch", () => {
  const built = buildContinuityBundle(samplePayload());
  const parsed = parseContinuityBundle(built.blob);
  const preview = previewContinuityBundle(parsed, built.byte_size, {
    local_canon_hash: "deadbeef".repeat(8),
  });
  assert.equal(preview.canon_match, false);
});

test("previewContinuityBundle reports canon_match=null when no local hash provided", () => {
  const built = buildContinuityBundle(samplePayload());
  const parsed = parseContinuityBundle(built.blob);
  const preview = previewContinuityBundle(parsed, built.byte_size, {});
  assert.equal(preview.canon_match, null);
});

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
