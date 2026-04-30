#!/usr/bin/env node
/**
 * Regression test for the self-signup data-leak fix.
 *
 * Background:
 *   Pre-self-signup the per-route visibility filters returned tasks
 *   where `user_id IS NULL` to non-super_admin callers, on the
 *   assumption that NULL-tagged rows were legacy single-admin data
 *   that the lone authenticated user (admin) should keep seeing.
 *   Once self-signup landed (POST /api/auth/signup, role=user),
 *   that NULL fallback meant any new account on the internet could
 *   read every legacy admin-era task + their associated audit rows.
 *
 * This test:
 *   1. Plants a NULL-tagged sentinel task directly via SQL so the
 *      assertion is independent of whatever NULL rows the production
 *      DB happens to carry today.
 *   2. Self-signs up a fresh regular user via POST /api/auth/signup.
 *   3. As that user:
 *        a. GET /api/tasks      → must NOT include the sentinel.
 *        b. GET /api/audit      → must NOT include audit rows whose
 *           task_id matches the sentinel.
 *   4. As super_admin: GET /api/tasks must STILL include the sentinel
 *      (admin-era rows stay visible to admins).
 *   5. Cleans up the sentinel + the test user.
 *
 * Usage:
 *   $ API_BASE=http://localhost:80 \
 *     ADMIN_EMAIL=<admin email> \
 *     ADMIN_PASSWORD=<admin password> \
 *     DATABASE_URL=<postgres url> \
 *     node artifacts/api-server/tests/role_visibility_e2e.mjs
 *
 * Exits 0 on pass, 1 on any failure.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../../lib/db/", import.meta.url));
const pg = require("pg");

const API_BASE = (process.env.API_BASE || "http://localhost:80").replace(/\/$/, "");
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "paisabrazilfl@gmail.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  console.error("ADMIN_PASSWORD env var is required");
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL env var is required");
  process.exit(2);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

let pass = 0;
let fail = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ok  ${name}`); pass++; })
    .catch((err) => { console.log(`  FAIL ${name}\n       ${err.message}`); fail++; });
}

// Per-caller cookie jars so the two sessions don't trample each other.
function makeJar() { return { cookie: "" }; }
async function request(jar, method, path, body) {
  const headers = { Accept: "application/json" };
  if (jar.cookie) headers.Cookie = jar.cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(`${API_BASE}${path}`, {
    method, headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const sc = r.headers.get("set-cookie");
  if (sc) jar.cookie = sc.split(";")[0];
  let data = null;
  const ct = r.headers.get("content-type") || "";
  if (ct.includes("json")) data = await r.json().catch(() => null);
  return { status: r.status, data };
}

// ---- Setup: plant NULL-tagged sentinels in tasks, audit, memory ----
const sentinelId = randomUUID();
const sentinelTitle = `__VISIBILITY_SENTINEL_${sentinelId.slice(0, 8)}`;
await client.query(
  `INSERT INTO tasks (id, user_id, input_text, task_type, tri_state, final_status, mode, created_at)
   VALUES ($1, NULL, $2, 'general', 'idle', 'completed', 'single', NOW())`,
  [sentinelId, sentinelTitle],
);
const sentinelAuditId = randomUUID();
await client.query(
  `INSERT INTO audit_logs (id, task_id, event_type, message, metadata, created_at)
   VALUES ($1, $2, 'TASK_RECEIVED', 'visibility sentinel', '{"sentinel": true}'::jsonb, NOW())`,
  [sentinelAuditId, sentinelId],
);
// NULL-owned memory sentinel — pre-fix this could be PATCHed/DELETEd by
// any signed-up user, not just read.
const memorySentinelId = randomUUID();
const memorySentinelTitle = `__MEMORY_SENTINEL_${memorySentinelId.slice(0, 8)}`;
await client.query(
  `INSERT INTO memory_items (id, layer, title, content, authority_level, user_id, created_at, updated_at)
   VALUES ($1, 'canon', $2, 'sentinel content', 9, NULL, NOW(), NOW())`,
  [memorySentinelId, memorySentinelTitle],
);

// ---- Self-signup a fresh regular user ----
const userJar = makeJar();
const adminJar = makeJar();
const newEmail = `visibility-test-${Date.now()}-${sentinelId.slice(0, 6)}@example.test`;
const newPassword = `Vt!${randomUUID()}A1`;
let newUserId = null;

try {
  await test("POST /api/auth/signup creates a fresh regular user", async () => {
    const r = await request(userJar, "POST", "/api/auth/signup", {
      email: newEmail, password: newPassword,
    });
    assert.equal(r.status, 201, `signup failed: ${r.status} ${JSON.stringify(r.data)}`);
    assert.equal(r.data?.ok, true, `expected ok=true, got ${r.data?.ok}`);
    assert.equal(r.data?.user?.role, "user", `expected role=user, got ${r.data?.user?.role}`);
    newUserId = r.data.user.id;
  });

  await test("regular user GET /api/tasks does NOT see the NULL-tagged sentinel", async () => {
    const r = await request(userJar, "GET", "/api/tasks?limit=1000");
    assert.equal(r.status, 200, `GET /api/tasks failed: ${r.status}`);
    const list = Array.isArray(r.data) ? r.data : (r.data?.tasks ?? []);
    const leaked = list.find((t) => t.id === sentinelId);
    assert.equal(leaked, undefined,
      `LEAK: regular user could see NULL-tagged sentinel task ${sentinelId}`);
  });

  await test("regular user GET /api/audit does NOT see the sentinel's audit row", async () => {
    const r = await request(userJar, "GET", "/api/audit?limit=1000");
    assert.equal(r.status, 200, `GET /api/audit failed: ${r.status}`);
    const entries = Array.isArray(r.data) ? r.data : (r.data?.entries ?? []);
    const leaked = entries.find((e) => e.task_id === sentinelId);
    assert.equal(leaked, undefined,
      `LEAK: regular user could see audit row tied to NULL-tagged sentinel`);
  });

  await test("regular user GET /api/tri-state/by-task/<sentinel> is NOT visible", async () => {
    // The endpoint returns 404 for both "no decision exists" and
    // "task not visible to caller". Either is fine — what matters is
    // it does NOT return a row leaked from the NULL-tagged sentinel.
    const r = await request(userJar, "GET", `/api/tri-state/by-task/${sentinelId}`);
    assert.ok([403, 404].includes(r.status),
      `LEAK: tri-state route returned ${r.status} for NULL-tagged sentinel`);
  });

  await test("regular user GET /api/memory does NOT see NULL-owned canon", async () => {
    const r = await request(userJar, "GET", "/api/memory");
    assert.equal(r.status, 200, `GET /api/memory failed: ${r.status}`);
    const items = Array.isArray(r.data) ? r.data : (r.data?.items ?? []);
    const leaked = items.find((m) => m.id === memorySentinelId);
    assert.equal(leaked, undefined,
      `LEAK: regular user could read NULL-owned memory canon ${memorySentinelId}`);
  });

  await test("regular user PATCH /api/memory/:id of NULL-owned row is rejected", async () => {
    const r = await request(userJar, "PATCH", `/api/memory/${memorySentinelId}`, {
      title: "tampered-by-untrusted-user",
    });
    assert.equal(r.status, 404,
      `TAMPER: regular user PATCH on NULL-owned canon returned ${r.status}, expected 404`);
    // Verify nothing actually changed on disk.
    const { rows } = await client.query(
      `SELECT title FROM memory_items WHERE id = $1`, [memorySentinelId],
    );
    assert.equal(rows[0]?.title, memorySentinelTitle,
      `TAMPER: NULL-owned canon title was mutated by non-super user`);
  });

  await test("regular user DELETE /api/memory/:id of NULL-owned row is rejected", async () => {
    const r = await request(userJar, "DELETE", `/api/memory/${memorySentinelId}`);
    assert.equal(r.status, 404,
      `TAMPER: regular user DELETE on NULL-owned canon returned ${r.status}, expected 404`);
    const { rows } = await client.query(
      `SELECT id FROM memory_items WHERE id = $1`, [memorySentinelId],
    );
    assert.equal(rows.length, 1,
      `TAMPER: NULL-owned canon row was deleted by non-super user`);
  });

  await test("super_admin login still works", async () => {
    const r = await request(adminJar, "POST", "/api/auth/login", {
      email: ADMIN_EMAIL, password: ADMIN_PASSWORD,
    });
    assert.equal(r.status, 200, `admin login failed: ${r.status} ${JSON.stringify(r.data)}`);
    assert.equal(r.data?.user?.role, "super_admin");
  });

  await test("super_admin GET /api/tasks STILL sees the NULL-tagged sentinel (no admin regression)", async () => {
    // Sentinel is freshly inserted, so it's near the top — but be defensive
    // and page through if needed in case other test fixtures pile up.
    let found = false;
    let offset = 0;
    const pageSize = 200;
    for (let i = 0; i < 10 && !found; i++) {
      const r = await request(adminJar, "GET", `/api/tasks?limit=${pageSize}&offset=${offset}`);
      assert.equal(r.status, 200, `admin GET /api/tasks failed: ${r.status}`);
      const list = Array.isArray(r.data) ? r.data : (r.data?.tasks ?? []);
      if (list.length === 0) break;
      if (list.find((t) => t.id === sentinelId)) { found = true; break; }
      offset += pageSize;
    }
    assert.ok(found,
      "REGRESSION: super_admin lost visibility of NULL-tagged legacy tasks");
  });
} finally {
  // ---- Cleanup ----
  await client.query(`DELETE FROM audit_logs WHERE id = $1`, [sentinelAuditId]);
  await client.query(`DELETE FROM tasks WHERE id = $1`, [sentinelId]);
  await client.query(`DELETE FROM memory_items WHERE id = $1`, [memorySentinelId]);
  if (newUserId) {
    await client.query(`DELETE FROM audit_logs WHERE metadata->>'actor_user_id' = $1
                                                  OR metadata->>'target_user_id' = $1`, [newUserId]);
    await client.query(`DELETE FROM users WHERE id = $1`, [newUserId]);
  }
  await client.end();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
