#!/usr/bin/env node
/**
 * Task #83 — image generation unit tests.
 *
 * Pure-function tests that don't need the API server / DB:
 *   1. detectImageIntent: positive cases match, negatives don't,
 *      size hints resolve correctly, edit/describe negatives are
 *      excluded, "regenerate" is NOT a creation verb (\b boundary).
 *   2. generateMockPng: produces a valid PNG byte stream, deterministic
 *      for identical prompts, differs across prompts.
 *
 * Both modules are pure (no DB, no network) and import cleanly under
 * Node's --experimental-strip-types loader the same way lattice_unit.mjs
 * imports the lattice format helpers.
 *
 * Run from artifacts/api-server:
 *   $ node --experimental-strip-types tests/image_generation_unit.mjs
 * Exits 0 on pass, 1 on any failure.
 */
import assert from "node:assert/strict";
import { detectImageIntent } from "../src/bos/imageIntent.ts";
import { generateMockPng, MOCK_PNG_DIMENSIONS } from "../src/bos/imageMockPng.ts";
import { validateImageBytes as validate } from "../src/bos/imageBytesValidator.ts";

let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (err) { console.log(`  FAIL ${name}\n       ${err.stack || err.message}`); fail++; }
}

console.log("image_generation_unit: detector + mock PNG contract");

// === 1. Positive intent cases ===
const POSITIVES = [
  "generate an image of a red sneaker",
  "create a picture of a sunset",
  "draw a logo for my company",
  "render a beautiful landscape painting",
  "make me an illustration of a cat",
  "produce a photo of mountains",
  "design an icon for the settings page",
  "paint a portrait of a dog",
  "compose an artwork featuring stars",
  "Imagine a wide banner for the homepage",
  "generate a picture",
  "draw an icon",
];
for (const p of POSITIVES) {
  test(`positive: "${p}"`, () => {
    const r = detectImageIntent(p);
    assert.equal(r.is_image_generation, true, "should match");
    assert.ok(r.matched_phrase && r.matched_phrase.length > 0, "matched_phrase recorded");
    assert.ok(["1024x1024", "1536x1024", "1024x1536"].includes(r.size), "size resolved");
    assert.equal(r.prompt, p, "prompt preserved verbatim");
  });
}

// === 2. Negative intent cases ===
const NEGATIVES = [
  "describe this image",
  "what's in this picture",
  "summarize the photo I uploaded",
  "edit my image to add a hat",
  "remove the background from my photo",
  "regenerate the previous task",   // 'regenerate' must NOT match 'generate' (\b boundary)
  "find me a list of pictures",     // 'list' connector blocks the match
  "translate this text",
  "summarize this document",
  "create a list of items",          // 'list' is not in the noun list
  "generate code for a function",    // 'code' is not in the noun list
  "write a story about a dragon",    // 'write' is not in the verb list
  "I love this picture",             // no creation verb
  "show me the image",               // 'show' is not in the verb list
  "",
  "   ",
];
for (const p of NEGATIVES) {
  test(`negative: "${p}"`, () => {
    const r = detectImageIntent(p);
    assert.equal(r.is_image_generation, false, "should NOT match");
  });
}

// === 3. Size hints ===
test("size hint: landscape (wide)", () => {
  const r = detectImageIntent("render a wide landscape image of mountains");
  assert.equal(r.is_image_generation, true);
  assert.equal(r.size, "1536x1024");
});
test("size hint: portrait (tall)", () => {
  const r = detectImageIntent("draw a tall portrait illustration");
  assert.equal(r.is_image_generation, true);
  assert.equal(r.size, "1024x1536");
});
test("size hint: square default", () => {
  const r = detectImageIntent("generate an image of a sneaker");
  assert.equal(r.is_image_generation, true);
  assert.equal(r.size, "1024x1024");
});
test("size hint: explicit 16:9 wins", () => {
  const r = detectImageIntent("render a 16:9 banner image");
  assert.equal(r.is_image_generation, true);
  assert.equal(r.size, "1536x1024");
});
test("size hint: explicit 9:16 wins", () => {
  const r = detectImageIntent("create a 9:16 picture");
  assert.equal(r.is_image_generation, true);
  assert.equal(r.size, "1024x1536");
});

// === 4. Mock PNG contract ===
test("mock PNG: dimensions sane", () => {
  assert.equal(MOCK_PNG_DIMENSIONS.width, 8);
  assert.equal(MOCK_PNG_DIMENSIONS.height, 8);
});

test("mock PNG: valid PNG signature", () => {
  const buf = generateMockPng("hello");
  assert.deepEqual(
    Array.from(buf.slice(0, 8)),
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    "first 8 bytes are the PNG magic signature",
  );
});

test("mock PNG: contains IHDR/IDAT/IEND chunks", () => {
  const buf = generateMockPng("hello");
  const s = buf.toString("binary");
  assert.ok(s.includes("IHDR"), "IHDR present");
  assert.ok(s.includes("IDAT"), "IDAT present");
  assert.ok(s.includes("IEND"), "IEND present");
});

test("mock PNG: IHDR declares 8x8 RGBA", () => {
  const buf = generateMockPng("hello");
  // Layout: 8-byte sig + 4-byte length + 4-byte "IHDR" + payload (13 bytes)
  // payload[0..3] = width, payload[4..7] = height,
  // payload[8] = bit depth (8), payload[9] = color type (6 for RGBA)
  const ihdrPayloadStart = 8 + 4 + 4;
  const width = buf.readUInt32BE(ihdrPayloadStart);
  const height = buf.readUInt32BE(ihdrPayloadStart + 4);
  const bitDepth = buf[ihdrPayloadStart + 8];
  const colorType = buf[ihdrPayloadStart + 9];
  assert.equal(width, 8, "width = 8");
  assert.equal(height, 8, "height = 8");
  assert.equal(bitDepth, 8, "bit depth = 8");
  assert.equal(colorType, 6, "color type = 6 (RGBA)");
});

test("mock PNG: deterministic for same prompt", () => {
  const a = generateMockPng("hello world");
  const b = generateMockPng("hello world");
  assert.deepEqual(a, b, "same prompt → identical bytes");
});

test("mock PNG: different prompts produce different bytes", () => {
  const a = generateMockPng("a red sneaker");
  const b = generateMockPng("a blue sneaker");
  assert.notDeepEqual(a, b, "different prompts → different bytes");
});

test("mock PNG: empty prompt does not throw", () => {
  const buf = generateMockPng("");
  assert.ok(buf.length > 0, "still produces a PNG");
});

test("mock PNG: reasonable byte size (small but real)", () => {
  const buf = generateMockPng("hello");
  assert.ok(buf.length > 50, `PNG should have real content (got ${buf.length} bytes)`);
  assert.ok(buf.length < 1024, `PNG should be small for 8x8 (got ${buf.length} bytes)`);
});

// === 5. Provider response validation (architect HIGH finding) ===
const realPng = generateMockPng("validation-fixture").toString("base64");

test("validate: real PNG passes with sniffed mime", () => {
  const r = validate(realPng, "image/png");
  assert.equal(r.ok, true);
  assert.equal(r.mime, "image/png");
  assert.ok(r.bytes && r.bytes.length > 0);
});

test("validate: empty base64 rejected", () => {
  const r = validate("", "image/png");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "empty_base64");
});

test("validate: whitespace-only base64 rejected", () => {
  const r = validate("    \n\t\r ", "image/png");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "empty_base64");
});

test("validate: too-small payload rejected", () => {
  const tiny = Buffer.from("ab").toString("base64"); // 2 bytes
  const r = validate(tiny, "image/png");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "decoded_bytes_too_small");
});

test("validate: oversized payload rejected", () => {
  // Forge 30 MB of fake PNG bytes (real PNG signature so format check
  // would pass — it's the size cap we're proving here).
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const huge = Buffer.concat([sig, Buffer.alloc(30 * 1024 * 1024)]).toString("base64");
  const r = validate(huge, "image/png");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "decoded_bytes_too_large");
});

test("validate: non-image payload rejected (JSON masquerading as image/png)", () => {
  const json = Buffer.from(JSON.stringify({ error: "rate_limited", details: "x".repeat(40) })).toString("base64");
  const r = validate(json, "image/png");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unrecognized_image_format");
});

test("validate: non-image mime rejected even with valid magic bytes", () => {
  const r = validate(realPng, "application/json");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "non_image_mime");
});

test("validate: sniffed mime overrides claimed mime when bytes are PNG but claimed JPEG", () => {
  const r = validate(realPng, "image/jpeg");
  assert.equal(r.ok, true, "should still pass — bytes are a valid PNG");
  assert.equal(r.mime, "image/png", "canonical mime tracks the actual bytes");
});

test("validate: JPEG magic bytes recognized", () => {
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(40, 0x00),
  ]).toString("base64");
  const r = validate(jpeg, "image/jpeg");
  assert.equal(r.ok, true);
  assert.equal(r.mime, "image/jpeg");
});

test("validate: GIF magic bytes recognized", () => {
  const gif = Buffer.concat([
    Buffer.from("GIF89a", "ascii"),
    Buffer.alloc(40, 0x00),
  ]).toString("base64");
  const r = validate(gif, "image/gif");
  assert.equal(r.ok, true);
  assert.equal(r.mime, "image/gif");
});

test("validate: WebP magic bytes recognized", () => {
  const webp = Buffer.concat([
    Buffer.from("RIFF", "ascii"),
    Buffer.alloc(4, 0x00),
    Buffer.from("WEBP", "ascii"),
    Buffer.alloc(40, 0x00),
  ]).toString("base64");
  const r = validate(webp, "image/webp");
  assert.equal(r.ok, true);
  assert.equal(r.mime, "image/webp");
});

test("validate: handles base64url variant (- and _) and whitespace", () => {
  // Encode with standard base64 then swap chars to base64url + add LF.
  const standard = realPng;
  const urlSafe = standard.replace(/\+/g, "-").replace(/\//g, "_");
  const wrapped = urlSafe.match(/.{1,64}/g)?.join("\n") ?? urlSafe;
  const r = validate(wrapped, "image/png");
  assert.equal(r.ok, true, "must accept base64url + line wrapping");
});

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
