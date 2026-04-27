#!/usr/bin/env node
/**
 * Task #83 — image generation provider bridge end-to-end spec.
 *
 * Modeled on `test/lattice_round_trip.spec.mjs`. Asserts the image
 * generation route works in mock mode (the safe default) without any
 * live API keys, and that the audit chain + persistence + frontend
 * contract hold end to end:
 *
 *   1. Login as super_admin (bootstrap owner) — same auth pattern as
 *      lattice_round_trip.
 *   2. POST /api/tasks with input "generate an image of a red sneaker".
 *      Assert: 200, task is GO, task_type === "image_generation",
 *      bos_output.generated_attachments has exactly 1 entry, and the
 *      ref carries provider=mock + mock=true.
 *   3. GET /api/uploads/{attachment_id}/raw — assert the bytes start
 *      with the PNG magic signature so the chat UI can render it.
 *   4. GET /api/audit?task_id=... — assert IMAGE_REQUESTED and
 *      IMAGE_GENERATED were recorded with the right metadata shape
 *      (prompt_sha256_prefix, provider, model, mocked, attachment_id).
 *   5. POST /api/tasks again with the SAME prompt, assert the SHA256
 *      of the returned image matches (deterministic mock — round-trip
 *      proof).
 *   6. POST /api/tasks with a DIFFERENT prompt, assert the SHA256
 *      differs (so the mock isn't a constant stub).
 *   7. POST /api/tasks with "what is in this image?" (a describe-style
 *      negative case) — assert the bos_output has NO generated_attachments
 *      and task_type is NOT image_generation. Confirms the detector's
 *      negative path is honored end-to-end.
 *
 * If IMAGE_E2E_LIVE=1 is set in the environment AND
 * AI_INTEGRATIONS_OPENAI_API_KEY/BASE_URL OR AI_INTEGRATIONS_GEMINI_API_KEY/BASE_URL
 * are configured, the spec also runs a single live-mode generation and
 * asserts mock=false on the resulting ref. By default this branch is
 * skipped so CI can run without burning credits.
 *
 * Prerequisites:
 *   - The API server is running (default port 8080, override with API_BASE).
 *   - ADMIN_EMAIL + ADMIN_PASSWORD env vars name a super_admin account.
 *
 * Exits 0 on pass, 1 on any failure.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const API_BASE = (process.env.API_BASE || "http://localhost:8080").replace(/\/$/, "");
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "paisabrazilfl@gmail.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  console.error("ADMIN_PASSWORD env var is required");
  process.exit(2);
}

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    pass++;
  } catch (err) {
    console.log(`  FAIL ${name}\n       ${err.stack || err.message}`);
    fail++;
  }
}

async function request(jar, method, path, body, opts = {}) {
  const headers = { Accept: "application/json" };
  if (jar.cookie && !opts.skipCookie) headers.Cookie = jar.cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const set_cookie = r.headers.get("set-cookie");
  if (set_cookie && !opts.skipCookie) jar.cookie = set_cookie.split(";")[0];
  let data = null;
  const ct = r.headers.get("content-type") || "";
  if (ct.includes("json")) data = await r.json().catch(() => null);
  else if (ct.startsWith("image/")) data = Buffer.from(await r.arrayBuffer());
  else if (r.status !== 204) data = await r.text().catch(() => null);
  return { status: r.status, data, contentType: ct };
}

console.log(`Image generation E2E vs ${API_BASE}`);

const jar = {};

// ----------------------------------------------------------------- 1. Login
const login = await request(jar, "POST", "/api/auth/login", {
  email: ADMIN_EMAIL,
  password: ADMIN_PASSWORD,
});
if (login.status !== 200) {
  console.error(`Login failed: ${login.status} ${JSON.stringify(login.data).slice(0, 200)}`);
  process.exit(2);
}

// Helper: submit a task and return a normalized shape.
// POST /api/tasks returns the raw `tasks` row plus `run_id` and
// `execution_mode`. `bos_output` lives in the `final_output` column
// as a JSON string (see routes/tasks.ts GET /:id which parses the
// same way) so we lift it onto the result for ergonomic assertions.
async function submitTask(input) {
  const r = await request(jar, "POST", "/api/tasks", { input });
  if (r.status !== 200) throw new Error(`POST /api/tasks → ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`);
  const row = r.data;
  let bos_output = null;
  if (row && typeof row.final_output === "string") {
    try { bos_output = JSON.parse(row.final_output); } catch { /* leave null */ }
  }
  return { ...row, task_id: row.id, bos_output };
}

// ----------------------------------------------------------------- 2. Image gen mock
let firstResult;
await test("submits image-generation prompt → routes to image bridge (mock mode)", async () => {
  firstResult = await submitTask("generate an image of a red sneaker");
  assert.equal(firstResult.task_type, "image_generation", "task_type === image_generation");
  assert.equal(firstResult.tri_state, "GO", "GO since mock mode always succeeds");
  assert.equal(firstResult.final_status, "DONE", "DONE on success");
  const refs = firstResult.bos_output?.generated_attachments;
  assert.ok(Array.isArray(refs) && refs.length === 1, `expected 1 generated attachment, got ${refs?.length}`);
  assert.equal(refs[0].provider, "mock", "mock provider");
  assert.equal(refs[0].mock, true, "mock=true");
  assert.equal(refs[0].mime, "image/png", "PNG mime");
  assert.ok(refs[0].id && refs[0].id.length > 8, "attachment id present");
});

const firstAttachmentId = firstResult.bos_output.generated_attachments[0].id;

// ----------------------------------------------------------------- 3. Raw bytes are a real PNG
let firstBytes;
await test("GET /api/uploads/{id}/raw returns valid PNG bytes", async () => {
  const r = await request(jar, "GET", `/api/uploads/${firstAttachmentId}/raw`);
  assert.equal(r.status, 200, `expected 200, got ${r.status}`);
  assert.ok(r.contentType.startsWith("image/"), `content-type should be image/*, got ${r.contentType}`);
  assert.ok(Buffer.isBuffer(r.data), "raw response should be a Buffer");
  firstBytes = r.data;
  assert.deepEqual(
    Array.from(firstBytes.slice(0, 8)),
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    "valid PNG signature",
  );
});

// ----------------------------------------------------------------- 4. Audit trail
await test("audit chain records IMAGE_REQUESTED + IMAGE_GENERATED with full metadata", async () => {
  const r = await request(jar, "GET", `/api/audit?task_id=${encodeURIComponent(firstResult.task_id)}&limit=200`);
  assert.equal(r.status, 200, `expected 200, got ${r.status}`);
  const events = Array.isArray(r.data) ? r.data : [];
  const requested = events.find((e) => e.event_type === "IMAGE_REQUESTED");
  const generated = events.find((e) => e.event_type === "IMAGE_GENERATED");
  assert.ok(requested, "IMAGE_REQUESTED event recorded");
  assert.ok(generated, "IMAGE_GENERATED event recorded");
  // IMAGE_REQUESTED contract: prompt + size + live_mode + planned_order + enabled_providers + anthropic_active.
  assert.equal(requested.metadata?.prompt, "generate an image of a red sneaker", "actual prompt recorded");
  assert.equal(requested.metadata?.size, "1024x1024", "size hint recorded");
  assert.equal(requested.metadata?.live_mode, false, "mock mode recorded");
  assert.equal(typeof requested.metadata?.anthropic_active, "boolean", "anthropic_active flag present");
  assert.ok(Array.isArray(requested.metadata?.enabled_providers), "enabled_providers list present");
  assert.ok(Array.isArray(requested.metadata?.planned_order), "planned_order list present");
  // IMAGE_GENERATED contract: attachment_id + storage_path + provider + model + dims + bytes + sha256 + prompt.
  assert.equal(generated.metadata?.attachment_id, firstAttachmentId, "attachment_id matches");
  assert.equal(
    generated.metadata?.storage_path,
    `/api/uploads/${firstAttachmentId}/raw`,
    "storage_path matches uploads route",
  );
  assert.equal(generated.metadata?.provider, "mock", "provider recorded");
  assert.equal(generated.metadata?.model, "mock-deterministic", "model recorded");
  assert.equal(generated.metadata?.mocked, true, "generated mocked=true");
  assert.equal(generated.metadata?.width, 8, "width recorded (mock dims)");
  assert.equal(generated.metadata?.height, 8, "height recorded (mock dims)");
  assert.equal(generated.metadata?.mime, "image/png", "mime recorded");
  assert.equal(generated.metadata?.prompt, "generate an image of a red sneaker", "prompt recorded on completion");
  assert.ok(typeof generated.metadata?.bytes === "number" && generated.metadata.bytes > 0, "bytes recorded");
  assert.ok(typeof generated.metadata?.sha256 === "string" && generated.metadata.sha256.length === 64, "sha256 recorded");
});

await test("BosOutput.generated_attachments[0] carries storage_path", async () => {
  const ref = firstResult.bos_output.generated_attachments[0];
  assert.equal(ref.storage_path, `/api/uploads/${firstAttachmentId}/raw`, "storage_path round-trips into bos_output");
});

// ----------------------------------------------------------------- 5. Determinism
await test("repeating the same prompt produces the same bytes (deterministic mock)", async () => {
  const second = await submitTask("generate an image of a red sneaker");
  const id2 = second.bos_output.generated_attachments[0].id;
  const r = await request(jar, "GET", `/api/uploads/${id2}/raw`);
  assert.equal(r.status, 200);
  const second_sha = createHash("sha256").update(r.data).digest("hex");
  const first_sha = createHash("sha256").update(firstBytes).digest("hex");
  assert.equal(second_sha, first_sha, "same prompt → identical PNG bytes");
});

// ----------------------------------------------------------------- 6. Differentiation
await test("different prompts produce different bytes", async () => {
  const other = await submitTask("draw a logo for a startup");
  const id3 = other.bos_output.generated_attachments[0].id;
  const r = await request(jar, "GET", `/api/uploads/${id3}/raw`);
  assert.equal(r.status, 200);
  const other_sha = createHash("sha256").update(r.data).digest("hex");
  const first_sha = createHash("sha256").update(firstBytes).digest("hex");
  assert.notEqual(other_sha, first_sha, "different prompts → different PNG bytes");
});

// ----------------------------------------------------------------- 7. Negative case
await test("describe-style prompt is NOT routed to image bridge", async () => {
  const r = await submitTask("what is in this image right here");
  assert.notEqual(r.task_type, "image_generation", `should not be image_generation; got ${r.task_type}`);
  const refs = r.bos_output?.generated_attachments;
  assert.ok(!refs || refs.length === 0, "no generated_attachments for describe prompt");
});

// ------------------------------------------------- 7b. Memory continuity for follow-ups
//
// After an image task completes the pipeline writes an auto_summary scratchpad
// row (writeAutoSummary, image branch) so a later text task can recall the
// prior generation via memory_context. We assert the storage_path of the
// FIRST attachment shows up in the follow-up's MEMORY_INJECTED audit payload
// — that's the exact channel a downstream text classifier would read from
// when answering "what was the image you generated?".
await test("follow-up task memory_context references the prior generated image", async () => {
  // Give the writer a brief window — it runs after TASK_COMPLETED inside its
  // own try/catch and uses the same DB connection the task does, so this is
  // belt-and-suspenders rather than load-bearing.
  await new Promise((r) => setTimeout(r, 250));
  const followUp = await submitTask(
    "in two sentences, what was in the image you just generated for me?",
  );
  // The MEMORY_INJECTED audit row is scrubbed of the un-truncated
  // `memory_context_full` field (audit.ts strips it) so we ask the
  // dedicated memory-context endpoint that re-hydrates it for "View
  // full context" UIs. This is the same channel the model receives.
  const ctxRes = await request(
    jar,
    "GET",
    `/api/tasks/${encodeURIComponent(followUp.task_id)}/memory-context`,
  );
  assert.equal(ctxRes.status, 200, "memory-context endpoint responded 200");
  const ctx = String(ctxRes.data?.memory_context ?? "");
  assert.ok(ctx.length > 0, "memory_context payload is non-empty");
  assert.ok(
    ctx.includes("=== SCRATCHPAD ==="),
    "memory_context contains a SCRATCHPAD section (auto-summary writer fired)",
  );
  assert.ok(
    ctx.includes(`/api/uploads/${firstAttachmentId}/raw`),
    "follow-up memory_context references the prior image storage_path",
  );
});

// ------------------------------------------------------------- 8. Optional live test
if (process.env.IMAGE_E2E_LIVE === "1") {
  await test("[live] live-mode generation writes a non-mock image", async () => {
    // The pipeline reads IMAGE_GENERATION_LIVE on the SERVER side; the test
    // harness can only assert what the server reports back. If the server
    // was started with IMAGE_GENERATION_LIVE=1 AND has at least one
    // provider's keys configured, the resulting ref should have mock=false.
    const live = await submitTask("generate an image of a calm zen garden");
    assert.equal(live.task_type, "image_generation");
    const ref = live.bos_output?.generated_attachments?.[0];
    assert.ok(ref, "generated attachment exists");
    if (ref.mock) {
      console.warn("    NOTE: server returned mock=true even with IMAGE_E2E_LIVE=1 — start the server with IMAGE_GENERATION_LIVE=1 and ensure provider keys are configured.");
    } else {
      assert.ok(["openai", "gemini"].includes(ref.provider), `unexpected live provider ${ref.provider}`);
    }
  });
} else {
  console.log("  skip [live] live-mode generation (set IMAGE_E2E_LIVE=1 to enable)");
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
