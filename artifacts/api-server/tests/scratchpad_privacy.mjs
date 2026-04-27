#!/usr/bin/env node
/**
 * Task #67 — Privacy/leakage tests for the lattice continuity
 * scratchpad layer.
 *
 * Coverage:
 *   1. A scratchpad row owned by user A is NOT returned in the GET
 *      /api/scratchpad response of user B (per-user retrieval scope).
 *   2. The same row's content does NOT appear in user B's task
 *      `injected_memory` after running a task (cross-tenant prompt
 *      injection guard — defense-in-depth on top of `selectLayer`).
 *   3. A NULL-owned legacy row planted directly into the DB is NOT
 *      visible to authenticated users (no anonymous fallback).
 *
 * The test plants the user-A row via raw SQL using DATABASE_URL so
 * we don't depend on a registration endpoint that the API does not
 * expose — only `super_admin` exists by default. User B is faked by
 * bypassing the writer and making the row "owned" by a synthetic
 * UUID that no real session ever sees, then we log in as the
 * super_admin (user B from B's perspective) and assert isolation.
 *
 * Usage:
 *   $ API_BASE=http://localhost:8080 \
 *     ADMIN_EMAIL=paisabrazilfl@gmail.com \
 *     ADMIN_PASSWORD=<pw> \
 *     node artifacts/api-server/tests/scratchpad_privacy.mjs
 *
 * Cleans up after itself. Exits 0 on pass, 1 on any failure.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
// Use createRequire to load `pg` from lib/db's node_modules — pnpm
// hoists it there but not into artifacts/api-server's tests folder,
// and pg's CJS-only package shape is not friendly to plain ESM
// `import "pg"`. This avoids forcing a duplicate dependency.
const require = createRequire(new URL("../../../lib/db/", import.meta.url));
const pg = require("pg");

const API_BASE = (process.env.API_BASE || "http://localhost:8080").replace(/\/$/, "");
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

let cookieHeader = "";
async function request(method, path, body) {
  const headers = { Accept: "application/json" };
  if (cookieHeader) headers.Cookie = cookieHeader;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(`${API_BASE}${path}`, {
    method, headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const sc = r.headers.get("set-cookie");
  if (sc) cookieHeader = sc.split(";")[0];
  let data = null;
  const ct = r.headers.get("content-type") || "";
  if (ct.includes("json")) data = await r.json().catch(() => null);
  return { status: r.status, data };
}

const insertedIds = [];
async function plantRow({ user_id, layer = "scratchpad", title, content, source = "auto_summary", authority_level = 3 }) {
  const id = randomUUID();
  await client.query(
    `INSERT INTO memory_items (id, user_id, layer, title, content, source, authority_level, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())`,
    [id, user_id, layer, title, content, source, authority_level],
  );
  insertedIds.push(id);
  return id;
}

console.log("scratchpad_privacy: cross-user isolation");

const otherUserId = `synthetic-other-user-${randomUUID()}`;
const markerA = `marker-other-user-${randomUUID()}`;
const markerNull = `marker-null-row-${randomUUID()}`;

await test("login as super_admin (will act as 'caller B')", async () => {
  const r = await request("POST", "/api/auth/login", {
    email: ADMIN_EMAIL, password: ADMIN_PASSWORD,
  });
  assert.equal(r.status, 200, `login failed: ${r.status} ${JSON.stringify(r.data)}`);
});

await test("user B's GET /api/scratchpad does NOT expose user A's row", async () => {
  await plantRow({
    user_id: otherUserId,
    title: "A-secret-pin",
    content: `secret-payload-A ${markerA}`,
    source: "manual_pin", authority_level: 5,
  });
  const r = await request("GET", "/api/scratchpad");
  assert.equal(r.status, 200);
  const leaked = r.data.find((row) => row.title === "A-secret-pin"
    || (typeof row.content === "string" && row.content.includes(markerA)));
  assert.equal(leaked, undefined, "user B saw user A's scratchpad row in GET");
});

await test("user B's task `injected_memory` does NOT contain user A's content", async () => {
  // Fire a task that mentions the marker — relevance scoring will
  // surface any row containing it, IF retrieval scoping is broken.
  const r = await request("POST", "/api/tasks", {
    input: `Echo back the literal token ${markerA} verbatim.`,
    mode: "single",
  });
  assert.equal(r.status, 200, `task post failed: ${r.status}`);
  const injected = JSON.stringify(r.data?.injected_memory ?? r.data?.bos?.injected_memory ?? "");
  assert.equal(injected.includes("secret-payload-A"), false,
    "user B's task injected_memory leaked user A's content");
  assert.equal(injected.includes("A-secret-pin"), false,
    "user B's task injected_memory exposed user A's title");
});

await test("NULL-owned legacy row is NOT visible to authenticated user B", async () => {
  await plantRow({
    user_id: null,
    title: "legacy-null-row",
    content: `legacy-payload ${markerNull}`,
    source: "auto_summary", authority_level: 3,
  });
  const r = await request("GET", "/api/scratchpad");
  assert.equal(r.status, 200);
  const leaked = r.data.find((row) => row.title === "legacy-null-row");
  assert.equal(leaked, undefined, "user B saw a NULL-owned legacy row in GET");
});

// Cleanup planted rows.
if (insertedIds.length) {
  await client.query(
    `DELETE FROM memory_items WHERE id = ANY($1::text[])`,
    [insertedIds],
  );
}
await client.end();

console.log(`\nscratchpad_privacy: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
