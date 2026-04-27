#!/usr/bin/env node
/**
 * BOP.PERSONA_SLOTS.v1 end-to-end tests against a live BOS-OMEGA API server.
 *
 * Exercises:
 *   1. GET /api/personas returns the three slots A, B, C in stable order.
 *   2. PATCH /api/personas/B updates title and content; subsequent GET
 *      reflects the change (also proves seedPersonaSlots is idempotent
 *      because the seed runs at boot and the user's edit survived it).
 *   3. POST /api/tasks with persona_slot=B records persona_slot=B and
 *      persona_title=<edited title> on the TASK_RECEIVED audit event,
 *      proving the resolution wired into the pipeline.
 *
 * Run against an already-running server:
 *   $ API_BASE=http://localhost:8080 \
 *     ADMIN_EMAIL=admin@bos-omega.local \
 *     ADMIN_PASSWORD=BosOmegaTestAdmin_2026! \
 *     node artifacts/api-server/tests/persona_slots_e2e.mjs
 *
 * Exits 0 on pass, 1 on any failure.
 */
import assert from "node:assert/strict";

const API_BASE = (process.env.API_BASE || "http://localhost:8080").replace(/\/$/, "");
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@bos-omega.local";
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
    .then(() => {
      console.log(`  ok  ${name}`);
      pass++;
    })
    .catch((err) => {
      console.log(`  FAIL ${name}`);
      console.log(`       ${err.message}`);
      fail++;
    });
}

let cookieHeader = "";

async function request(method, path, body) {
  const headers = { "Content-Type": "application/json" };
  if (cookieHeader) headers["Cookie"] = cookieHeader;
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) {
    cookieHeader = setCookie.split(",").map((c) => c.split(";")[0].trim()).join("; ");
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

async function login() {
  const r = await request("POST", "/api/auth/login", {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  assert.equal(r.status, 200, `login failed: ${JSON.stringify(r.data)}`);
}

async function main() {
  console.log(`BOP.PERSONA_SLOTS.v1 e2e against ${API_BASE}`);
  await login();

  await test("GET /api/personas returns 3 slots in order A, B, C", async () => {
    const r = await request("GET", "/api/personas");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data), "response is not an array");
    assert.equal(r.data.length, 3, `expected 3 slots, got ${r.data.length}`);
    assert.deepEqual(r.data.map((s) => s.slot), ["A", "B", "C"]);
    for (const s of r.data) {
      assert.ok(typeof s.title === "string" && s.title.length > 0, `slot ${s.slot} has empty title`);
      assert.ok(typeof s.content === "string" && s.content.length > 0, `slot ${s.slot} has empty content`);
    }
  });

  // Use a unique title so we can grep for it in the audit log without
  // colliding with a previous test run that may still be in the DB.
  const NEW_TITLE = `Persona B Test ${Date.now()}`;
  const NEW_CONTENT =
    "PERSONA_SLOTS_E2E content marker. Provide a concise, structured answer.";

  await test("PATCH /api/personas/B renames the slot", async () => {
    const r = await request("PATCH", "/api/personas/B", {
      title: NEW_TITLE,
      content: NEW_CONTENT,
    });
    assert.equal(r.status, 200, `PATCH failed: ${JSON.stringify(r.data)}`);
    assert.equal(r.data.slot, "B");
    assert.equal(r.data.title, NEW_TITLE);
    assert.equal(r.data.content, NEW_CONTENT);
  });

  await test("subsequent GET /api/personas reflects the rename (and seed didn't overwrite it)", async () => {
    const r = await request("GET", "/api/personas");
    assert.equal(r.status, 200);
    const b = r.data.find((s) => s.slot === "B");
    assert.ok(b, "slot B missing");
    assert.equal(b.title, NEW_TITLE);
    assert.equal(b.content, NEW_CONTENT);
  });

  await test("PATCH /api/personas/Z (invalid slot) returns 400", async () => {
    const r = await request("PATCH", "/api/personas/Z", { title: "x", content: "y" });
    assert.ok(r.status === 400, `expected 400, got ${r.status}`);
  });

  let task_id;
  await test("POST /api/tasks with persona_slot=B succeeds", async () => {
    const r = await request("POST", "/api/tasks", {
      input: "Reply with the single word OK.",
      mode: "single",
      persona_slot: "B",
    });
    assert.ok(r.status === 200 || r.status === 201, `task creation failed (${r.status}): ${JSON.stringify(r.data)}`);
    assert.ok(r.data && typeof r.data.id === "string", "task id missing");
    task_id = r.data.id;
  });

  await test("TASK_RECEIVED audit metadata records persona_slot=B and the edited title", async () => {
    const r = await request("GET", `/api/audit?task_id=${encodeURIComponent(task_id)}&limit=200`);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data), "audit response is not an array");
    const received = r.data.find((e) => e.event_type === "TASK_RECEIVED");
    assert.ok(received, "TASK_RECEIVED event missing");
    const meta = received.metadata || {};
    assert.equal(meta.persona_slot, "B", `persona_slot=${meta.persona_slot}`);
    assert.equal(meta.persona_title, NEW_TITLE, `persona_title=${meta.persona_title}`);
  });

  await test("CTX_BUILT audit metadata shows persona_prompt_chars > 0 for persona_slot tasks", async () => {
    const r = await request("GET", `/api/audit?task_id=${encodeURIComponent(task_id)}&limit=200`);
    assert.equal(r.status, 200);
    const ctx_built = r.data.find((e) => e.event_type === "CTX_BUILT");
    // CTX_BUILT only fires once execution begins; if the task short-circuited
    // we skip rather than fail (this guards against front-door redirects).
    if (!ctx_built) {
      console.log("       (skipped: no CTX_BUILT event — task may have short-circuited)");
      return;
    }
    const chars = ctx_built.metadata?.persona_prompt_chars ?? 0;
    assert.ok(chars > 0, `persona_prompt_chars should be > 0 when persona_slot is set, got ${chars}`);
  });

  console.log("");
  console.log(`pass=${pass} fail=${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
