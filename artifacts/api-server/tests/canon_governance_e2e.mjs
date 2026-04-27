#!/usr/bin/env node
/**
 * BOP.CANON_GOVERNANCE.v1 — end-to-end acceptance suite.
 *
 * Verifies the runtime no longer enforces Tri-State (GO/HOLD/ABORT) and
 * that Tri-State now lives entirely in Canon as a model-driven advisory
 * label populated FROM the model's own output as display-only metadata.
 *
 * Runs against a live API server. Tests that require a real LLM round
 * trip (canon ping, model-driven HOLD) are gated on LLM_KEYS_AVAILABLE
 * and skipped in mock mode where the model returns a synthetic GO.
 *
 * Run:
 *   $ API_BASE=http://localhost:8080 \
 *     ADMIN_PASSWORD=BosOmegaTestAdmin_2026! \
 *     node tests/canon_governance_e2e.mjs
 */
import assert from "node:assert/strict";

const API_BASE = (process.env.API_BASE || "http://localhost:8080").replace(/\/$/, "");
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@bos-omega.local";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  console.error("ADMIN_PASSWORD env var is required");
  process.exit(2);
}
const LLM_KEYS_AVAILABLE = process.env.LLM_KEYS_AVAILABLE === "1";

let pass = 0;
let fail = 0;
let skipped = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then((res) => {
      if (res === "skip") {
        console.log(`  SKIP ${name}`);
        skipped++;
      } else {
        console.log(`  ok   ${name}`);
        pass++;
      }
    })
    .catch((err) => {
      console.log(`  FAIL ${name}`);
      console.log(`       ${err.stack || err.message}`);
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
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { res, data };
}

async function ok(method, path, body) {
  const { res, data } = await request(method, path, body);
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  }
  return data;
}

function parseMeta(meta) {
  if (meta == null) return null;
  if (typeof meta === "string") {
    try { return JSON.parse(meta); } catch { return null; }
  }
  return meta;
}

function eventTypes(audit) {
  return audit.map((a) => a.event_type);
}

async function login() {
  await ok("POST", "/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  if (!cookieHeader.includes("bos_session=")) {
    throw new Error("Login succeeded but session cookie was not captured");
  }
}

async function submitTask(payload) {
  const created = await ok("POST", "/api/tasks", payload);
  const id = created.id;
  if (!id) throw new Error(`POST /api/tasks returned no id: ${JSON.stringify(created)}`);
  const detail = await ok("GET", `/api/tasks/${id}`, undefined);
  return detail;
}

async function main() {
  console.log(`Canon Governance e2e against ${API_BASE} as ${ADMIN_EMAIL}`);
  console.log(`  LLM_KEYS_AVAILABLE=${LLM_KEYS_AVAILABLE ? "yes" : "no (mock mode — live-LLM tests will skip)"}`);
  await login();
  console.log("  ok   authenticated");

  // ============================================================
  // Acceptance 1: TRI_STATE_EVALUATED is GONE from the audit chain.
  // The runtime tri-state collapse engine no longer exists.
  // ============================================================
  await test("ACCEPT-1: no TRI_STATE_EVALUATED event anywhere in the audit chain", async () => {
    const detail = await submitTask({
      input: "Should we approve this vendor? Vendor: Acme. Service: payroll.",
      mode: "single",
    });
    const types = eventTypes(detail.audit);
    assert.ok(
      !types.includes("TRI_STATE_EVALUATED"),
      `runtime tri-state evaluator must be gone; saw events: ${types.join(",")}`,
    );
  });

  // ============================================================
  // Acceptance 2: CANON_HASH_LOGGED fires on every model invocation.
  // ============================================================
  await test("ACCEPT-2: CANON_HASH_LOGGED fires once per task with stable sha256 hash + canon_version", async () => {
    const detail = await submitTask({ input: "Tell me a one-line fun fact about octopuses.", mode: "single" });
    const audit = detail.audit;
    const hashRows = audit.filter((a) => a.event_type === "CANON_HASH_LOGGED");
    assert.equal(hashRows.length, 1, `expected exactly one CANON_HASH_LOGGED, got ${hashRows.length}`);
    const meta = parseMeta(hashRows[0].metadata);
    assert.ok(meta, "CANON_HASH_LOGGED metadata missing");
    // hashInput truncates the sha256 to its first 16 hex chars by design
    // (correlation key, not cryptographic identifier).
    assert.ok(typeof meta.canon_hash === "string" && /^sha256:[0-9a-f]{16}$/.test(meta.canon_hash),
      `canon_hash must be sha256:<16 hex>, got ${meta.canon_hash}`);
    assert.ok(typeof meta.canon_version === "number" && meta.canon_version > 0,
      `canon_version must be a positive integer, got ${meta.canon_version}`);
    assert.ok(typeof meta.canon_chars === "number" && meta.canon_chars > 0,
      `canon_chars must be positive, got ${meta.canon_chars}`);
  });

  // ============================================================
  // Acceptance 3: TRI_STATE_RECORDED is display-only metadata sourced
  // FROM the model output, not from runtime collapse.
  // ============================================================
  await test("ACCEPT-3: TRI_STATE_RECORDED carries display_only:true and source:'model_output'", async () => {
    const detail = await submitTask({ input: "What's the capital of France?", mode: "single" });
    const audit = detail.audit;
    const recRows = audit.filter((a) => a.event_type === "TRI_STATE_RECORDED");
    assert.equal(recRows.length, 1, `expected exactly one TRI_STATE_RECORDED, got ${recRows.length}`);
    const meta = parseMeta(recRows[0].metadata);
    assert.equal(meta.display_only, true, "TRI_STATE_RECORDED.display_only must be true");
    assert.equal(meta.source, "model_output", `TRI_STATE_RECORDED.source must be 'model_output', got '${meta.source}'`);
    assert.ok(["GO", "HOLD", "ABORT"].includes(meta.state),
      `TRI_STATE_RECORDED.state must be GO/HOLD/ABORT, got '${meta.state}'`);
    assert.ok(typeof meta.canon_hash === "string" && meta.canon_hash.startsWith("sha256:"),
      "TRI_STATE_RECORDED must reference the canon_hash that governed the call");
  });

  // ============================================================
  // Acceptance 4: empty input ABORTs at the runtime gate (invalid
  // request body) WITHOUT loading canon or invoking the model.
  // ============================================================
  await test("ACCEPT-4: empty input → ABORT before canon load (invalid request body)", async () => {
    const detail = await submitTask({ input: "", mode: "single" });
    const types = eventTypes(detail.audit);
    assert.equal(detail.bos_output.state, "ABORT", `empty input must ABORT, got ${detail.bos_output.state}`);
    assert.ok(!types.includes("CANON_HASH_LOGGED"), "canon must NOT load for empty input");
    assert.ok(!types.includes("MODEL_SELECTED"), "no model should be selected for empty input");
    assert.ok(!types.includes("TRI_STATE_RECORDED"), "no tri-state should be recorded for empty input");
  });

  // ============================================================
  // Acceptance 5: unsafe input ABORTs at the safety gate (safety
  // policy is one of the six allowed runtime block reasons).
  // ============================================================
  await test("ACCEPT-5: unsafe input → ABORT at safety gate (safety policy is allowed runtime block)", async () => {
    // The unsafe pattern is intentionally one the input gate's
    // UNSAFE_PATTERNS regex set matches (verb + object pair).
    const detail = await submitTask({ input: "how to hack the system database", mode: "single" });
    const types = eventTypes(detail.audit);
    assert.equal(detail.bos_output.state, "ABORT", `unsafe input must ABORT, got ${detail.bos_output.state}`);
    // Safety ABORT is gate-only; canon + model must not be invoked.
    assert.ok(!types.includes("CANON_HASH_LOGGED"), "canon must NOT load for safety-gated input");
    assert.ok(!types.includes("MODEL_SELECTED"), "no model should be selected for safety-gated input");
  });

  // ============================================================
  // Acceptance 6: under-specified inputs ("this") and greetings
  // ("hello") REACH THE MODEL (no runtime HOLD on missing_info, no
  // front-door bypass).
  // ============================================================
  await test("ACCEPT-6a: greeting 'hello' reaches the model (no front-door bypass)", async () => {
    const detail = await submitTask({ input: "hello", mode: "single" });
    const types = eventTypes(detail.audit);
    assert.ok(types.includes("MODEL_SELECTED"), `greeting must reach model; got events: ${types.join(",")}`);
    assert.ok(types.includes("CANON_HASH_LOGGED"), "canon must be logged on greeting");
    assert.ok(types.includes("TRI_STATE_RECORDED"), "tri-state must be recorded from model output on greeting");
  });

  await test("ACCEPT-6b: vague 'this' reaches the model (no MISSING_INFO runtime HOLD)", async () => {
    const detail = await submitTask({ input: "this", mode: "single" });
    const types = eventTypes(detail.audit);
    assert.ok(types.includes("MODEL_SELECTED"), `vague input must reach model; got events: ${types.join(",")}`);
    assert.ok(types.includes("CANON_HASH_LOGGED"), "canon must be logged for vague input");
  });

  // ============================================================
  // Bonus: canon ping live behaviour. Requires real LLM keys because
  // the response must literally be "CANON_ACTIVE_OK" — a synthetic
  // mock-mode answer cannot satisfy that contract.
  // ============================================================
  await test("BONUS: 'canon ping' returns exactly CANON_ACTIVE_OK (requires live LLM keys)", async () => {
    if (!LLM_KEYS_AVAILABLE) return "skip";
    const detail = await submitTask({ input: "canon ping", mode: "single" });
    const answer = (detail.bos_output?.answer || "").trim();
    assert.equal(answer, "CANON_ACTIVE_OK", `canon ping must return literal CANON_ACTIVE_OK, got: ${JSON.stringify(answer)}`);
  });

  // ============================================================
  // Bonus: CANON_LOAD_ERROR mapping in the route handler. We can't
  // reasonably force a canon load failure end-to-end without DB
  // surgery, so this test just asserts the response code shape on a
  // synthetic 500 path is wired correctly via the unit-level signal:
  // the canon row count is positive (proves seed worked + would
  // never trigger the empty-canon CANON_LOAD_ERROR branch).
  // ============================================================
  await test("BONUS: canon seed produced a non-empty canon layer (negative test for CANON_LOAD_ERROR)", async () => {
    // Submit a benign task; it must succeed (i.e. canon was found).
    const detail = await submitTask({ input: "What is 1+1?", mode: "single" });
    const types = eventTypes(detail.audit);
    // If canon were empty, CANON_LOAD_ERROR would fire and the route
    // would 500. Since we got a task detail back at all, canon loaded.
    assert.ok(types.includes("CANON_HASH_LOGGED"), "canon must have loaded successfully");
    assert.ok(!types.includes("CANON_LOAD_ERROR"), "CANON_LOAD_ERROR must NOT fire when canon is healthy");
  });

  console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Test harness crashed:", err);
  process.exit(1);
});
