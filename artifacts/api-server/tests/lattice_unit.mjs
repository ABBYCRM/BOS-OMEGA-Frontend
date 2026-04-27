#!/usr/bin/env node
/**
 * Task #69 — unit tests for the lattice format helpers (latticeFormat.ts).
 *
 * Contract these tests pin (see canon row "Lattice Receiver Protocol"
 * and the JSDoc on latticeFormat.ts):
 *   - canonicalJSON sorts object keys at every level, drops undefined,
 *     emits no whitespace, and preserves array order.
 *   - The fidelity hash is sha256(canonicalJSON(payload \ {fidelity_hash})).
 *     The hash is independent of the pretty-printed JSON embedded in
 *     the markdown — pretty whitespace there does NOT change it.
 *   - buildLatticeBlob → parseLatticeBlob is a perfect round-trip
 *     (payload bytes match; hash verifies).
 *   - Tampering with the embedded JSON (any byte) breaks verification.
 *   - format_version mismatch is fatal at parse time (versioned wire
 *     format — a v2 importer must refuse v1 silently passing through).
 *   - Missing fence is fatal.
 *
 * Run from artifacts/api-server:
 *   $ node --experimental-strip-types tests/lattice_unit.mjs
 * Exits 0 on pass, 1 on any failure.
 */
import assert from "node:assert/strict";
import {
  canonicalJSON,
  sha256Hex,
  computeFidelityHash,
  buildLatticeBlob,
  parseLatticeBlob,
  LATTICE_FORMAT_VERSION,
  LATTICE_FENCE_LABEL,
  LATTICE_HEADER_PREAMBLE,
} from "../src/bos/latticeFormat.ts";

let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (err) { console.log(`  FAIL ${name}\n       ${err.message}`); fail++; }
}

console.log("lattice_unit: format helpers contract");

// ---------------------------------------------------------------- canonicalJSON

test("canonicalJSON sorts keys recursively", () => {
  const a = canonicalJSON({ b: 1, a: 2, c: { y: 3, x: 4 } });
  // Keys at both levels must be alphabetically ordered, regardless of
  // input insertion order.
  assert.equal(a, '{"a":2,"b":1,"c":{"x":4,"y":3}}');
});

test("canonicalJSON is order-invariant for objects", () => {
  const a = canonicalJSON({ x: 1, y: 2, z: { p: 5, q: 6 } });
  const b = canonicalJSON({ z: { q: 6, p: 5 }, y: 2, x: 1 });
  assert.equal(a, b);
});

test("canonicalJSON preserves array order (order is significant)", () => {
  // Critical: arrays carry semantic ordering (e.g. conversation task
  // sequence). Sorting arrays would silently reorder transcripts.
  const a = canonicalJSON([3, 1, 2]);
  assert.equal(a, '[3,1,2]');
});

test("canonicalJSON drops undefined object fields", () => {
  const a = canonicalJSON({ a: 1, b: undefined, c: 3 });
  assert.equal(a, '{"a":1,"c":3}');
});

test("canonicalJSON encodes undefined inside arrays as null (JSON.stringify parity)", () => {
  const a = canonicalJSON([1, undefined, 3]);
  assert.equal(a, '[1,null,3]');
});

test("canonicalJSON handles null, booleans, numbers, strings", () => {
  assert.equal(canonicalJSON(null), "null");
  assert.equal(canonicalJSON(true), "true");
  assert.equal(canonicalJSON(false), "false");
  assert.equal(canonicalJSON(42), "42");
  assert.equal(canonicalJSON("hi"), '"hi"');
});

test("sha256Hex matches a known vector", () => {
  // Independently verifiable: sha256("hello") = 2cf24dba5fb0a30e...
  assert.equal(
    sha256Hex("hello"),
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  );
});

// ---------------------------------------------------------------- fidelity hash

function samplePayload() {
  // Small but representative payload — covers every layer + a non-empty
  // conversation with one task. The deterministic timestamp keeps the
  // hash stable across test runs.
  return {
    format_version: LATTICE_FORMAT_VERSION,
    exported_at: "2026-01-01T00:00:00.000Z",
    source_session_id: "sess-abcdef",
    memory_layers: {
      canon: [
        { id: "c1", layer: "canon", title: "Tone", content: "Be concise.", authority_level: 9, source: "manual", source_task_id: null },
      ],
      continuity: [
        { id: "k1", layer: "continuity", title: "Project", content: "BOS-OMEGA is the lattice host.", authority_level: 6, source: "manual", source_task_id: null },
      ],
      patches: [],
      scratchpad: [
        { id: "s1", layer: "scratchpad", title: "Pin: alpha", content: "Always greet by name.", authority_level: 5, source: "manual_pin", source_task_id: "task-1" },
      ],
    },
    conversations: [
      {
        id: "conv-1",
        title: "Onboarding chat",
        topic_keywords: ["onboarding", "intro"],
        tasks: [
          {
            id: "task-1",
            input_text: "What is BOS-OMEGA?",
            task_type: "general",
            tri_state: "GO",
            final_status: "COMPLETED",
            final_output: "BOS-OMEGA is your continuity host.",
            mode: "live",
            created_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    ],
  };
}

test("computeFidelityHash ignores fidelity_hash field if present", () => {
  const p = samplePayload();
  const h1 = computeFidelityHash(p);
  // Adding any value (or even the correct hash) under fidelity_hash
  // must not change the result — that's the whole point of stripping
  // it before canonicalization.
  const h2 = computeFidelityHash({ ...p, fidelity_hash: "x".repeat(64) });
  const h3 = computeFidelityHash({ ...p, fidelity_hash: h1 });
  assert.equal(h1, h2);
  assert.equal(h1, h3);
});

test("computeFidelityHash is order-invariant on input field order", () => {
  const a = samplePayload();
  // Re-construct with shuffled top-level keys; canonicalJSON sorts them
  // back to a stable order, so the hash must match.
  const b = {
    conversations: a.conversations,
    memory_layers: a.memory_layers,
    source_session_id: a.source_session_id,
    exported_at: a.exported_at,
    format_version: a.format_version,
  };
  assert.equal(computeFidelityHash(a), computeFidelityHash(b));
});

// ---------------------------------------------------------------- round-trip

test("buildLatticeBlob → parseLatticeBlob round-trip verifies", () => {
  const built = buildLatticeBlob(samplePayload());
  // Sanity: the blob is what the user sees — header on top, fence on
  // bottom, JSON envelope inside the fence.
  assert.match(built.blob, /^# BOS-OMEGA Memory Lattice/);
  assert.ok(
    built.blob.includes("```" + LATTICE_FENCE_LABEL),
    "blob must contain the labelled fence",
  );
  assert.ok(built.blob.includes(LATTICE_HEADER_PREAMBLE.split("\n")[0]),
    "blob must include the canonical header preamble (first line)",
  );

  const parsed = parseLatticeBlob(built.blob);
  assert.equal(parsed.hash_ok, true, "round-trip hash should verify");
  assert.equal(parsed.recomputed_hash, built.hash);
  // Payload identity (canonical equality): every field round-trips.
  assert.equal(canonicalJSON(parsed.payload), canonicalJSON({
    ...samplePayload(),
    fidelity_hash: built.hash,
  }));
});

test("parseLatticeBlob hash_ok=false when JSON envelope is tampered", () => {
  const built = buildLatticeBlob(samplePayload());
  // Mutate a single character INSIDE the JSON envelope (a memory item
  // title). Recompute would yield a different hash → verification
  // must report hash_ok=false but still return a parsed payload so
  // the route can surface a precise error to the user.
  const tampered = built.blob.replace('"Tone"', '"Tone!"');
  assert.notEqual(tampered, built.blob, "tampering must actually mutate the blob");
  const parsed = parseLatticeBlob(tampered);
  assert.equal(parsed.hash_ok, false);
  assert.notEqual(parsed.recomputed_hash, parsed.payload.fidelity_hash);
});

test("parseLatticeBlob throws when fenced block is missing", () => {
  // No fence → the export is unrecognisable; this is a structural
  // error (vs. a hash mismatch) and the route returns 400.
  assert.throws(
    () => parseLatticeBlob("not a lattice blob at all\n"),
    /No MEMORY_LATTICE_V1 fenced block/,
  );
});

test("parseLatticeBlob throws on unsupported format_version", () => {
  // Versioned wire format: an importer must refuse a future v2.0 blob
  // it doesn't understand rather than silently treating it as v1.0.
  const built = buildLatticeBlob(samplePayload());
  const wrongVersion = built.blob.replace('"format_version": "1.0"', '"format_version": "2.0"');
  assert.throws(
    () => parseLatticeBlob(wrongVersion),
    /Unsupported lattice format_version/,
  );
});

test("parseLatticeBlob throws when fidelity_hash field is missing or wrong shape", () => {
  const built = buildLatticeBlob(samplePayload());
  const missing = built.blob.replace(/"fidelity_hash": "[a-f0-9]{64}"/, '"fidelity_hash": ""');
  assert.throws(() => parseLatticeBlob(missing), /missing valid fidelity_hash/);
});

test("buildLatticeBlob byte_size equals UTF-8 byte length of blob", () => {
  // Used by the API and Settings card — must reflect the actual
  // download size. Buffer.byteLength is the canonical UTF-8 length.
  const built = buildLatticeBlob(samplePayload());
  assert.equal(built.byte_size, Buffer.byteLength(built.blob, "utf8"));
});

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
