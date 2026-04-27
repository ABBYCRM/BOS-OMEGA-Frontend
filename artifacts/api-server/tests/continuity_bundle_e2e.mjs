#!/usr/bin/env node
/**
 * Task #64 — end-to-end integration test for the cross-AI continuity
 * bundle endpoints, run against a live BOS-OMEGA API server.
 *
 * Round-trip:
 *   1.  GET  /api/continuity-bundle (no auth)             → 401.
 *   2.  Login as the bootstrap admin.
 *   3.  Create one task (POST /api/tasks) with a stable input. We use
 *       single-model mode so the test does not depend on consensus or
 *       parallel orchestration timing.
 *   4.  Pin a scratchpad row scoped to that task so the bundle has at
 *       least one scratchpad item (POST /api/scratchpad/pin with
 *       source_task_id).
 *   5.  GET /api/continuity-bundle?task_id=<id>           → 200, blob
 *       carries the v1 fence + 64-char hash + non-zero stats.
 *   6.  GET /api/continuity-bundle?conversation_id=<id>   → 200, scope
 *       === "conversation", turn count >= 1.
 *   7.  POST /api/continuity-bundle/preview               → 200,
 *       hash_ok=true, counts mirror what we exported.
 *   8.  Tamper the blob (flip ONE byte inside the fenced JSON object)
 *       → POST /preview returns 400 BUNDLE_HASH_MISMATCH (or the
 *       parser fails earlier with a structured error). The endpoint
 *       must NOT silently accept a tampered hash.
 *   9.  POST /api/continuity-bundle/import (clean blob)   → 200,
 *       creates a NEW conversation with imported.turns >= 1, the new
 *       conversation appears in /api/conversations, and a
 *       CONTINUITY_BUNDLE_IMPORTED audit row exists with verified=true.
 *  10.  GET /api/continuity-bundle?conversation_id=<NEW>  → 200, the
 *       fresh conversation re-exports cleanly (hash_ok round-trips).
 *  11.  POST /import with require_hash_ok=true on the tampered blob
 *       → 400 BUNDLE_HASH_MISMATCH (gate proven on the import path,
 *       not just preview).
 *  12.  POST /preview with a totally bogus payload → 400 with a
 *       structured BUNDLE_NO_FENCE / BUNDLE_NO_HASH code (proves we
 *       don't crash on garbage input).
 *
 * Run against an already-running server:
 *   $ API_BASE=http://localhost:8080 \
 *     ADMIN_EMAIL=paisabrazilfl@gmail.com \
 *     ADMIN_PASSWORD=<password> \
 *     node artifacts/api-server/tests/continuity_bundle_e2e.mjs
 *
 * Exits 0 on pass, non-zero on any failure.
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
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ok  ${name}`); pass++; })
    .catch((err) => { console.log(`  FAIL ${name}\n       ${err.message}`); fail++; });
}

let cookieHeader = "";

async function request(method, path, body, opts = {}) {
  const headers = { Accept: "application/json" };
  if (cookieHeader && !opts.skipCookie) headers.Cookie = cookieHeader;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const set_cookie = r.headers.get("set-cookie");
  if (set_cookie && !opts.skipCookie) cookieHeader = set_cookie.split(";")[0];
  let data = null;
  const ct = r.headers.get("content-type") || "";
  if (ct.includes("json")) data = await r.json().catch(() => null);
  else if (r.status !== 204) data = await r.text().catch(() => null);
  return { status: r.status, data };
}

async function login() {
  const r = await request("POST", "/api/auth/login", {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  assert.equal(r.status, 200, `login failed: ${r.status} ${JSON.stringify(r.data)}`);
}

async function logout() { cookieHeader = ""; }

async function findAuditEvent(event_type, predicate, limit = 200) {
  const r = await request("GET", `/api/audit?limit=${limit}`);
  assert.equal(r.status, 200, `audit list failed: ${r.status}`);
  const rows = Array.isArray(r.data) ? r.data : (r.data?.items ?? []);
  return rows.find((row) => row.event_type === event_type && (!predicate || predicate(row)));
}

console.log("continuity_bundle_e2e: live HTTP integration");

let cleanBlob = null;
let cleanHash = null;
let createdTaskId = null;
let createdConversationId = null;
let importedConversationId = null;

await test("GET /api/continuity-bundle without cookie → 401", async () => {
  await logout();
  const r = await request("GET", "/api/continuity-bundle?task_id=00000000-0000-0000-0000-000000000000",
    undefined, { skipCookie: true });
  assert.equal(r.status, 401, `expected 401, got ${r.status}`);
});

await test("login as admin user", async () => {
  await login();
});

await test("seed a real task to scope the bundle to", async () => {
  const r = await request("POST", "/api/tasks", {
    input: "Continuity bundle e2e seed: this is a deterministic prompt that the bundle must round-trip without hash drift.",
    mode: "single",
    parallel_models: 1,
    max_models: 1,
    agents_per_model: 1,
    force_new_conversation: true,
  });
  assert.equal(r.status, 200, `task create failed: ${r.status} ${JSON.stringify(r.data)}`);
  assert.equal(typeof r.data.id, "string", "task id missing in response");
  createdTaskId = r.data.id;
  // The task is auto-pinned to a conversation (Lattice clusterer); fetch
  // it to recover the conversation_id so we can test conversation-scoped
  // bundle export too.
  const tr = await request("GET", `/api/tasks/${createdTaskId}`);
  assert.equal(tr.status, 200, `task fetch failed: ${tr.status}`);
  createdConversationId = tr.data.task?.conversation_id ?? null;
  assert.ok(createdConversationId, "task should have been pinned to a conversation by the clusterer");
});

await test("pin a scratchpad row scoped to the task", async () => {
  const r = await request("POST", "/api/scratchpad/pin", {
    title: "e2e bundle pin",
    content: "This pinned note must appear in the exported continuity bundle for the task above.",
    source_task_id: createdTaskId,
  });
  // The pin route uses 201 Created on insert, 200 OK on idempotent
  // re-pin. Accept both — the round-trip only cares that the row
  // exists and is scoped to the seed task.
  assert.ok(r.status === 200 || r.status === 201,
    `pin failed: ${r.status} ${JSON.stringify(r.data)}`);
  assert.equal(r.data.layer, "scratchpad");
  assert.equal(r.data.source_task_id, createdTaskId);
});

await test("GET /api/continuity-bundle?task_id=… → 200 with v1 fence and hash", async () => {
  const r = await request("GET", `/api/continuity-bundle?task_id=${encodeURIComponent(createdTaskId)}`);
  assert.equal(r.status, 200, `export failed: ${r.status} ${JSON.stringify(r.data)}`);
  assert.equal(typeof r.data.blob, "string");
  assert.ok(r.data.blob.includes("```bos-omega.continuity-bundle.v1"),
    "blob must contain the v1 fence");
  assert.equal(typeof r.data.hash, "string");
  assert.equal(r.data.hash.length, 64);
  assert.match(r.data.hash, /^[a-f0-9]{64}$/);
  assert.equal(r.data.format_version, "1.0");
  assert.equal(r.data.scope, "task");
  assert.equal(r.data.task_id, createdTaskId);
  assert.equal(typeof r.data.byte_size, "number");
  assert.ok(r.data.byte_size > 0, "byte_size must be positive");
  assert.ok(r.data.stats.scratchpad_count >= 1,
    "scratchpad pin must surface in bundle stats");
  assert.ok(r.data.stats.turns_count >= 1, "task export must include >=1 turn");
  cleanBlob = r.data.blob;
  cleanHash = r.data.hash;
});

await test("GET /api/continuity-bundle?conversation_id=… → 200 with conv scope", async () => {
  const r = await request("GET",
    `/api/continuity-bundle?conversation_id=${encodeURIComponent(createdConversationId)}`);
  assert.equal(r.status, 200, `conv export failed: ${r.status}`);
  assert.equal(r.data.scope, "conversation");
  assert.equal(r.data.conversation_id, createdConversationId);
  assert.ok(r.data.stats.turns_count >= 1);
  assert.ok(r.data.blob.includes("```bos-omega.continuity-bundle.v1"));
});

await test("POST /preview on the clean blob → hash_ok=true", async () => {
  const r = await request("POST", "/api/continuity-bundle/preview", { bundle: cleanBlob });
  assert.equal(r.status, 200, `preview failed: ${r.status} ${JSON.stringify(r.data)}`);
  assert.equal(r.data.hash_ok, true);
  assert.equal(r.data.scope, "task");
  assert.equal(r.data.recomputed_hash, cleanHash);
  assert.equal(r.data.declared_hash, cleanHash);
  assert.equal(r.data.canon_match, true,
    "exporter is also the importer, so the canon hash must match the local canon hash exactly");
  assert.ok(r.data.counts.scratchpad >= 1);
  assert.ok(r.data.counts.turns >= 1);
});

// Helper: produce a tampered blob that still parses (so the test
// exercises the hash-recomputation gate, not the parser's structural
// rejection). We mutate the `exported_at` ISO timestamp inside the
// fenced JSON trailer — one character change, parser still accepts
// the field shape, but the canonicalised payload now hashes to a
// different value than the trailer's `fidelity_hash` field.
function tamperBlobYear(blob) {
  const tampered = blob.replace(/"exported_at":\s*"20/, `"exported_at": "19`);
  if (tampered === blob) {
    throw new Error("tamper helper did not mutate the blob — bundle shape may have changed");
  }
  return tampered;
}

await test("tampered blob → preview returns hash_ok=false", async () => {
  const tampered = tamperBlobYear(cleanBlob);
  const r = await request("POST", "/api/continuity-bundle/preview", { bundle: tampered });
  // Two valid paths:
  //   (a) the parser parses fine and returns 200 with hash_ok=false; or
  //   (b) the parser rejects the bundle outright with a 400 carrying a
  //       structured BUNDLE_* code. Either is acceptable evidence the
  //       gate works — silent acceptance with hash_ok=true is NOT.
  if (r.status === 200) {
    assert.equal(r.data.hash_ok, false,
      `tampered preview returned hash_ok=true: ${JSON.stringify(r.data).slice(0, 200)}`);
  } else {
    assert.equal(r.status, 400, `expected 200 or 400, got ${r.status}`);
    assert.match(String(r.data?.code || ""), /^BUNDLE_/);
  }
});

await test("POST /import on tampered blob with require_hash_ok=true → 400", async () => {
  const tampered = tamperBlobYear(cleanBlob);
  const r = await request("POST", "/api/continuity-bundle/import", {
    bundle: tampered,
    mode: "merge",
    require_hash_ok: true,
  });
  assert.equal(r.status, 400, `expected 400, got ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  assert.match(String(r.data?.code || ""), /^BUNDLE_/,
    "expected a structured BUNDLE_* code on import refusal");
});

await test("POST /preview on garbage input → 400 with structured code", async () => {
  const r = await request("POST", "/api/continuity-bundle/preview",
    { bundle: "this is just plain text with no fence at all\n" });
  assert.equal(r.status, 400, `expected 400, got ${r.status}`);
  assert.match(String(r.data?.code || ""), /^BUNDLE_/);
});

await test("POST /import on the clean blob → 200 with new conversation + verified=true", async () => {
  const r = await request("POST", "/api/continuity-bundle/import", {
    bundle: cleanBlob,
    mode: "merge",
    require_hash_ok: true,
  });
  assert.equal(r.status, 200, `import failed: ${r.status} ${JSON.stringify(r.data)}`);
  assert.equal(r.data.verified, true);
  assert.equal(typeof r.data.conversation_id, "string");
  assert.notEqual(r.data.conversation_id, createdConversationId,
    "import must create a NEW conversation, not reuse the source");
  assert.ok(r.data.imported.turns >= 1, "imported turns count must be > 0");
  assert.ok(Array.isArray(r.data.new_task_ids));
  assert.equal(r.data.new_task_ids.length, r.data.imported.turns,
    "new_task_ids must match imported turn count");
  importedConversationId = r.data.conversation_id;
});

await test("imported conversation appears in /api/conversations", async () => {
  const r = await request("GET", "/api/conversations?limit=50");
  assert.equal(r.status, 200);
  const list = Array.isArray(r.data) ? r.data : (r.data?.items ?? r.data?.conversations ?? []);
  const found = list.find((c) => c.id === importedConversationId);
  assert.ok(found, `imported conversation ${importedConversationId} missing from list`);
});

await test("CONTINUITY_BUNDLE_IMPORTED audit event recorded with verified=true", async () => {
  const evt = await findAuditEvent("CONTINUITY_BUNDLE_IMPORTED",
    (e) => e?.metadata?.conversation_id === importedConversationId);
  assert.ok(evt, "expected CONTINUITY_BUNDLE_IMPORTED audit event for imported conversation");
  assert.equal(evt.metadata.verified, true);
  assert.equal(evt.metadata.declared_hash, cleanHash);
  assert.equal(evt.metadata.recomputed_hash, cleanHash);
});

await test("re-export the imported conversation → bundle round-trips with hash_ok=true", async () => {
  const r = await request("GET",
    `/api/continuity-bundle?conversation_id=${encodeURIComponent(importedConversationId)}`);
  assert.equal(r.status, 200);
  assert.ok(r.data.stats.turns_count >= 1,
    "re-exported imported conversation must include the rehydrated turns");
  // Round-trip the re-export through preview to prove the freshly
  // imported conversation produces a clean, verifiable bundle on its
  // own — no drift introduced by the import path.
  const p = await request("POST", "/api/continuity-bundle/preview", { bundle: r.data.blob });
  assert.equal(p.status, 200);
  assert.equal(p.data.hash_ok, true,
    "re-exported imported conversation bundle must hash-verify cleanly");
});

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
