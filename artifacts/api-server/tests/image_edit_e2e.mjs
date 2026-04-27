#!/usr/bin/env node
/**
 * Task #84 — image-edit provider bridge end-to-end spec.
 *
 * Modeled on `image_generation_e2e.mjs`. Asserts the image-edit branch
 * of the pipeline works in mock mode (the safe default) without any
 * live API keys, and that the audit chain + persistence + frontend
 * contract hold end to end:
 *
 *   1. Login as super_admin (bootstrap owner).
 *   2. Submit a vanilla image-generation prompt to seed a parent
 *      attachment in a fresh conversation. Capture conversation_id
 *      and parent attachment id.
 *   3. Submit an edit phrasing ("make it blue") in the SAME
 *      conversation. Assert: task_type === "image_edit", GO/DONE,
 *      bos_output.generated_attachments has 1 entry whose
 *      parent_attachment_id, parent_storage_path, parent_mime point
 *      back at the seed.
 *   4. GET /api/uploads/{edited_id}/raw — assert PNG magic bytes.
 *   5. GET /api/audit?task_id=... — assert IMAGE_EDIT_REQUESTED and
 *      IMAGE_EDIT_COMPLETED were recorded with the right metadata
 *      shape.
 *   6. Negative: an edit phrasing in a brand-new conversation (no
 *      prior generation) must NOT route to image_edit — it falls
 *      through to the standard text/generation paths.
 *
 * Prerequisites:
 *   - The API server is running (default port 8080, override with API_BASE).
 *   - ADMIN_EMAIL + ADMIN_PASSWORD env vars name a super_admin account.
 *
 * Exits 0 on pass, 1 on any failure.
 */
import assert from "node:assert/strict";

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

async function request(jar, method, path, body) {
  const headers = { Accept: "application/json" };
  if (jar.cookie) headers.Cookie = jar.cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const set_cookie = r.headers.get("set-cookie");
  if (set_cookie) jar.cookie = set_cookie.split(";")[0];
  let data = null;
  const ct = r.headers.get("content-type") || "";
  if (ct.includes("json")) data = await r.json().catch(() => null);
  else if (ct.startsWith("image/")) data = Buffer.from(await r.arrayBuffer());
  else if (r.status !== 204) data = await r.text().catch(() => null);
  return { status: r.status, data, contentType: ct };
}

console.log(`Image edit E2E vs ${API_BASE}`);

const jar = {};
const login = await request(jar, "POST", "/api/auth/login", {
  email: ADMIN_EMAIL,
  password: ADMIN_PASSWORD,
});
if (login.status !== 200) {
  console.error(`Login failed: ${login.status} ${JSON.stringify(login.data).slice(0, 200)}`);
  process.exit(2);
}

// Helper: submit a task and lift bos_output off the row.
async function submitTask(input, opts = {}) {
  const body = { input };
  if (opts.conversation_id) body.conversation_id = opts.conversation_id;
  if (opts.force_new_conversation) body.force_new_conversation = true;
  const r = await request(jar, "POST", "/api/tasks", body);
  if (r.status !== 200) throw new Error(`POST /api/tasks → ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`);
  const row = r.data;
  let bos_output = null;
  if (row && typeof row.final_output === "string") {
    try { bos_output = JSON.parse(row.final_output); } catch { /* leave null */ }
  }
  return { ...row, task_id: row.id, bos_output };
}

// Make sure OpenAI provider is enabled — required for the bridge to plan
// any image attempt at all (mirrors image_generation_e2e setup).
await test("setup: ensure OpenAI provider is enabled", async () => {
  const list = await request(jar, "GET", "/api/providers");
  assert.equal(list.status, 200);
  const openai = (list.data || []).find((p) => String(p.name).toLowerCase() === "openai");
  assert.ok(openai, "OpenAI provider seed row exists");
  if (!openai.enabled) {
    const upd = await request(jar, "PATCH", `/api/providers/${openai.id}`, { enabled: true });
    assert.equal(upd.status, 200);
  }
});

// ----------------------------------------------------------------- 1. Seed parent
let seedTask;
let seedAttachmentId;
let conversationId;
await test("seed: vanilla image-generation creates a parent attachment", async () => {
  seedTask = await submitTask("generate an image of a red sneaker", { force_new_conversation: true });
  assert.equal(seedTask.task_type, "image_generation", "task_type === image_generation");
  assert.equal(seedTask.tri_state, "GO", "GO since mock mode succeeds");
  const refs = seedTask.bos_output?.generated_attachments;
  assert.ok(Array.isArray(refs) && refs.length === 1, `expected 1 attachment, got ${refs?.length}`);
  seedAttachmentId = refs[0].id;
  conversationId = seedTask.conversation_id;
  assert.ok(conversationId, "seed task has a conversation_id");
  assert.ok(seedAttachmentId, "seed task has an attachment id");
});

// ----------------------------------------------------------------- 2. Edit branch
let editTask;
let editAttachmentId;
await test("submits 'make it blue' in same conversation → routes to image_edit", async () => {
  editTask = await submitTask("make it blue", { conversation_id: conversationId });
  assert.equal(editTask.task_type, "image_edit", `task_type should be image_edit; got ${editTask.task_type}`);
  assert.equal(editTask.tri_state, "GO", "GO since mock mode succeeds");
  assert.equal(editTask.final_status, "DONE", "DONE on success");
  const refs = editTask.bos_output?.generated_attachments;
  assert.ok(Array.isArray(refs) && refs.length === 1, `expected 1 edited attachment, got ${refs?.length}`);
  const ref = refs[0];
  editAttachmentId = ref.id;
  assert.equal(ref.parent_attachment_id, seedAttachmentId, "parent_attachment_id points back at seed");
  assert.equal(
    ref.parent_storage_path,
    `/api/uploads/${seedAttachmentId}/raw`,
    "parent_storage_path mirrors seed's uploads route",
  );
  assert.equal(ref.parent_mime, "image/png", "parent_mime captured");
  assert.equal(ref.mime, "image/png", "edited mime is PNG");
  assert.ok(ref.id !== seedAttachmentId, "edited attachment is a NEW row, not the parent");
});

// ----------------------------------------------------------------- 3. Edited bytes are a real PNG
await test("GET /api/uploads/{edited_id}/raw returns valid PNG bytes", async () => {
  const r = await request(jar, "GET", `/api/uploads/${editAttachmentId}/raw`);
  assert.equal(r.status, 200, `expected 200, got ${r.status}`);
  assert.ok(r.contentType.startsWith("image/"), `content-type should be image/*, got ${r.contentType}`);
  assert.ok(Buffer.isBuffer(r.data), "raw response should be a Buffer");
  assert.deepEqual(
    Array.from(r.data.slice(0, 8)),
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    "valid PNG signature on edited bytes",
  );
});

// ----------------------------------------------------------------- 4. Audit trail
await test("audit chain records IMAGE_EDIT_REQUESTED + IMAGE_EDIT_COMPLETED", async () => {
  const r = await request(jar, "GET", `/api/audit?task_id=${encodeURIComponent(editTask.task_id)}&limit=200`);
  assert.equal(r.status, 200);
  const events = Array.isArray(r.data) ? r.data : (r.data?.entries ?? []);
  const requested = events.find((e) => e.event_type === "IMAGE_EDIT_REQUESTED");
  const completed = events.find((e) => e.event_type === "IMAGE_EDIT_COMPLETED");
  assert.ok(requested, "IMAGE_EDIT_REQUESTED event recorded");
  assert.ok(completed, "IMAGE_EDIT_COMPLETED event recorded");
  // Requested contract: prompt + parent attachment + provider plan.
  assert.equal(requested.metadata?.prompt, "make it blue", "prompt recorded");
  assert.equal(requested.metadata?.parent_attachment_id, seedAttachmentId, "parent attachment recorded");
  // Completed contract: edited attachment + parent linkage + provider/model + dims.
  assert.equal(completed.metadata?.attachment_id, editAttachmentId, "edited attachment_id matches");
  assert.equal(completed.metadata?.parent_attachment_id, seedAttachmentId, "parent_attachment_id matches");
  assert.ok(completed.metadata?.provider, "provider recorded on completion");
  assert.ok(completed.metadata?.model, "model recorded on completion");
});

// ----------------------------------------------------------------- 5. Negative: no parent → no edit
await test("'make it blue' with no prior generation does NOT route to image_edit", async () => {
  // Force a brand-new conversation. With no prior generated_attachment
  // for this user in this conversation, the edit branch must fall
  // through to the standard text/generation paths.
  const orphan = await submitTask("make it blue", { force_new_conversation: true });
  assert.notEqual(orphan.task_type, "image_edit", `should not route to image_edit; got ${orphan.task_type}`);
  const refs = orphan.bos_output?.generated_attachments;
  // Either no attachments, or — if a downstream classifier interpreted
  // it as a generation — a generation, but never an edit chain.
  if (Array.isArray(refs) && refs.length > 0) {
    assert.ok(!refs[0].parent_attachment_id, "no parent_attachment_id when there's no prior image");
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
