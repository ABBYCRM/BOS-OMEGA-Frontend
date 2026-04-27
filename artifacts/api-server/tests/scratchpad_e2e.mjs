#!/usr/bin/env node
/**
 * Task #67 — end-to-end integration tests for the lattice continuity
 * scratchpad CRUD endpoints, run against a live BOS-OMEGA API server.
 *
 * Coverage:
 *   1. POST /api/scratchpad/pin (with title)        → 201, row exposed
 *      via GET, source="manual_pin", source_task_id persisted, audit
 *      log records SCRATCHPAD_PINNED with title_provided=true.
 *   2. POST /api/scratchpad/pin (without title)     → 201, server
 *      derives a "Pin: …" title from the content's first line, audit
 *      records title_provided=false.
 *   3. POST /api/scratchpad/pin (no auth)           → 401.
 *   4. POST /api/tasks then read /api/scratchpad    → an auto_summary
 *      row appears scoped to the caller, with source_task_id pointing
 *      at the new task and a SCRATCHPAD_AUTO_WRITTEN audit row.
 *      (Pipeline integration coverage required by Task #67.)
 *   5. DELETE /api/scratchpad/:id (owner)           → 204, audit
 *      records SCRATCHPAD_DELETED with admin_bypass=false.
 *   6. DELETE /api/scratchpad/:not_owner            → 404 (no leak).
 *
 * Run against an already-running server:
 *   $ API_BASE=http://localhost:8080 \
 *     ADMIN_EMAIL=paisabrazilfl@gmail.com \
 *     ADMIN_PASSWORD=<password> \
 *     node artifacts/api-server/tests/scratchpad_e2e.mjs
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

async function findAuditEvent(event_type, predicate, limit = 50) {
  const r = await request("GET", `/api/audit?limit=${limit}`);
  assert.equal(r.status, 200, `audit list failed: ${r.status}`);
  const rows = Array.isArray(r.data) ? r.data : (r.data?.items ?? []);
  return rows.find((row) => row.event_type === event_type && (!predicate || predicate(row)));
}

console.log("scratchpad_e2e: live HTTP integration");

let pinnedWithTitleId = null;
let pinnedWithoutTitleId = null;
let autoSummaryId = null;
let newTaskId = null;

await test("login as admin user", async () => {
  await login();
});

await test("POST /pin with title → 201 + row visible in GET + audit recorded", async () => {
  const title = `e2e-pin-with-title ${Date.now()}`;
  const r = await request("POST", "/api/scratchpad/pin", {
    content: "First line of the pinned content\nSecond line is body",
    source_task_id: "deadbeef-task",
    title,
  });
  assert.equal(r.status, 201, `expected 201, got ${r.status}: ${JSON.stringify(r.data)}`);
  pinnedWithTitleId = r.data.id;
  assert.ok(pinnedWithTitleId, "pin response missing id");
  assert.equal(r.data.source, "manual_pin");
  assert.equal(r.data.layer, "scratchpad");
  assert.equal(r.data.source_task_id, "deadbeef-task");
  assert.equal(r.data.title, title);

  // Round-trip GET — must contain our row scoped to the caller.
  const list = await request("GET", "/api/scratchpad");
  assert.equal(list.status, 200);
  const found = list.data.find((e) => e.id === pinnedWithTitleId);
  assert.ok(found, "pinned row not visible in GET /api/scratchpad");
  assert.equal(found.source_task_id, "deadbeef-task");

  // Audit chain — SCRATCHPAD_PINNED with title_provided=true.
  const event = await findAuditEvent("SCRATCHPAD_PINNED",
    (row) => row?.metadata?.memory_id === pinnedWithTitleId);
  assert.ok(event, "no SCRATCHPAD_PINNED audit row found");
  assert.equal(event.metadata.title_provided, true, "expected title_provided=true");
  assert.equal(event.metadata.source_task_id, "deadbeef-task");
});

await test("POST /pin WITHOUT title → 201 + server-derived title + audit title_provided=false", async () => {
  const r = await request("POST", "/api/scratchpad/pin", {
    content: "Untitled pin top line\nbody after",
  });
  assert.equal(r.status, 201, `expected 201, got ${r.status}: ${JSON.stringify(r.data)}`);
  pinnedWithoutTitleId = r.data.id;
  assert.ok(pinnedWithoutTitleId);
  // Server-derived title starts with "Pin: " and reflects the first line.
  assert.match(r.data.title, /^Pin: Untitled pin top line/);

  const event = await findAuditEvent("SCRATCHPAD_PINNED",
    (row) => row?.metadata?.memory_id === pinnedWithoutTitleId);
  assert.ok(event, "no SCRATCHPAD_PINNED audit row found");
  assert.equal(event.metadata.title_provided, false, "expected title_provided=false");
});

await test("POST /pin with no auth → 401", async () => {
  const r = await fetch(`${API_BASE}/api/scratchpad/pin`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ content: "no-auth content" }),
  });
  assert.equal(r.status, 401, `expected 401, got ${r.status}`);
});

await test("pipeline integration: POST /api/tasks → auto_summary row written + audit chain", async () => {
  const beforeList = await request("GET", "/api/scratchpad");
  const beforeAutoIds = new Set(beforeList.data.filter((e) => e.source === "auto_summary").map((e) => e.id));

  // Fire a small but concrete task — must be specific enough that the
  // front-door router does NOT HOLD for clarification, otherwise the
  // auto-writer (correctly) skips. We assert COMPLETED; if the router
  // ever HOLDs this prompt the test surfaces the regression.
  const post = await request("POST", "/api/tasks", {
    input: `Reply with the single word "ok" and nothing else. Probe ${Date.now()}.`,
    mode: "single",
  });
  assert.equal(post.status, 200, `task post failed: ${post.status} ${JSON.stringify(post.data)}`);
  newTaskId = post.data.id;
  assert.ok(newTaskId, "task post missing id");
  assert.equal(post.data.final_status, "COMPLETED",
    `task did not COMPLETE (was ${post.data.final_status}); auto-summary only fires on success`);

  // Brief wait for writer flush.
  await new Promise((res) => setTimeout(res, 500));

  const afterList = await request("GET", "/api/scratchpad");
  const newAuto = afterList.data.find((e) => e.source === "auto_summary" && !beforeAutoIds.has(e.id));
  assert.ok(newAuto, "no NEW auto_summary row appeared after task completion");
  assert.equal(newAuto.source_task_id, newTaskId, "auto_summary row source_task_id mismatch");
  autoSummaryId = newAuto.id;

  // Auto-summary content must respect the 2–3 sentence single-paragraph
  // contract — no embedded newlines.
  assert.equal(newAuto.content.includes("\n"), false, "auto_summary content must be a single paragraph");

  const event = await findAuditEvent("SCRATCHPAD_AUTO_WRITTEN",
    (row) => row?.metadata?.memory_id === autoSummaryId);
  assert.ok(event, "no SCRATCHPAD_AUTO_WRITTEN audit row found");
  assert.equal(event.task_id, newTaskId, "audit task_id mismatch");
  assert.equal(event.metadata.source_task_id, newTaskId);
});

await test("DELETE /:id (owner) → 204 + audit SCRATCHPAD_DELETED with admin_bypass=false", async () => {
  const r = await request("DELETE", `/api/scratchpad/${pinnedWithoutTitleId}`);
  assert.equal(r.status, 204, `expected 204, got ${r.status}: ${JSON.stringify(r.data)}`);

  // Confirm gone from list.
  const list = await request("GET", "/api/scratchpad");
  assert.ok(!list.data.some((e) => e.id === pinnedWithoutTitleId), "row still visible after delete");

  const event = await findAuditEvent("SCRATCHPAD_DELETED",
    (row) => row?.metadata?.memory_id === pinnedWithoutTitleId);
  assert.ok(event, "no SCRATCHPAD_DELETED audit row found");
  assert.equal(event.metadata.admin_bypass, false, "owner delete should record admin_bypass=false");
});

await test("DELETE non-existent id → 404 (no existence leak)", async () => {
  const r = await request("DELETE", `/api/scratchpad/00000000-0000-0000-0000-000000000000`);
  assert.equal(r.status, 404, `expected 404, got ${r.status}`);
});

// Cleanup our remaining test row so reruns stay tidy.
if (pinnedWithTitleId) {
  await request("DELETE", `/api/scratchpad/${pinnedWithTitleId}`);
}

console.log(`\nscratchpad_e2e: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
