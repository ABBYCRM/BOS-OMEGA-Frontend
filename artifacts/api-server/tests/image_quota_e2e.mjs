#!/usr/bin/env node
/**
 * Task #85 — image-generation spend cap end-to-end spec.
 *
 * Modeled on `image_generation_e2e.mjs`. Asserts that:
 *
 *   1. GET  /api/image-quota returns the current usage + caps shape.
 *   2. PUT  /api/image-quota/override applies a tight per-user cap.
 *   3. With max_images_per_day=1, the FIRST image generation succeeds,
 *      and the SECOND is blocked: HOLD verdict, no provider call,
 *      friendly "Spend limit reached" summary, and an
 *      IMAGE_QUOTA_BLOCKED audit row with tripped="count".
 *   4. The blocked attempt does NOT produce IMAGE_REQUESTED-then-IMAGE_GENERATION_FAILED;
 *      it produces IMAGE_REQUESTED + IMAGE_QUOTA_BLOCKED only (no
 *      provider was called).
 *   5. With max_usd_cents_per_day=0 (and a relaxed count cap), even the
 *      FIRST live-cost generation would be blocked. We assert this in
 *      mock mode by setting BOTH caps relaxed first, generating one
 *      image (cost 0, mock), then setting USD cap = 0 and asserting
 *      mock generations STILL succeed (mock cost is 0). This protects
 *      us from accidentally breaking the dev/CI loop.
 *   6. GET /api/image-quota usage_today reflects the count.
 *   7. DELETE /api/image-quota/override drops the override and reverts
 *      to engine defaults.
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
  else if (r.status !== 204) data = await r.text().catch(() => null);
  return { status: r.status, data };
}

console.log(`Image quota E2E vs ${API_BASE}`);

const jar = {};

// ----------------------------------------------------------------- 1. Login
await test("login as super_admin", async () => {
  const r = await request(jar, "POST", "/api/auth/login", {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  assert.equal(r.status, 200, `login should succeed, got ${r.status}: ${JSON.stringify(r.data)}`);
  assert.ok(jar.cookie, "session cookie should be set");
});

async function clearOverride() {
  await request(jar, "DELETE", "/api/image-quota/override");
}

// Reset any leftover override from a previous test run before we start.
await clearOverride();

// ----------------------------------------------------------------- 2. GET shape
await test("GET /api/image-quota returns the documented shape", async () => {
  const r = await request(jar, "GET", "/api/image-quota");
  assert.equal(r.status, 200, `expected 200, got ${r.status}`);
  assert.ok(r.data, "response body present");
  assert.equal(typeof r.data.defaults?.daily_count, "number", "defaults.daily_count is number");
  assert.equal(typeof r.data.defaults?.daily_usd_cents, "number", "defaults.daily_usd_cents is number");
  assert.equal(typeof r.data.caps?.daily_count, "number", "caps.daily_count is number");
  assert.equal(typeof r.data.caps?.daily_usd_cents, "number", "caps.daily_usd_cents is number");
  assert.equal(typeof r.data.usage_today?.count, "number", "usage_today.count is number");
  assert.equal(typeof r.data.usage_today?.usd_cents, "number", "usage_today.usd_cents is number");
  assert.equal(typeof r.data.has_override, "boolean", "has_override is boolean");
  assert.equal(r.data.has_override, false, "no override yet");
});

// ----------------------------------------------------------------- 3. Set tight count cap
await test("PUT /api/image-quota/override accepts max_images_per_day=1", async () => {
  const r = await request(jar, "PUT", "/api/image-quota/override", {
    max_images_per_day: 1,
    max_usd_cents_per_day: null,
    note: "image_quota_e2e",
  });
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.data)}`);
  assert.equal(r.data?.ok, true);

  const after = await request(jar, "GET", "/api/image-quota");
  assert.equal(after.data?.caps?.daily_count, 1, "effective cap is 1");
  assert.equal(after.data?.has_override, true, "has_override flips true");
  assert.deepEqual(after.data?.overridden_fields, ["daily_count"], "only count was overridden");
});

// Helper — submit a generation prompt + return a normalized
// { task_id, task_type, tri_state, bos_output } shape so downstream
// assertions don't have to care that POST /api/tasks returns a row
// whose `final_output` is a stringified JSON BosOutput.
async function submitTask(input) {
  const r = await request(jar, "POST", "/api/tasks", { input });
  assert.equal(r.status, 200, `POST /api/tasks expected 200, got ${r.status}: ${JSON.stringify(r.data)}`);
  const row = r.data ?? {};
  let bos_output = null;
  if (typeof row.final_output === "string") {
    try {
      bos_output = JSON.parse(row.final_output);
    } catch {
      bos_output = null;
    }
  } else if (row.final_output && typeof row.final_output === "object") {
    bos_output = row.final_output;
  }
  return {
    task_id: row.id ?? row.task_id ?? null,
    task_type: row.task_type,
    tri_state: row.tri_state,
    bos_output: bos_output ?? {},
  };
}

// We're inside a single UTC day, but a previous test run may already have
// generated 1 image today, blowing the count cap before this test starts.
// Capture the baseline so subsequent assertions are relative to "fresh"
// (cap=1 means: at most 1 MORE generation allowed beyond the baseline).
let baselineCount = 0;
await test("captures today's baseline count", async () => {
  const r = await request(jar, "GET", "/api/image-quota");
  baselineCount = r.data?.usage_today?.count ?? 0;
  // To make the FIRST generation succeed regardless of baseline, raise
  // the cap to baseline + 1.
  const tight = await request(jar, "PUT", "/api/image-quota/override", {
    max_images_per_day: baselineCount + 1,
    max_usd_cents_per_day: null,
    note: "image_quota_e2e",
  });
  assert.equal(tight.status, 200);
});

// ----------------------------------------------------------------- 4. First gen succeeds
let firstTaskId = null;
await test("first generation under the cap succeeds (mock mode)", async () => {
  const out = await submitTask("generate an image of a small blue cube");
  assert.equal(out.task_type, "image_generation", `task_type=${out.task_type}`);
  assert.equal(out.tri_state, "GO", `expected tri_state GO, got ${out.tri_state}`);
  assert.equal(out.bos_output?.state, "GO", "bos_output.state GO");
  assert.ok(
    Array.isArray(out.bos_output?.generated_attachments) && out.bos_output.generated_attachments.length === 1,
    "1 generated attachment",
  );
  firstTaskId = out.task_id;
});

// ----------------------------------------------------------------- 5. Second gen blocked
let secondTaskId = null;
await test("second generation trips the count cap → HOLD with quota_exceeded", async () => {
  const out = await submitTask("generate an image of a small green cube");
  assert.equal(out.task_type, "image_generation", `task_type=${out.task_type}`);
  assert.equal(out.tri_state, "HOLD", `expected tri_state HOLD, got ${out.tri_state}`);
  assert.equal(out.bos_output?.state, "HOLD", `expected bos_output.state HOLD, got ${out.bos_output?.state}`);
  assert.ok(
    !out.bos_output?.generated_attachments || out.bos_output.generated_attachments.length === 0,
    "no attachments when blocked",
  );
  assert.match(
    String(out.bos_output?.answer ?? ""),
    /Spend limit reached/i,
    "answer carries the friendly Spend limit reached message",
  );
  // The denial cause maps to image_quota_exceeded → its why_decision_was_made
  // mentions the daily image-generation spend cap.
  assert.match(
    String(out.bos_output?.why_decision_was_made ?? ""),
    /spend cap/i,
    "denial explanation references the spend cap",
  );
  secondTaskId = out.task_id;
});

// ----------------------------------------------------------------- 6. Audit chain
await test("blocked attempt produced IMAGE_QUOTA_BLOCKED with tripped=count", async () => {
  assert.ok(secondTaskId, "blocked task id captured");
  const r = await request(jar, "GET", `/api/audit?task_id=${encodeURIComponent(secondTaskId)}`);
  assert.equal(r.status, 200);
  // Audit envelope is `{ entries, total, limit, offset }` (Task #72).
  const list = Array.isArray(r.data) ? r.data : (r.data?.entries ?? []);
  const types = list.map((e) => e.event_type);
  assert.ok(types.includes("IMAGE_REQUESTED"), `expected IMAGE_REQUESTED in ${types.join(",")}`);
  assert.ok(types.includes("IMAGE_QUOTA_BLOCKED"), `expected IMAGE_QUOTA_BLOCKED in ${types.join(",")}`);
  // No IMAGE_GENERATED for the blocked task — provider was never called.
  assert.ok(
    !types.includes("IMAGE_GENERATED"),
    `IMAGE_GENERATED should NOT be in audit for a blocked attempt: ${types.join(",")}`,
  );
  const blocked = list.find((e) => e.event_type === "IMAGE_QUOTA_BLOCKED");
  assert.ok(blocked, "found IMAGE_QUOTA_BLOCKED row");
  assert.equal(blocked.metadata?.tripped, "count", `tripped should be 'count', got '${blocked.metadata?.tripped}'`);
  assert.equal(blocked.metadata?.operation, "generation");
  assert.equal(typeof blocked.metadata?.daily_count, "number");
  assert.equal(typeof blocked.metadata?.daily_count_cap, "number");
  assert.equal(typeof blocked.metadata?.user_id, "string");
});

// ----------------------------------------------------------------- 7. Usage reflects success
await test("GET /api/image-quota.usage_today.count reflects the successful gen", async () => {
  const r = await request(jar, "GET", "/api/image-quota");
  assert.equal(r.status, 200);
  assert.ok(
    r.data?.usage_today?.count >= baselineCount + 1,
    `usage_today.count (${r.data?.usage_today?.count}) should be at least baseline+1 (${baselineCount + 1})`,
  );
});

// ----------------------------------------------------------------- 8. USD cap path (mock-safe)
await test("max_usd_cents_per_day=0 still allows mock generations (mock cost = 0)", async () => {
  // Loosen count cap so the count gate doesn't accidentally take credit
  // for the block. With USD cap = 0 and mock cost = 0, the inequality
  // `usage + 0 > 0` is FALSE on a fresh day → mock keeps working.
  const set = await request(jar, "PUT", "/api/image-quota/override", {
    max_images_per_day: 1000,
    max_usd_cents_per_day: 0,
    note: "image_quota_e2e_usd",
  });
  assert.equal(set.status, 200);
  const out = await submitTask("generate an image of a tiny yellow circle");
  assert.equal(out.tri_state, "GO", `mock generation still succeeds with USD cap=0; got ${out.tri_state}`);
});

// ----------------------------------------------------------------- 9. Cleanup
await test("DELETE /api/image-quota/override drops the override", async () => {
  const r = await request(jar, "DELETE", "/api/image-quota/override");
  assert.equal(r.status, 200);
  assert.equal(r.data?.ok, true);
  const after = await request(jar, "GET", "/api/image-quota");
  assert.equal(after.data?.has_override, false, "override cleared");
});

// ----------------------------------------------------------------- 10. Override input validation
await test("PUT /api/image-quota/override rejects negative + oversized values", async () => {
  const r1 = await request(jar, "PUT", "/api/image-quota/override", {
    max_images_per_day: -1,
  });
  assert.equal(r1.status, 400, "negative count rejected");

  const r2 = await request(jar, "PUT", "/api/image-quota/override", {
    max_images_per_day: 999_999,
  });
  assert.equal(r2.status, 400, "oversized count rejected");

  const r3 = await request(jar, "PUT", "/api/image-quota/override", {
    max_usd_cents_per_day: 99_999_999,
  });
  assert.equal(r3.status, 400, "oversized USD rejected");
});

// Final cleanup so a re-run of this test doesn't inherit a stale override.
await clearOverride();

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
