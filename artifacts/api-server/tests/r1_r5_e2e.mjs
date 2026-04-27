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

// Task #55: per-session variant of `request` that does NOT touch the
// global `cookieHeader`. Used by the cross-user isolation tests so we can
// hold three concurrent sessions (admin + userA + userB) without one login
// stomping on another's cookie. The jar is mutated in place when the
// server returns a Set-Cookie header (e.g. on /api/auth/login) so callers
// can re-use the same jar across multiple requests for the same user.
async function requestWithJar(jar, method, path, body) {
  const headers = { "Content-Type": "application/json" };
  if (jar.cookie) headers["Cookie"] = jar.cookie;
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) {
    jar.cookie = setCookie.split(",").map((c) => c.split(";")[0].trim()).join("; ");
  }
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
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

  // ============================================================
  // BOP.CANON_GOVERNANCE.v1 — front door is observability only;
  // the engine is now invoked for every safe non-empty input. The
  // FRONT_DOOR_CLASSIFIED audit row is preserved as a signal but
  // no longer short-circuits the pipeline.
  // ============================================================
  await test("front door: greeting → FRONT_DOOR_CLASSIFIED audit fires AND engine IS invoked", async () => {
    const { detail } = await submitTask({ input: "hello", mode: "single" });
    const { audit } = detail;
    const types = eventTypes(audit);

    // Audit row is still emitted as a routing signal.
    const fdRows = audit.filter((a) => a.event_type === "FRONT_DOOR_CLASSIFIED");
    assert.equal(fdRows.length, 1, `expected 1 FRONT_DOOR_CLASSIFIED, got ${fdRows.length}`);
    const fdMeta = parseMetadata(fdRows[0].metadata);
    assert.equal(fdMeta.route, "GREETING", `expected route=GREETING, got ${fdMeta.route}`);
    assert.ok(typeof fdMeta.input_hash === "string" && fdMeta.input_hash.startsWith("sha256:"));

    // Engine MUST be invoked now — no front-door bypass. The pipeline
    // selects models, loads canon, and runs the engine even on greetings.
    assert.ok(types.includes("MODEL_SELECTED"), "engine must run for greetings now; MODEL_SELECTED missing");
    assert.ok(types.includes("CANON_HASH_LOGGED"), "canon hash must be logged for every model invocation");
    // Tri-State is recorded from MODEL output (display-only metadata),
    // not from the removed runtime evaluator.
    assert.ok(types.includes("TRI_STATE_RECORDED"), "TRI_STATE_RECORDED (model-output, display-only) must fire");
    assert.ok(!types.includes("TRI_STATE_EVALUATED"), "TRI_STATE_EVALUATED (runtime collapse) must NOT fire — gate was removed");
  });

  await test("front door: empty input → ABORT (invalid request) BEFORE engine; canon not loaded", async () => {
    const { detail } = await submitTask({ input: "", mode: "single" });
    const { audit, bos_output } = detail;
    const types = eventTypes(audit);
    // Empty input is the ONLY remaining input-gate ABORT branch besides safety.
    assert.equal(bos_output.state, "ABORT", `empty input should be ABORTed, got ${bos_output.state}`);
    // Engine path bypassed — canon is not loaded for an invalid request body.
    assert.ok(!types.includes("CANON_HASH_LOGGED"), "canon must not load for empty input");
    assert.ok(!types.includes("MODEL_SELECTED"), "no model should be selected for empty input");
  });

  await test("front door: under-specified ('this') → engine IS invoked; runtime no longer HOLDs on missing_info", async () => {
    const { detail } = await submitTask({ input: "this", mode: "single" });
    const { audit } = detail;
    const types = eventTypes(audit);
    // Under-specified inputs reach the model now. The model decides whether
    // to HOLD with a clarifying question (per Canon) or answer.
    assert.ok(types.includes("MODEL_SELECTED"), "model must be invoked for under-specified inputs");
    assert.ok(types.includes("CANON_HASH_LOGGED"), "canon must be logged");
    assert.ok(types.includes("TRI_STATE_RECORDED"), "tri-state must be recorded from model output");
  });

  await test("front door: VALID_TASK input reaches engine and records canon-governed tri-state", async () => {
    const { detail } = await submitTask({
      input: "Should we approve this vendor? Vendor: Acme Corp. Service: payment processing.",
      mode: "single",
    });
    const { audit } = detail;
    const types = eventTypes(audit);
    assert.ok(types.includes("INPUT_GATE_RESULT"), "engine path must fire INPUT_GATE_RESULT");
    assert.ok(types.includes("CANON_HASH_LOGGED"), "engine path must log canon hash");
    assert.ok(types.includes("TRI_STATE_RECORDED"), "engine path must record tri-state from model output");
    assert.ok(!types.includes("TRI_STATE_EVALUATED"), "runtime tri-state evaluator must be gone");
  });

  await test("front door audit metadata: input_hash + truncated preview present and bounded", async () => {
    const longInput = "Should we approve " + "x".repeat(500);
    const { detail } = await submitTask({ input: longInput, mode: "single" });
    const fdRows = detail.audit.filter((a) => a.event_type === "FRONT_DOOR_CLASSIFIED");
    assert.equal(fdRows.length, 1);
    const meta = parseMetadata(fdRows[0].metadata);
    assert.ok(typeof meta.input_hash === "string" && /^sha256:[0-9a-f]{16}$/.test(meta.input_hash));
    assert.ok(typeof meta.input_preview === "string");
    assert.ok(meta.input_preview.length <= 250, `preview too long: ${meta.input_preview.length}`);
    assert.equal(meta.input_truncated, true, "long input should be flagged truncated");
    assert.ok(meta.input_length >= 500);
  });

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

  // ---------------- #43: consensus mode ----------------
  // Live-API coverage of the consensus merge contract. The deterministic
  // ABORT-veto + selected-aborter rules are unit-tested directly against
  // mergeParallelResponses (r1_r5_unit.mjs); the e2e check below proves
  // those same rules survive the full pipeline + audit chain end-to-end.
  await test("consensus mode: merge_strategy=majority_vote_consensus + selected:true rules + audit chain identifies state per response", async () => {
    const REQUESTED_PARALLEL = 3;
    const { detail } = await submitTask({
      input: "What is 3 + 4? Respond briefly.",
      mode: "consensus",
      parallel_models: REQUESTED_PARALLEL,
    });
    const { task, audit, bos_output } = detail;
    assert.equal(task.mode, "consensus", "task.mode should remain consensus");
    assert.equal(countEvents(audit, "MODE_DOWNGRADED"), 0, "no downgrade should fire when N>=2");
    assert.equal(countEvents(audit, "PARALLEL_EXECUTION_STARTED"), 1, "consensus runs through executeParallel");

    const received = countEvents(audit, "PARALLEL_RESPONSE_RECEIVED");
    const failed = countEvents(audit, "PARALLEL_RESPONSE_FAILED");
    assert.equal(
      received + failed,
      REQUESTED_PARALLEL,
      `dispatched consensus calls (${received + failed}) !== requested (${REQUESTED_PARALLEL})`,
    );

    // Skip merge-strategy assertions if every call failed — the engine
    // returns buildSafeFailure() in that case, which has no merge_strategy
    // (and that's the correct behavior, not a regression).
    if (received === 0) {
      console.log(`       (skipped consensus merge checks: 0 successful calls of ${REQUESTED_PARALLEL})`);
      assert.equal(countEvents(audit, "TASK_HELD"), 1, "all-failed consensus should emit TASK_HELD");
      return;
    }

    // #43 acceptance criterion 1: merge_strategy === "majority_vote_consensus".
    assert.equal(
      bos_output?.merge_strategy,
      "majority_vote_consensus",
      `consensus mode must emit merge_strategy='majority_vote_consensus', got ${bos_output?.merge_strategy}`,
    );
    assert.equal(countEvents(audit, "MERGE_COMPLETED"), 1, "expected exactly 1 MERGE_COMPLETED");

    const responses = bos_output.parallel_responses || [];
    assert.equal(responses.length, received, `parallel_responses length (${responses.length}) !== RECEIVED (${received})`);

    // Exactly one response is selected — either the highest-confidence GO
    // (all-GO majority) or the actual aborter (any ABORT).
    const selected = responses.filter((r) => r.selected);
    assert.equal(selected.length, 1, `expected exactly 1 selected response, got ${selected.length}`);

    const abortResponses = responses.filter((r) => r.state === "ABORT");
    if (abortResponses.length > 0) {
      // #43 acceptance criterion 4 + 5: any ABORT response vetoes consensus
      // to ABORT, and the selected response is the aborter (so the audit
      // chain — via parallel_responses + the per-response RECEIVED events
      // with state metadata — identifies which row drove the merge to ABORT).
      assert.equal(bos_output.state, "ABORT", "any ABORT in responses should veto consensus to ABORT");
      assert.equal(selected[0].state, "ABORT", "the selected response must be the aborter, not the lowest-confidence row");
    } else if (bos_output.state === "GO") {
      // #43 acceptance criterion 2 + 3: all-GO consensus → state=GO and the
      // highest-confidence GO response is selected:true.
      const goResponses = responses.filter((r) => r.state === "GO");
      assert.ok(goResponses.length > 0, "state=GO requires at least one GO response");
      const maxConf = Math.max(...goResponses.map((r) => r.confidence_score));
      assert.equal(
        selected[0].confidence_score,
        maxConf,
        `selected response (conf=${selected[0].confidence_score}) must be the highest-confidence GO row (max=${maxConf})`,
      );
    }
    // (state === HOLD with no ABORTs is a valid path when GO didn't reach
    // majority — covered by the unit tests; nothing further to assert here.)

    // The audit chain identifies state-per-response via PARALLEL_RESPONSE_RECEIVED
    // metadata. Combined with bos_output.parallel_responses[].selected, an
    // operator can correlate which response drove the merge.
    const receivedRows = audit.filter((a) => a.event_type === "PARALLEL_RESPONSE_RECEIVED");
    for (const row of receivedRows) {
      const meta = parseMetadata(row.metadata);
      assert.ok(
        meta && typeof meta.state === "string" && ["GO", "HOLD", "ABORT"].includes(meta.state),
        `PARALLEL_RESPONSE_RECEIVED.metadata.state missing/invalid: ${JSON.stringify(meta)}`,
      );
    }
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

  // ---------------- #44: series_pass — happy-path audit chain + bos_output traces ----------------
  // Submits a series_pass task and asserts the full ordered audit chain
  // (SERIES_PASS_STARTED → 5×SERIES_PASS_STEP → SERIES_PASS_COMPLETED) plus
  // the bos_output structure (merge_strategy, parallel_responses with the
  // five SERIES_ROLES). Mock-mode/no-key environments may produce a
  // SERIES_PASS_DEGRADED outcome — covered as an alternative branch.
  await test("#44 series_pass: ordered audit chain (STARTED → 5×STEP → COMPLETED|DEGRADED) + bos_output step traces", async () => {
    const { detail } = await submitTask({
      input: "Briefly explain why 2+2=4.",
      mode: "series_pass",
    });
    const { task, audit, bos_output } = detail;
    assert.equal(task.mode, "series_pass", "task.mode should be series_pass");

    // If the engine downgraded (eligible_models<2), this case is covered
    // by the dedicated downgrade test below — bail out without failing.
    const dg = audit.find((a) => a.event_type === "MODE_DOWNGRADED");
    if (dg) {
      console.log("       (skipped series_pass happy-path: engine downgraded due to <2 eligible models — covered by downgrade test)");
      return;
    }

    assert.equal(countEvents(audit, "SERIES_PASS_STARTED"), 1, "expected exactly 1 SERIES_PASS_STARTED");

    // The five SERIES_ROLES emit five SERIES_PASS_STEP events in order.
    // We accept "<=5" because an early ABORT halts the chain (still valid
    // per acceptance criteria — the events that DO fire must be ordered).
    const stepCount = countEvents(audit, "SERIES_PASS_STEP");
    assert.ok(stepCount >= 1 && stepCount <= 5, `SERIES_PASS_STEP count ${stepCount} not in [1,5]`);

    // Ordering: STARTED comes before any STEP, and STEPs come before
    // COMPLETED|DEGRADED|ABORTED. We compare audit indices.
    const startedIdx = audit.findIndex((a) => a.event_type === "SERIES_PASS_STARTED");
    const firstStepIdx = audit.findIndex((a) => a.event_type === "SERIES_PASS_STEP");
    const lastStepIdx = audit.map((a) => a.event_type).lastIndexOf("SERIES_PASS_STEP");
    const terminalIdx = audit.findIndex((a) =>
      ["SERIES_PASS_COMPLETED", "SERIES_PASS_DEGRADED", "SERIES_PASS_ABORTED"].includes(a.event_type),
    );
    assert.ok(startedIdx < firstStepIdx, "SERIES_PASS_STARTED must precede first SERIES_PASS_STEP");
    assert.ok(terminalIdx > lastStepIdx, "terminal event must follow the last SERIES_PASS_STEP");

    // bos_output: when COMPLETED, merge_strategy is "series_pass_5_roles"
    // and parallel_responses carries one entry per executed pass with the
    // role suffix in role_overlay (e.g. "(CRITIC)"). When DEGRADED, those
    // fields may be absent — the audit chain alone proves coverage there.
    if (audit.some((a) => a.event_type === "SERIES_PASS_COMPLETED")) {
      assert.equal(
        bos_output?.merge_strategy,
        "series_pass_5_roles",
        `series_pass COMPLETED should emit merge_strategy='series_pass_5_roles', got ${bos_output?.merge_strategy}`,
      );
      const responses = bos_output.parallel_responses || [];
      assert.ok(responses.length >= 1, "COMPLETED series_pass should expose >=1 parallel_responses (step trace)");
      // Acceptance criterion: bos_output includes series_pass step traces.
      // seriesPassEngine attaches the role inside the model field as
      // "<provider/model> (ROLE)" — see seriesPassEngine.ts ~line 344.
      // SERIES_ROLES are DRAFTER, CRITIC, EXPANDER, ADVERSARY, SYNTHESIZER
      // (different from the R-1 PARALLEL_ROLES). We check both `model` and
      // `model_name` defensively because the API serializer name varies
      // across response shapes (single vs parallel vs series_pass).
      const ROLE_RE = /\((DRAFTER|CRITIC|EXPANDER|ADVERSARY|SYNTHESIZER)\)/;
      const allHaveRoleMarker = responses.every(
        (r) => ROLE_RE.test(`${r.model ?? ""}${r.model_name ?? ""}${r.role ?? ""}`),
      );
      assert.ok(
        allHaveRoleMarker,
        `every series_pass response must carry one of SERIES_ROLES (DRAFTER|CRITIC|EXPANDER|ADVERSARY|SYNTHESIZER); got: ${JSON.stringify(responses.map((r) => r.model ?? r.model_name ?? r.role))}`,
      );
    }
  });

  // ---------------- #44: series_pass downgrade (deterministic via DB toggle) ----------------
  // The acceptance criterion "series_pass with <2 eligible models downgrades
  // to single (MODE_DOWNGRADED from=series_pass to=single)" is non-deterministic
  // unless we control the eligible-model count. We snapshot llm_models.enabled,
  // disable all-but-one inside a try/finally, run the task, and restore — so
  // a crash mid-test cannot leave the registry in a degraded state.
  await test("#44 series_pass with <2 eligible models downgrades to single (MODE_DOWNGRADED from=series_pass to=single)", async () => {
    const { execSync } = await import("node:child_process");
    if (!process.env.DATABASE_URL) {
      console.log("       (skipped: DATABASE_URL not set — cannot toggle model registry)");
      return;
    }
    const psql = (sql) =>
      execSync(`psql "${process.env.DATABASE_URL}" -t -A -F$'\\t' -c ${JSON.stringify(sql)}`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });

    // Snapshot every (model_id, enabled) so we can restore exactly.
    const modelRows = psql("SELECT id, enabled FROM llm_models").trim().split("\n").filter(Boolean)
      .map((line) => { const [id, en] = line.split("\t"); return { id, enabled: en === "t" }; });
    const providerRows = psql("SELECT id, enabled FROM llm_providers").trim().split("\n").filter(Boolean)
      .map((line) => { const [id, en] = line.split("\t"); return { id, enabled: en === "t" }; });

    if (modelRows.length === 0 || providerRows.length === 0) {
      console.log("       (skipped: empty llm_models or llm_providers registry)");
      return;
    }

    // Pick one model+provider to keep; force every other model to enabled=false
    // and the keeper's provider to enabled=true. Health-state filtering
    // (OPEN_CIRCUIT) still applies, so we additionally clear the keeper's
    // health row if it's OPEN_CIRCUIT (HEALTHY default kicks in).
    const keeper = modelRows[0];
    const keeperProvider = psql(`SELECT provider_id FROM llm_models WHERE id = '${keeper.id}'`).trim();
    if (!keeperProvider) {
      console.log("       (skipped: keeper model has no provider — registry inconsistent)");
      return;
    }

    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      // Restore models
      for (const row of modelRows) {
        psql(`UPDATE llm_models SET enabled = ${row.enabled} WHERE id = '${row.id}'`);
      }
      // Restore providers
      for (const row of providerRows) {
        psql(`UPDATE llm_providers SET enabled = ${row.enabled} WHERE id = '${row.id}'`);
      }
    };

    try {
      // Disable all models except keeper, enable keeper's provider, clear
      // OPEN_CIRCUIT for keeper's provider so selectModel includes it.
      psql(`UPDATE llm_models SET enabled = false WHERE id <> '${keeper.id}'`);
      psql(`UPDATE llm_models SET enabled = true WHERE id = '${keeper.id}'`);
      psql(`UPDATE llm_providers SET enabled = true WHERE id = '${keeperProvider}'`);
      psql(`DELETE FROM provider_health WHERE provider_id = '${keeperProvider}' AND status = 'OPEN_CIRCUIT'`);

      const { detail } = await submitTask({ input: "anything", mode: "series_pass" });
      const { audit, task } = detail;
      assert.equal(task.mode, "series_pass", "task.mode should remain series_pass on the persisted task");

      const dg = audit.filter((a) => a.event_type === "MODE_DOWNGRADED");
      assert.ok(dg.length >= 1, `expected MODE_DOWNGRADED event(s); got events: ${JSON.stringify(eventTypes(audit))}`);
      const meta = parseMetadata(dg[0].metadata);
      assert.equal(meta?.from, "series_pass", `MODE_DOWNGRADED.metadata.from expected 'series_pass', got ${meta?.from}`);
      assert.equal(meta?.to, "single", `MODE_DOWNGRADED.metadata.to expected 'single', got ${meta?.to}`);
      assert.equal(meta?.eligible_models, 1, `MODE_DOWNGRADED.metadata.eligible_models expected 1, got ${meta?.eligible_models}`);

      // After downgrade, the engine must NOT emit series_pass-specific
      // events (no STEP/COMPLETED/DEGRADED) — it falls through to single.
      assert.equal(countEvents(audit, "SERIES_PASS_STEP"), 0, "downgraded series_pass should not emit STEP events");
      assert.equal(countEvents(audit, "SERIES_PASS_COMPLETED"), 0, "downgraded series_pass should not emit COMPLETED");
    } finally {
      restore();
    }
  });

  // ---------------- #44: boil_the_ocean — ordered audit chain + agent counts ----------------
  await test("#44 boil_the_ocean: ordered audit chain + bos_output exposes agent counts and synthesis trace", async () => {
    const { detail } = await submitTask({
      input: "Briefly explain why 2+2=4.",
      mode: "boil_the_ocean",
    });
    const { task, audit, bos_output } = detail;
    assert.equal(task.mode, "boil_the_ocean", "task.mode should be boil_the_ocean");

    // Required prefix of the BTO audit chain — these MUST be present in
    // this order regardless of mock-mode failures.
    const requiredPrefix = ["BTO_STARTED", "BTO_AGENTS_DISPATCHED", "BTO_AGENTS_COMPLETED"];
    let lastIdx = -1;
    for (const evt of requiredPrefix) {
      const idx = audit.findIndex((a, i) => i > lastIdx && a.event_type === evt);
      assert.ok(idx > lastIdx, `expected ${evt} after index ${lastIdx}; got events: ${JSON.stringify(eventTypes(audit))}`);
      lastIdx = idx;
    }

    // Agent counts: BTO_STARTED.metadata records total_agents; BTO_AGENTS_COMPLETED
    // records the X/Y string in its message. Both must be parseable.
    const startedMeta = parseMetadata(audit.find((a) => a.event_type === "BTO_STARTED").metadata);
    assert.ok(
      typeof startedMeta?.total_agents === "number" && startedMeta.total_agents > 0,
      `BTO_STARTED.metadata.total_agents must be a positive number; got ${JSON.stringify(startedMeta)}`,
    );
    const completedMsg = audit.find((a) => a.event_type === "BTO_AGENTS_COMPLETED").message ?? "";
    assert.ok(
      /^\d+\/\d+ agents succeeded/.test(completedMsg),
      `BTO_AGENTS_COMPLETED.message expected 'X/Y agents succeeded...', got '${completedMsg}'`,
    );

    // Terminal: when there's at least one successful agent, synthesis runs
    // and we see BTO_SYNTHESIS_STARTED → (COMPLETED|FAILED) → (BTO_COMPLETED|BTO_DEGRADED).
    // When zero agents succeed, we get BTO_DEGRADED directly (no synthesis).
    // We track `lastIdx` through every required step so the terminal-event
    // assertion at the end enforces strict ordering vs the LAST required
    // event, not just the prefix (architect medium-fix).
    const successCount = parseInt(completedMsg.split("/")[0], 10);
    if (successCount > 0) {
      const synStartIdx = audit.findIndex((a, i) => i > lastIdx && a.event_type === "BTO_SYNTHESIS_STARTED");
      assert.ok(synStartIdx > lastIdx, "BTO_SYNTHESIS_STARTED must follow BTO_AGENTS_COMPLETED when agents succeeded");
      lastIdx = synStartIdx;
      const synTerminalIdx = audit.findIndex(
        (a, i) => i > lastIdx && (a.event_type === "BTO_SYNTHESIS_COMPLETED" || a.event_type === "BTO_SYNTHESIS_FAILED"),
      );
      assert.ok(synTerminalIdx > lastIdx, "BTO_SYNTHESIS_COMPLETED|FAILED must follow BTO_SYNTHESIS_STARTED");
      lastIdx = synTerminalIdx;
    }

    const terminalIdx = audit.findIndex((a, i) =>
      i > lastIdx && ["BTO_COMPLETED", "BTO_DEGRADED", "BTO_ABORTED"].includes(a.event_type),
    );
    assert.ok(
      terminalIdx > lastIdx,
      `BTO_COMPLETED|DEGRADED|ABORTED must follow the synthesis terminal (lastIdx=${lastIdx}); got events: ${JSON.stringify(eventTypes(audit))}`,
    );

    // bos_output: when COMPLETED, the engine attaches the agent counts
    // (synthesis_metadata.successful_agents / total_agents) and a synthesis
    // trace. When DEGRADED, those fields may be absent — audit chain
    // already proved coverage above.
    if (audit.some((a) => a.event_type === "BTO_COMPLETED")) {
      const completedMeta = parseMetadata(audit.find((a) => a.event_type === "BTO_COMPLETED").metadata);
      assert.ok(
        typeof completedMeta?.agents === "string" && /^\d+\/\d+$/.test(completedMeta.agents),
        `BTO_COMPLETED.metadata.agents expected 'X/Y' string, got ${JSON.stringify(completedMeta)}`,
      );
      assert.ok(
        bos_output && typeof bos_output === "object",
        "BTO COMPLETED must attach a bos_output to the task",
      );
    }
  });

  // ---------------- Task #46: memory injection across ALL execution modes ----------------
  // Seeds a continuity-layer memory row, runs a task in every one of the 5
  // modes (single, parallel, consensus, series_pass, boil_the_ocean), and
  // asserts that the orchestrator emitted a MEMORY_INJECTED audit event in
  // each run whose persisted memory_context payload contains:
  //   (a) the "=== CONTINUITY ===" section header, and
  //   (b) the seeded item content (proves the relevance ranker actually
  //       selected the item for the elephant query, not just that some
  //       header was emitted).
  // This is the regression guard for the original bug: continuity + patches
  // were silently dropped from the executionEngine fetch, and series_pass /
  // boil_the_ocean fetched no memory at all.
  await test("#46 memory injection: MEMORY_INJECTED + continuity content reaches all 5 execution modes", async () => {
    // Seed a continuity row whose content the relevance ranker can match
    // against the task input ("elephants" in both — singular/plural variant
    // equivalence is unit-tested separately).
    const seedTitle = `task46-continuity-${Date.now()}`;
    const seeded = await request("POST", "/api/memory", {
      layer: "continuity",
      title: seedTitle,
      content: "Field log: we counted twelve elephants at the watering hole this morning.",
      authority_level: 9,
    });
    assert.ok(seeded?.id, `seed POST /api/memory must return an id; got ${JSON.stringify(seeded)}`);

    try {
      const modes = ["single", "parallel", "consensus", "series_pass", "boil_the_ocean"];
      for (const mode of modes) {
        const payload = { input: "How many elephants did we see today?", mode };
        if (mode === "parallel" || mode === "consensus") payload.parallel_models = 2;
        const { detail } = await submitTask(payload);
        const { audit } = detail;

        // (1) MEMORY_INJECTED must fire exactly once per task — emitted by
        // runBosPipeline immediately after building the four-layer context.
        const injectEvents = audit.filter((a) => a.event_type === "MEMORY_INJECTED");
        assert.equal(
          injectEvents.length,
          1,
          `[mode=${mode}] expected exactly 1 MEMORY_INJECTED event; got ${injectEvents.length}. Events: ${JSON.stringify(eventTypes(audit))}`,
        );

        const meta = parseMetadata(injectEvents[0].metadata);
        assert.ok(
          meta && typeof meta === "object",
          `[mode=${mode}] MEMORY_INJECTED.metadata must be a structured object`,
        );

        // (2) The continuity counter must reflect the seeded row reaching
        // the orchestrator's selectLayer call.
        assert.ok(
          typeof meta.continuity_items === "number" && meta.continuity_items >= 1,
          `[mode=${mode}] MEMORY_INJECTED.metadata.continuity_items expected >=1, got ${meta.continuity_items}`,
        );

        // (3) Audit metadata exposes section_headers (the rendered
        // `=== ... ===` section names found in the full memory_context).
        // We assert the CONTINUITY section was rendered — this is what
        // proves the seeded continuity row reached buildContextFromMemory
        // and was emitted into the model prompt. We assert against the
        // structured header list (not the truncated preview) because
        // canon's larger budget can otherwise bury later headers past the
        // preview window.
        const headers = Array.isArray(meta.section_headers) ? meta.section_headers : [];
        assert.ok(
          headers.includes("=== CONTINUITY ==="),
          `[mode=${mode}] section_headers missing '=== CONTINUITY ==='. Got: ${JSON.stringify(headers)}`,
        );
        // The total memory_context_chars must be > 0 (sanity: not just
        // a continuity-counter bug paired with an empty payload).
        assert.ok(
          typeof meta.memory_context_chars === "number" && meta.memory_context_chars > 0,
          `[mode=${mode}] memory_context_chars must be > 0; got ${meta.memory_context_chars}`,
        );

        // (4) MEMORY_INJECTED must precede every engine-dispatch event so
        // the engines actually receive the context, not get it post-hoc.
        const injectIdx = audit.findIndex((a) => a.event_type === "MEMORY_INJECTED");
        const dispatchEvents = [
          "LLM_CALL_STARTED",
          "PARALLEL_EXECUTION_STARTED",
          "SERIES_PASS_STARTED",
          "BTO_STARTED",
        ];
        for (const evt of dispatchEvents) {
          const evtIdx = audit.findIndex((a) => a.event_type === evt);
          if (evtIdx === -1) continue; // event not produced by this mode
          assert.ok(
            injectIdx < evtIdx,
            `[mode=${mode}] MEMORY_INJECTED (idx=${injectIdx}) must precede ${evt} (idx=${evtIdx}) so engines see ctx.memory_context`,
          );
        }

        // (5) Per-call provider evidence: every callProviderDirect now emits
        // LLM_INPUT_PREPARED with the actual memory_context payload that
        // reached the adapter. This is the strict regression guard the
        // reviewer asked for — it proves not just that the orchestrator
        // BUILT the context but that each engine THREADED it through to
        // every model invocation (BTO synthesis/adversarial, series_pass
        // per-step, parallel/consensus per-model). Audit-metadata-only
        // checks could otherwise mask an engine that fetched memory but
        // forgot to forward it.
        const inputEvents = audit.filter((a) => a.event_type === "LLM_INPUT_PREPARED");
        assert.ok(
          inputEvents.length >= 1,
          `[mode=${mode}] expected >=1 LLM_INPUT_PREPARED event; got ${inputEvents.length}. Events: ${JSON.stringify(eventTypes(audit))}`,
        );
        for (const ev of inputEvents) {
          const m = parseMetadata(ev.metadata);
          assert.ok(
            m && typeof m === "object",
            `[mode=${mode}] LLM_INPUT_PREPARED.metadata must be a structured object`,
          );
          assert.ok(
            typeof m.memory_context_chars === "number" && m.memory_context_chars > 0,
            `[mode=${mode}] LLM_INPUT_PREPARED.memory_context_chars must be > 0 for provider=${m.provider_name} model=${m.model}; got ${m.memory_context_chars}`,
          );
          const preview = typeof m.memory_context_preview === "string" ? m.memory_context_preview : "";
          assert.ok(
            preview.includes("=== CONTINUITY ===") && /elephant/i.test(preview),
            `[mode=${mode}] LLM_INPUT_PREPARED.memory_context_preview must contain '=== CONTINUITY ===' and the seeded 'elephant' content for provider=${m.provider_name} model=${m.model}; got: ${preview.slice(0, 400)}`,
          );
        }
      }
    } finally {
      // Cleanup the seeded row so repeated test runs don't accumulate.
      try {
        await request("DELETE", `/api/memory/${seeded.id}`, undefined);
      } catch (err) {
        console.log(`       (warn: failed to delete seeded memory ${seeded.id}: ${err.message})`);
      }
    }
  });

  // ---------------- Task #47: "Memory used" panel renderable payload ----------------
  // The TaskDetail "Memory used" panel renders directly off the
  // MEMORY_INJECTED audit metadata returned by GET /api/tasks/:id. To
  // guard against silent server-side regressions that would render the
  // panel blank (e.g. someone dropping a metadata field, or returning a
  // stringified blob instead of a structured object), this test asserts
  // that for at least one execution mode the API response contains every
  // field the panel reads. Per task spec it covers "at least one of the
  // five execution modes" — single is the cheapest and most stable.
  await test("#47 Memory used panel: GET /api/tasks/:id exposes per-layer counts, section list, and preview", async () => {
    const seedTitle = `task47-panel-${Date.now()}`;
    const seeded = await request("POST", "/api/memory", {
      layer: "continuity",
      title: seedTitle,
      content: "Field log: we counted twelve elephants at the watering hole this morning.",
      authority_level: 9,
    });
    assert.ok(seeded?.id, `seed POST /api/memory must return an id; got ${JSON.stringify(seeded)}`);

    try {
      const { detail } = await submitTask({
        input: "How many elephants did we see today?",
        mode: "single",
      });
      const { audit } = detail;

      const injectEvents = audit.filter((a) => a.event_type === "MEMORY_INJECTED");
      assert.equal(
        injectEvents.length,
        1,
        `expected exactly 1 MEMORY_INJECTED event; got ${injectEvents.length}`,
      );
      const meta = parseMetadata(injectEvents[0].metadata);
      assert.ok(
        meta && typeof meta === "object" && !Array.isArray(meta),
        `MEMORY_INJECTED.metadata must be a structured object the panel can read`,
      );

      // Per-layer counters — the panel renders one tile per layer.
      for (const key of [
        "canon_items",
        "continuity_items",
        "patches_items",
        "scratchpad_items",
      ]) {
        assert.ok(
          typeof meta[key] === "number" && meta[key] >= 0,
          `MEMORY_INJECTED.metadata.${key} must be a non-negative number for the panel; got ${typeof meta[key]} ${meta[key]}`,
        );
      }

      // Total chars badge in the panel header.
      assert.ok(
        typeof meta.memory_context_chars === "number" && meta.memory_context_chars > 0,
        `memory_context_chars must be a positive number; got ${meta.memory_context_chars}`,
      );

      // Section header chips — array of "=== NAME ===" strings.
      assert.ok(
        Array.isArray(meta.section_headers) && meta.section_headers.length > 0,
        `section_headers must be a non-empty array; got ${JSON.stringify(meta.section_headers)}`,
      );
      for (const h of meta.section_headers) {
        assert.ok(
          typeof h === "string" && /^=== [A-Z ]+ ===$/.test(h),
          `each section_headers entry must look like '=== NAME ==='; got ${JSON.stringify(h)}`,
        );
      }

      // Preview block — bounded string the panel renders verbatim.
      assert.ok(
        typeof meta.memory_context_preview === "string" && meta.memory_context_preview.length > 0,
        `memory_context_preview must be a non-empty string; got ${typeof meta.memory_context_preview}`,
      );

      // Task #50: per-item provenance — array of {id, layer, title} the
      // panel uses to render one clickable entry per injected memory row.
      // Without this field the panel can only show layer counts, leaving
      // the user unable to trace a snippet back to its source.
      assert.ok(
        Array.isArray(meta.injected_items),
        `injected_items must be an array on the audit metadata; got ${typeof meta.injected_items}`,
      );
      assert.ok(
        meta.injected_items.length > 0,
        `injected_items must be non-empty when continuity_items > 0; got ${JSON.stringify(meta.injected_items)}`,
      );
      const seededRef = meta.injected_items.find((it) => it && it.id === seeded.id);
      assert.ok(
        seededRef,
        `injected_items must include the seeded continuity row id (${seeded.id}); got ${JSON.stringify(meta.injected_items)}`,
      );
      assert.equal(
        seededRef.layer,
        "continuity",
        `injected_items entry must carry the source layer; got layer=${seededRef.layer}`,
      );
      assert.equal(
        seededRef.title,
        seedTitle,
        `injected_items entry must carry the source title verbatim; got title=${seededRef.title}`,
      );
    } finally {
      try {
        await request("DELETE", `/api/memory/${seeded.id}`, undefined);
      } catch (err) {
        console.log(`       (warn: failed to delete seeded memory ${seeded.id}: ${err.message})`);
      }
    }
  });

  // ---------------- Task #49: full memory_context endpoint contract ----------------
  // Locks in the contract for GET /api/tasks/:id/memory-context:
  //   1. Returns 200 with { memory_context, chars, truncated:false } for a
  //      task the requester can see.
  //   2. The returned text matches the orchestrator's recorded chars count
  //      and is at least as long as the bounded 8000-char preview that
  //      ships in the audit row.
  //   3. The same task fetched via GET /api/tasks/:id no longer carries the
  //      heavy memory_context_full field in its inline audit metadata
  //      (proves the strip-on-read is in place; without it, /:id responses
  //      would balloon by tens of KB per task).
  //   4. Returns 404 for an unknown task id (visibilityFilter blocks
  //      enumeration; super_admin sees real tasks but bogus ids are still
  //      404).
  await test("#49 memory-context endpoint: full payload, preview-strip on /:id, and 404 on unknown id", async () => {
    const seedTitle = `task49-fullctx-${Date.now()}`;
    const seeded = await request("POST", "/api/memory", {
      layer: "continuity",
      title: seedTitle,
      content: "Field log: we counted twelve elephants at the watering hole this morning.",
      authority_level: 9,
    });
    assert.ok(seeded?.id, `seed POST /api/memory must return an id; got ${JSON.stringify(seeded)}`);

    try {
      const { detail, created } = await submitTask({
        input: "How many elephants did we see today?",
        mode: "single",
      });

      // (3) /:id audit array MUST NOT carry the un-truncated full payload.
      const injected = detail.audit.find((a) => a.event_type === "MEMORY_INJECTED");
      assert.ok(injected, "/:id should still expose the MEMORY_INJECTED row");
      const inlineMeta = parseMetadata(injected.metadata) || {};
      assert.ok(
        !("memory_context_full" in inlineMeta),
        `/:id audit metadata must NOT contain memory_context_full (would inflate every TaskDetail load); got keys: ${Object.keys(inlineMeta).join(",")}`,
      );
      // Sanity: the recorded char count is preserved on the inline row so
      // the panel can decide whether the preview is truncated.
      assert.ok(
        typeof inlineMeta.memory_context_chars === "number" && inlineMeta.memory_context_chars > 0,
        `/:id audit metadata must preserve memory_context_chars; got ${inlineMeta.memory_context_chars}`,
      );
      const recordedChars = inlineMeta.memory_context_chars;
      const previewLen = (inlineMeta.memory_context_preview || "").length;

      // (1) Hit the new endpoint and validate the response shape.
      const full = await request("GET", `/api/tasks/${created.id}/memory-context`, undefined);
      assert.ok(
        typeof full?.memory_context === "string" && full.memory_context.length > 0,
        `memory-context must return a non-empty memory_context string; got ${JSON.stringify(full).slice(0, 200)}`,
      );
      assert.equal(typeof full.chars, "number", "chars must be a number");
      assert.equal(typeof full.truncated, "boolean", "truncated must be a boolean");

      // (2) Full payload covers the full recorded char count and is no
      // shorter than the preview.
      assert.equal(
        full.chars,
        recordedChars,
        `chars must match the orchestrator's recorded memory_context_chars; got ${full.chars} vs recorded ${recordedChars}`,
      );
      assert.equal(
        full.memory_context.length,
        recordedChars,
        `memory_context length (${full.memory_context.length}) must equal the recorded chars (${recordedChars}) — preview-only fallback would fail this`,
      );
      assert.ok(
        full.memory_context.length >= previewLen,
        `full memory_context must be at least as long as the inline preview (${previewLen}); got ${full.memory_context.length}`,
      );
      assert.equal(
        full.truncated,
        false,
        `truncated must be false for tasks created after Task #49 (full payload was persisted)`,
      );
      // The full payload must contain the seeded continuity content,
      // proving it really is the full text and not a truncated head.
      assert.ok(
        /elephant/i.test(full.memory_context),
        `full memory_context should contain the seeded 'elephant' content; got: ${full.memory_context.slice(0, 400)}`,
      );

      // (4) Unknown task id → 404. Use a syntactically valid uuid-ish
      // string so the route matches the :id param but the lookup misses.
      let notFoundOk = false;
      try {
        await request("GET", `/api/tasks/00000000-0000-0000-0000-000000000000/memory-context`, undefined);
      } catch (err) {
        notFoundOk = /\b404\b/.test(err.message);
        if (!notFoundOk) throw err;
      }
      assert.ok(notFoundOk, "GET memory-context on unknown task id must return 404");
    } finally {
      try {
        await request("DELETE", `/api/memory/${seeded.id}`, undefined);
      } catch (err) {
        console.log(`       (warn: failed to delete seeded memory ${seeded.id}: ${err.message})`);
      }
    }
  });

  // ---------------- Task #55: GET /:id/memory-context cross-user isolation ----------------
  // The handler in routes/tasks.ts reuses visibilityFilter() — the same
  // role-aware filter that gates GET /:id (super_admin sees everything;
  // everyone else sees own + legacy NULL rows). This test pins down the
  // contract end-to-end:
  //
  //   - Two non-super users (role="user") each create a task. The task
  //     row is stamped with the creator's user_id atomically inside the
  //     pipeline (see routes/tasks.ts: `user_id: req.user?.id ?? null`).
  //   - User A probing user B's task id MUST get a 404 (and vice versa).
  //     Anything else is a cross-tenant leak: another user's
  //     memory_context can contain proprietary continuity notes,
  //     attachments references, and patches that leak business data.
  //   - Each user MUST get 200 on their own task.
  //   - super_admin MUST get 200 on both task ids and the response shape
  //     MUST be exactly { memory_context, chars, truncated }.
  //
  // Without this test, a future refactor of visibilityFilter() (e.g.
  // someone widening the legacy NULL fallback or accidentally inverting
  // the role check) could quietly turn this endpoint into a leak vector
  // and the unit-level filter test would still pass.
  await test("#55 memory-context cross-user isolation: 404 across users, 200 for owner + super_admin, response shape", async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const userA = {
      email: `task55-usera-${stamp}@bos-omega.local`,
      password: `Task55_UserA_${stamp}!`,
    };
    const userB = {
      email: `task55-userb-${stamp}@bos-omega.local`,
      password: `Task55_UserB_${stamp}!`,
    };

    // (1) Create both non-super users via the super_admin-only POST /api/users.
    // The harness session is already logged in as ADMIN_EMAIL (super_admin).
    const createdA = await request("POST", "/api/users", {
      email: userA.email,
      password: userA.password,
      role: "user",
      reason: "task #55 e2e: cross-user memory-context isolation test",
    });
    const createdB = await request("POST", "/api/users", {
      email: userB.email,
      password: userB.password,
      role: "user",
      reason: "task #55 e2e: cross-user memory-context isolation test",
    });
    assert.equal(createdA.user.role, "user", "userA must be created as a non-super user");
    assert.equal(createdB.user.role, "user", "userB must be created as a non-super user");

    // (2) Independent cookie jars so admin/userA/userB sessions don't
    // stomp on each other. The harness's global cookieHeader still holds
    // the admin session for the final super_admin assertions below.
    const jarA = { cookie: "" };
    const jarB = { cookie: "" };
    const loginA = await requestWithJar(jarA, "POST", "/api/auth/login", {
      email: userA.email, password: userA.password,
    });
    assert.equal(loginA.status, 200, `userA login should return 200, got ${loginA.status}`);
    assert.ok(jarA.cookie.includes("bos_session="), "userA login must set bos_session cookie");
    const loginB = await requestWithJar(jarB, "POST", "/api/auth/login", {
      email: userB.email, password: userB.password,
    });
    assert.equal(loginB.status, 200, `userB login should return 200, got ${loginB.status}`);
    assert.ok(jarB.cookie.includes("bos_session="), "userB login must set bos_session cookie");

    // (3) Each user creates a task. The pipeline stamps user_id atomically
    // on insert, so visibilityFilter() will scope each task to its owner.
    // We use simple "single" mode tasks so this test stays cheap and is
    // not at the mercy of provider availability for the leak assertion —
    // even if the model call degrades, the task row + MEMORY_INJECTED
    // audit row are still written before any LLM call returns.
    const taskARes = await requestWithJar(jarA, "POST", "/api/tasks", {
      input: "task55 userA: what is 1+1?", mode: "single",
    });
    assert.equal(taskARes.status, 200, `userA task create should return 200, got ${taskARes.status}: ${JSON.stringify(taskARes.data).slice(0, 200)}`);
    const taskAId = taskARes.data?.id;
    assert.ok(taskAId, `userA task must have an id, got ${JSON.stringify(taskARes.data).slice(0, 200)}`);

    const taskBRes = await requestWithJar(jarB, "POST", "/api/tasks", {
      input: "task55 userB: what is 2+2?", mode: "single",
    });
    assert.equal(taskBRes.status, 200, `userB task create should return 200, got ${taskBRes.status}: ${JSON.stringify(taskBRes.data).slice(0, 200)}`);
    const taskBId = taskBRes.data?.id;
    assert.ok(taskBId, `userB task must have an id, got ${JSON.stringify(taskBRes.data).slice(0, 200)}`);
    assert.notEqual(taskAId, taskBId, "userA and userB should have distinct task ids");

    // (4) Owner-side sanity: each user MUST be able to read their own
    // task's memory-context. If this fails, the cross-user 404 below
    // would be testing the wrong thing (it'd just mean nobody can read
    // it). The shape check is repeated for super_admin below; here we
    // only need to confirm the request succeeds for the owner.
    const ownAonA = await requestWithJar(jarA, "GET", `/api/tasks/${taskAId}/memory-context`);
    assert.equal(ownAonA.status, 200, `userA reading own task memory-context should be 200, got ${ownAonA.status}`);
    const ownBonB = await requestWithJar(jarB, "GET", `/api/tasks/${taskBId}/memory-context`);
    assert.equal(ownBonB.status, 200, `userB reading own task memory-context should be 200, got ${ownBonB.status}`);

    // (5) THE LEAK CHECK. userA probing userB's task id (and vice versa)
    // MUST get 404. NOT 403 — visibilityFilter intentionally returns 404
    // so non-super users can't enumerate the existence of other users'
    // task ids. A 200 here would mean the un-truncated memory_context of
    // another user's task leaked through; a 500 would mean the route
    // crashed instead of denying access (also a regression).
    const aProbesB = await requestWithJar(jarA, "GET", `/api/tasks/${taskBId}/memory-context`);
    assert.equal(
      aProbesB.status,
      404,
      `LEAK: userA reading userB's memory-context returned ${aProbesB.status}, expected 404. body=${JSON.stringify(aProbesB.data).slice(0, 300)}`,
    );
    assert.ok(
      !aProbesB.data || !aProbesB.data.memory_context,
      `LEAK: userA's 404 response leaked memory_context payload: ${JSON.stringify(aProbesB.data).slice(0, 300)}`,
    );
    const bProbesA = await requestWithJar(jarB, "GET", `/api/tasks/${taskAId}/memory-context`);
    assert.equal(
      bProbesA.status,
      404,
      `LEAK: userB reading userA's memory-context returned ${bProbesA.status}, expected 404. body=${JSON.stringify(bProbesA.data).slice(0, 300)}`,
    );
    assert.ok(
      !bProbesA.data || !bProbesA.data.memory_context,
      `LEAK: userB's 404 response leaked memory_context payload: ${JSON.stringify(bProbesA.data).slice(0, 300)}`,
    );

    // (6) super_admin (the harness's global session) MUST get 200 on both
    // task ids — proves visibility is wider for super_admin and the
    // route's final response really is { memory_context, chars, truncated }.
    // We assert exact shape (no extra keys leak through) so the contract
    // documented in routes/tasks.ts is locked in.
    const adminOnA = await request("GET", `/api/tasks/${taskAId}/memory-context`, undefined);
    const adminOnB = await request("GET", `/api/tasks/${taskBId}/memory-context`, undefined);
    for (const [label, body] of [["taskA", adminOnA], ["taskB", adminOnB]]) {
      assert.ok(body && typeof body === "object", `super_admin ${label} response must be an object`);
      assert.equal(typeof body.memory_context, "string", `super_admin ${label}: memory_context must be a string`);
      assert.equal(typeof body.chars, "number", `super_admin ${label}: chars must be a number`);
      assert.equal(typeof body.truncated, "boolean", `super_admin ${label}: truncated must be a boolean`);
      // Lock the response shape exactly so a future field addition forces
      // a deliberate test update (and thus a code review of what new
      // data we're about to ship to clients).
      const keys = Object.keys(body).sort();
      assert.deepEqual(
        keys,
        ["chars", "memory_context", "truncated"],
        `super_admin ${label}: response shape must be exactly {memory_context, chars, truncated}; got keys=${keys.join(",")}`,
      );
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("e2e harness crashed:", err);
  process.exit(1);
});
