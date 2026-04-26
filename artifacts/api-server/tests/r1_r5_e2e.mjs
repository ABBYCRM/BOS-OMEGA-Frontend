#!/usr/bin/env node
/**
 * R-1 + R-5 end-to-end tests against a live BOS-OMEGA API server.
 *
 * Per task §"Add automated end-to-end coverage for parallel role assignment
 * and audit events". Submits real tasks against the dev API server in three
 * configurations and asserts the full audit chain plus the R-1 role suffix
 * on parallel_responses. Catches silent regressions in:
 *   - executionEngine.executeParallel (role assignment + per-response audit)
 *   - pipeline mode-resolution + N=1 downgrade
 *   - keyResolver / proxy routing audit events
 *
 * Run against an already-running server:
 *   $ API_BASE=http://localhost:8080 \
 *     ADMIN_EMAIL=admin@bos-omega.local \
 *     ADMIN_PASSWORD=BosOmegaTestAdmin_2026! \
 *     node tests/r1_r5_e2e.mjs
 *
 * Or use the one-command harness which boots the server itself:
 *   $ node tests/run-r1-r5-e2e.mjs
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

const PARALLEL_ROLES = ["ARCHITECT", "CRITIC", "RESEARCHER", "BUILDER", "VALIDATOR"];
const ROLE_SUFFIX_RE = /^.+ \((ARCHITECT|CRITIC|RESEARCHER|BUILDER|VALIDATOR)\)$/;
// Events that must NOT appear in single-mode runs. These are the role-overlay
// audit events plus the merge step that only the parallel/consensus path
// produces. If any of these surface in a single run, R-1 has regressed
// (e.g. someone wired the role overlay into executeSingle).
const PARALLEL_ONLY_EVENTS = new Set([
  "PARALLEL_EXECUTION_STARTED",
  "PARALLEL_EXECUTION_COMPLETED",
  "PARALLEL_RESPONSE_RECEIVED",
  "PARALLEL_RESPONSE_FAILED",
  "MERGE_COMPLETED",
]);

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
  // Capture set-cookie for login.
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) {
    // Extract just the cookie name=value pairs.
    cookieHeader = setCookie.split(",").map((c) => c.split(";")[0].trim()).join("; ");
  }
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  }
  return data;
}

async function login() {
  await request("POST", "/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  if (!cookieHeader.includes("bos_session=")) {
    throw new Error("Login succeeded but session cookie was not captured");
  }
}

async function submitTask(payload) {
  const created = await request("POST", "/api/tasks", payload);
  const id = created.id;
  if (!id) throw new Error(`POST /api/tasks returned no id: ${JSON.stringify(created)}`);
  // Re-fetch the canonical task detail so we're asserting on the same source
  // of truth the UI uses (tasks.GET /:id).
  const detail = await request("GET", `/api/tasks/${id}`, undefined);
  return { created, detail };
}

function countEvents(audit, type) {
  return audit.filter((a) => a.event_type === type).length;
}

function eventTypes(audit) {
  return audit.map((a) => a.event_type);
}

// audit_logs.metadata is JSONB on the server but the JSON serializer may
// return it either as an object (Postgres jsonb auto-parsed) or as a string
// (legacy text columns). Normalize so callers can dot-access fields.
function parseMetadata(meta) {
  if (meta == null) return null;
  if (typeof meta === "string") {
    try { return JSON.parse(meta); } catch { return null; }
  }
  return meta;
}

async function main() {
  console.log(`R-1/R-5 e2e against ${API_BASE} as ${ADMIN_EMAIL}`);
  await login();
  console.log("  ok  authenticated");

  // ---------------- Configuration A: parallel with N>=2 ----------------
  await test("parallel N>=2: role suffix + per-response audit + KEY_RESOLVED + MERGE_COMPLETED", async () => {
    const REQUESTED_PARALLEL = 3;
    const { detail } = await submitTask({
      input: "What is 2 + 2? Respond briefly.",
      mode: "parallel",
      parallel_models: REQUESTED_PARALLEL,
    });
    const { task, audit, bos_output } = detail;
    assert.equal(task.mode, "parallel", "task.mode should remain parallel");

    // R-1 (b): exactly one PARALLEL_EXECUTION_STARTED, no MODE_DOWNGRADED,
    // and MERGE_COMPLETED fires for parallel runs (regardless of how many
    // individual provider calls succeeded).
    assert.equal(countEvents(audit, "PARALLEL_EXECUTION_STARTED"), 1, "expected exactly 1 PARALLEL_EXECUTION_STARTED");
    assert.equal(countEvents(audit, "MODE_DOWNGRADED"), 0, "no downgrade should fire when N>=2");

    // R-1 (b) cont: dispatched count is fully deterministic — we asked for
    // REQUESTED_PARALLEL models and the engine fans out exactly that many
    // calls. Each call produces exactly one of RECEIVED or FAILED. We
    // assert the dispatched count exactly so a transient provider blip
    // (which would shift RECEIVED→FAILED) cannot make the suite flaky.
    const received = countEvents(audit, "PARALLEL_RESPONSE_RECEIVED");
    const failed = countEvents(audit, "PARALLEL_RESPONSE_FAILED");
    assert.equal(
      received + failed,
      REQUESTED_PARALLEL,
      `dispatched parallel calls (${received + failed}) !== requested (${REQUESTED_PARALLEL})`,
    );

    // R-5: KEY_RESOLVED fires once per dispatched call. PROXY_CALL fires
    // only for calls whose key source==="proxy". Tighter than a global
    // upper bound: we count PROXY_CALL exactly via per-call provider
    // metadata so a regression (e.g. forgetting to emit PROXY_CALL for
    // some adapter) is caught even if global counts still line up.
    const keyResolved = countEvents(audit, "KEY_RESOLVED");
    assert.equal(
      keyResolved,
      REQUESTED_PARALLEL,
      `KEY_RESOLVED (${keyResolved}) should equal dispatched calls (${REQUESTED_PARALLEL})`,
    );
    const keyResolvedRows = audit.filter((a) => a.event_type === "KEY_RESOLVED");
    let expectedProxy = 0;
    for (const row of keyResolvedRows) {
      const meta = parseMetadata(row.metadata);
      if (meta?.is_proxy === true || meta?.source === "proxy") expectedProxy++;
    }
    const proxyCall = countEvents(audit, "PROXY_CALL");
    assert.equal(
      proxyCall,
      expectedProxy,
      `PROXY_CALL (${proxyCall}) must equal the number of proxy-sourced KEY_RESOLVED events (${expectedProxy})`,
    );

    // R-1 (a) — only meaningful when at least one call returned a parsable
    // response. If all calls failed (e.g. proxy down in CI), the audit chain
    // is still asserted above; we just can't validate role suffixes on an
    // empty parallel_responses array, so skip and surface a warning instead
    // of failing — that's a provider-availability problem, not an R-1 regression.
    const responses = bos_output?.parallel_responses ?? [];
    if (received === 0) {
      console.log(`       (skipped role-suffix checks: 0 successful calls of ${REQUESTED_PARALLEL})`);
    } else {
      assert.ok(Array.isArray(responses), "bos_output.parallel_responses must be an array");
      assert.equal(responses.length, received, `parallel_responses length (${responses.length}) !== RECEIVED count (${received})`);
      const seenRoles = new Set();
      const expectedRoles = new Set(PARALLEL_ROLES.slice(0, REQUESTED_PARALLEL));
      for (const r of responses) {
        const m = String(r.model).match(ROLE_SUFFIX_RE);
        assert.ok(m, `parallel response model lacks role suffix: ${r.model}`);
        const role = m[1];
        assert.ok(PARALLEL_ROLES.includes(role), `unknown role in suffix: ${role}`);
        assert.ok(!seenRoles.has(role), `role ${role} appeared twice; assignRoles should be unique for N<=5`);
        assert.ok(expectedRoles.has(role), `role ${role} not in expected first ${REQUESTED_PARALLEL} of PARALLEL_ROLES`);
        seenRoles.add(role);
      }

      // R-1 (b) cont: every PARALLEL_RESPONSE_RECEIVED references one of the
      // assigned roles in its message text. Catches drift if anyone reformats
      // the audit message and drops the role tag.
      const receivedRows = audit.filter((a) => a.event_type === "PARALLEL_RESPONSE_RECEIVED");
      for (const row of receivedRows) {
        const found = PARALLEL_ROLES.find((r) => row.message?.startsWith(`${r} via `));
        assert.ok(found, `PARALLEL_RESPONSE_RECEIVED message missing role prefix: ${row.message}`);
      }

      // MERGE_COMPLETED only fires when at least one response made it through.
      assert.equal(countEvents(audit, "MERGE_COMPLETED"), 1, "expected exactly 1 MERGE_COMPLETED");
    }

    // Sanity: foundational events are always present regardless of provider success.
    assert.ok(audit.some((a) => a.event_type === "MODEL_SELECTED"));
    assert.ok(audit.some((a) => a.event_type === "TASK_RECEIVED"));
    assert.ok(
      audit.some((a) => a.event_type === "TASK_COMPLETED" || a.event_type === "TASK_HELD"),
      "expected a terminal TASK_COMPLETED or TASK_HELD event",
    );
  });

  // ---------------- Configuration B: parallel_models=1 downgrade ----------------
  await test("parallel_models=1: MODE_DOWNGRADED fires + no role overlay events", async () => {
    const { detail } = await submitTask({
      input: "What is 5 + 5? Respond briefly.",
      mode: "parallel",
      parallel_models: 1,
    });
    const { task, audit, bos_output } = detail;

    // The whole point of the N=1 downgrade is to make the effective mode
    // honest in the task row, not just in the audit chain.
    assert.equal(task.mode, "single", `expected mode to be downgraded to single, got ${task.mode}`);

    // Exactly one MODE_DOWNGRADED event with from=parallel, to=single.
    const downgrades = audit.filter((a) => a.event_type === "MODE_DOWNGRADED");
    assert.equal(downgrades.length, 1, `expected exactly 1 MODE_DOWNGRADED, got ${downgrades.length}`);
    const meta = parseMetadata(downgrades[0].metadata);
    assert.ok(meta && typeof meta === "object", "MODE_DOWNGRADED must have structured metadata");
    assert.equal(meta.from, "parallel", `downgrade.from expected 'parallel', got ${meta.from}`);
    assert.equal(meta.to, "single", `downgrade.to expected 'single', got ${meta.to}`);
    assert.equal(meta.effective_count, 1, `downgrade.effective_count expected 1, got ${meta.effective_count}`);

    // No parallel_responses on the merged output once we've downgraded.
    assert.ok(!bos_output?.parallel_responses, "downgraded task should not carry parallel_responses");

    // None of the parallel-only events may appear.
    for (const ev of PARALLEL_ONLY_EVENTS) {
      assert.equal(countEvents(audit, ev), 0, `downgraded run leaked parallel-only event: ${ev}`);
    }

    // The single-shot path still fires its own LLM_CALL_STARTED + KEY_RESOLVED
    // chain; without those, the downgrade fired but no work happened.
    assert.ok(countEvents(audit, "LLM_CALL_STARTED") >= 1, "downgraded run should produce >=1 LLM_CALL_STARTED");
    assert.ok(countEvents(audit, "KEY_RESOLVED") >= 1, "downgraded run should produce >=1 KEY_RESOLVED");
  });

  // ---------------- Configuration C: single mode ----------------
  await test("single mode: no role overlay events + no parallel_responses", async () => {
    const { detail } = await submitTask({
      input: "What is 7 + 7? Respond briefly.",
      mode: "single",
    });
    const { task, audit, bos_output } = detail;

    assert.equal(task.mode, "single");
    assert.ok(!bos_output?.parallel_responses, "single-mode bos_output must not carry parallel_responses");
    assert.ok(!bos_output?.merge_strategy, "single-mode bos_output must not carry merge_strategy");

    // Single-mode runs must NEVER emit any of the role-overlay / merge events.
    // This is the canary for "someone accidentally invoked executeParallel
    // for a single-mode dispatch".
    const types = eventTypes(audit);
    for (const ev of PARALLEL_ONLY_EVENTS) {
      assert.ok(!types.includes(ev), `single mode leaked parallel-only event: ${ev}`);
    }
    assert.equal(countEvents(audit, "MODE_DOWNGRADED"), 0, "single mode should not downgrade");

    // The single path still records the call in the audit chain.
    assert.ok(countEvents(audit, "LLM_CALL_STARTED") >= 1, "single mode should emit LLM_CALL_STARTED");
    assert.ok(countEvents(audit, "KEY_RESOLVED") >= 1, "single mode should emit KEY_RESOLVED");
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("e2e harness crashed:", err);
  process.exit(1);
});
