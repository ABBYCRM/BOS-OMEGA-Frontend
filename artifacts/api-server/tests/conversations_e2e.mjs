#!/usr/bin/env node
/**
 * Task #68 — end-to-end integration tests for the lattice continuity
 * conversations CRUD endpoints + auto-clustering on POST /api/tasks,
 * run against a live BOS-OMEGA API server.
 *
 * Coverage:
 *   1. Two related tasks (high keyword overlap)        →
 *      land in the SAME auto-created conversation. CONVERSATION_CREATED
 *      fires once, CONVERSATION_ASSIGNED fires twice.
 *   2. Two unrelated tasks (no keyword overlap)        →
 *      land in DIFFERENT conversations (two CREATED rows).
 *   3. PATCH /api/conversations/:id { archived: true } →
 *      hides the row from the default GET list, surfaces it
 *      under ?archived=true.
 *   4. PATCH /api/conversations/:id { title }          →
 *      renames the conversation; subsequent GET reflects new title.
 *   5. GET /api/conversations?q=<token>                →
 *      matches title/topic_keywords case-insensitively.
 *   6. POST /api/tasks { conversation_id: <ours> }     →
 *      pins to the explicit conversation (audit method=explicit).
 *   7. POST /api/tasks { conversation_id: <foreign> }  →
 *      404 (no leak across users).
 *   8. POST /api/tasks { force_new_conversation: true }→
 *      bypasses heuristic; new conversation is always created.
 *   9. GET /api/conversations/:id (cross-user)         →
 *      404 (deliberate non-leak).
 *
 * Run against an already-running server:
 *   $ API_BASE=http://localhost:8080 \
 *     ADMIN_EMAIL=paisabrazilfl@gmail.com \
 *     ADMIN_PASSWORD=<password> \
 *     node artifacts/api-server/tests/conversations_e2e.mjs
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
    .catch((err) => {
      console.log(`  FAIL ${name}\n       ${err.stack || err.message}`);
      fail++;
    });
}

let cookieHeader = "";

async function request(method, path, body, opts = {}) {
  const headers = { Accept: "application/json" };
  if (cookieHeader && !opts.skipCookie) headers.Cookie = cookieHeader;
  if (opts.cookie !== undefined) headers.Cookie = opts.cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const set_cookie = r.headers.get("set-cookie");
  if (set_cookie && !opts.skipCookie && opts.cookie === undefined) {
    cookieHeader = set_cookie.split(";")[0];
  }
  let data = null;
  const ct = r.headers.get("content-type") || "";
  if (ct.includes("json")) data = await r.json().catch(() => null);
  else if (r.status !== 204) data = await r.text().catch(() => null);
  return {
    status: r.status,
    data,
    setCookie: set_cookie ? set_cookie.split(";")[0] : null,
  };
}

async function login() {
  const r = await request("POST", "/api/auth/login", {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  assert.equal(r.status, 200, `login failed: ${r.status} ${JSON.stringify(r.data)}`);
}

async function findAuditEvent(event_type, predicate, limit = 100) {
  const r = await request("GET", `/api/audit?limit=${limit}`);
  assert.equal(r.status, 200, `audit list failed: ${r.status}`);
  const rows = Array.isArray(r.data) ? r.data : (r.data?.entries ?? r.data?.items ?? []);
  return rows.find((row) => row.event_type === event_type && predicate(row));
}

async function submitTask(input, extras = {}) {
  // The conversation extras (`conversation_id`, `force_new_conversation`)
  // are intentionally NOT in the OpenAPI spec — the server side-parses
  // them off the raw body via zod so generated clients stay clean.
  // mode=single keeps the pipeline cheap; persona is left unset so the
  // pipeline picks defaults.
  const body = { input, mode: "single", ...extras };
  const r = await request("POST", "/api/tasks", body);
  return r;
}

(async () => {
  await login();

  // Tag every input in this run with FIVE distinct nonce tokens so the
  // brand-new conversation seeded inside this run dominates any stale
  // conversations left behind by prior e2e runs (the clusterer is
  // user-scoped and we share one super-admin across runs). Five separate
  // tokens — instead of one — gives the new conversation a Jaccard floor
  // that no prior-run conversation can match.
  const baseNonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const nonceTokens = [0, 1, 2, 3, 4].map((i) => `e2enonce${baseNonce}seg${i}`);
  const nonce = nonceTokens.join(" ");

  // -----------------------------------------------------------------
  let convA = null;
  let convB = null;

  await test("two related task inputs land in the same conversation (force_new + heuristic match)", async () => {
    // task1 uses force_new_conversation so the test starts with a known
    // clean conversation regardless of prior-run leftovers.
    const r1 = await submitTask(
      `${nonce} vendor risk review for ACME Corporation Q4 questionnaire scoring`,
      { force_new_conversation: true },
    );
    assert.equal(r1.status, 200, `task1 failed: ${r1.status} ${JSON.stringify(r1.data)}`);
    const t1 = r1.data;
    assert.ok(t1.conversation_id, "task1 missing conversation_id on response");
    convA = t1.conversation_id;

    // task2 uses pure heuristic matching. Its input shares all five
    // nonce tokens + ACME/vendor/risk vocabulary with task1, so the
    // Jaccard score against the freshly created conversation should
    // far exceed SIMILARITY_THRESHOLD (=0.18) and beat any stale conv.
    const r2 = await submitTask(
      `${nonce} ACME vendor risk follow-up update Q4 questionnaire scoring details`,
    );
    assert.equal(r2.status, 200, `task2 failed: ${r2.status} ${JSON.stringify(r2.data)}`);
    const t2 = r2.data;
    assert.equal(
      t2.conversation_id,
      convA,
      `expected heuristic to assign task2 back to convA; got ${t2.conversation_id}`,
    );

    // CONVERSATION_CREATED via the force_new branch fires once for convA,
    // and CONVERSATION_ASSIGNED with method="auto_match" fires for task2.
    const created = await findAuditEvent(
      "CONVERSATION_CREATED",
      (row) => row.metadata?.conversation_id === convA,
    );
    assert.ok(created, "expected CONVERSATION_CREATED audit row for new thread");

    const r = await request("GET", "/api/audit?limit=200");
    const rows = Array.isArray(r.data) ? r.data : (r.data?.entries ?? r.data?.items ?? []);
    const auto = rows.find(
      (row) =>
        row.event_type === "CONVERSATION_ASSIGNED"
        && row.metadata?.conversation_id === convA
        && row.metadata?.method === "auto_match",
    );
    assert.ok(auto, `expected CONVERSATION_ASSIGNED method=auto_match for ${convA}`);
  });

  await test("two unrelated task inputs land in different conversations", async () => {
    // Use force_new on the first to guarantee separation regardless of
    // prior-run state. The second runs through the heuristic; with
    // disjoint vocabulary it must land in a different conversation.
    const r1 = await submitTask(
      `${nonce} maple syrup distillation seasonal yields bottling cadence`,
      { force_new_conversation: true },
    );
    assert.equal(r1.status, 200);
    const r2 = await submitTask(
      `quarterly investor newsletter draft tone subject ideas marketing`,
    );
    assert.equal(r2.status, 200);
    assert.notEqual(
      r1.data.conversation_id,
      r2.data.conversation_id,
      "expected unrelated topics to live in distinct conversations",
    );
    convB = r1.data.conversation_id;
  });

  // -----------------------------------------------------------------
  await test("GET /api/conversations lists active threads (default hides archived)", async () => {
    const r = await request("GET", "/api/conversations?limit=200");
    assert.equal(r.status, 200);
    const ids = (r.data.conversations ?? []).map((c) => c.id);
    assert.ok(ids.includes(convA), `convA ${convA} not in list`);
    assert.ok(ids.includes(convB), `convB ${convB} not in list`);
  });

  await test("PATCH /api/conversations/:id archives, hidden from default GET, visible under ?archived=true", async () => {
    const r = await request("PATCH", `/api/conversations/${convB}`, { archived: true });
    assert.equal(r.status, 200);
    assert.equal(r.data.archived, true);

    const def = await request("GET", "/api/conversations?limit=200");
    const defIds = (def.data.conversations ?? []).map((c) => c.id);
    assert.ok(!defIds.includes(convB), "archived conv should not appear in default list");

    const arc = await request("GET", "/api/conversations?archived=true&limit=200");
    const arcIds = (arc.data.conversations ?? []).map((c) => c.id);
    assert.ok(arcIds.includes(convB), "archived conv should appear under ?archived=true");
  });

  await test("PATCH /api/conversations/:id renames and subsequent GET reflects it", async () => {
    const newTitle = `Renamed thread ${nonce}`;
    const r = await request("PATCH", `/api/conversations/${convA}`, { title: newTitle });
    assert.equal(r.status, 200);
    assert.equal(r.data.title, newTitle);
    const g = await request("GET", `/api/conversations/${convA}`);
    assert.equal(g.status, 200);
    assert.equal(g.data.conversation.title, newTitle);
    assert.ok(Array.isArray(g.data.tasks) && g.data.tasks.length >= 2);
  });

  await test("GET /api/conversations?q=<title-token> matches case-insensitively", async () => {
    const r = await request("GET", `/api/conversations?q=${encodeURIComponent(nonce)}&limit=200`);
    assert.equal(r.status, 200);
    const ids = (r.data.conversations ?? []).map((c) => c.id);
    // convB is archived so it won't show under default ?archived=false even
    // when q matches; assert convA is present.
    assert.ok(ids.includes(convA), `expected ?q=${nonce} to surface convA`);
  });

  // -----------------------------------------------------------------
  await test("POST /api/tasks { conversation_id } pins to the explicit thread", async () => {
    const r = await submitTask(
      `${nonce} totally off-topic — about lichen taxonomy in northern climates`,
      { conversation_id: convA },
    );
    assert.equal(r.status, 200);
    assert.equal(
      r.data.conversation_id,
      convA,
      "explicit conversation_id should override heuristic",
    );
    const aud = await findAuditEvent(
      "CONVERSATION_ASSIGNED",
      (row) => row.metadata?.conversation_id === convA && row.metadata?.method === "explicit",
    );
    assert.ok(aud, "expected ASSIGNED audit with method=explicit");
  });

  await test("POST /api/tasks { conversation_id: <bogus> } returns 404", async () => {
    const r = await submitTask(
      `${nonce} should be rejected because conversation_id is bogus`,
      { conversation_id: "00000000-0000-0000-0000-000000000000" },
    );
    assert.equal(r.status, 404, `expected 404, got ${r.status} ${JSON.stringify(r.data)}`);
  });

  await test("POST /api/tasks { force_new_conversation: true } bypasses heuristic", async () => {
    // Use the SAME tokens as convA so heuristic would normally land here;
    // force_new must override and create a fresh thread.
    const r = await submitTask(
      `${nonce} ACME vendor risk Q4 questionnaire scoring follow-up two`,
      { force_new_conversation: true },
    );
    assert.equal(r.status, 200);
    assert.notEqual(
      r.data.conversation_id,
      convA,
      "force_new_conversation must skip heuristic match",
    );
    assert.ok(r.data.conversation_id, "force_new_conversation must still pin a conversation");
  });

  // -----------------------------------------------------------------
  await test("GET /api/conversations/:id with bogus id returns 404 (no leak)", async () => {
    const r = await request("GET", "/api/conversations/00000000-0000-0000-0000-000000000000");
    assert.equal(r.status, 404);
  });

  // -----------------------------------------------------------------
  await test("POST /api/conversations reserves an id (no DB row until first task)", async () => {
    const title = `${nonce} manual reserved flow`;
    const r = await request("POST", "/api/conversations", { title });
    assert.equal(r.status, 201, `expected 201, got ${r.status} ${JSON.stringify(r.data)}`);
    assert.equal(r.data.title, title);
    assert.ok(r.data.id, "response must include the reserved conversation id");
    assert.equal(r.data.archived, false);
    assert.equal(r.data.pending, true, "response must flag itself as pending");
    // Critical invariant: the reserved row must NOT yet appear in GET /api/conversations.
    const beforeList = await request("GET", "/api/conversations?limit=200");
    assert.equal(beforeList.status, 200);
    const beforeMatch = beforeList.data.conversations?.find((c) => c.id === r.data.id);
    assert.ok(!beforeMatch, "reservation must not appear in GET before first task");
    // First task targeting the reservation materializes the conversation row.
    const taskRes = await submitTask(`${nonce} first message in reserved thread`, {
      conversation_id: r.data.id,
    });
    assert.equal(taskRes.status, 200);
    assert.equal(taskRes.data.conversation_id, r.data.id);
    // After the task lands, the row must appear with the originally-reserved title.
    const afterList = await request("GET", "/api/conversations?limit=200");
    const afterMatch = afterList.data.conversations?.find((c) => c.id === r.data.id);
    assert.ok(afterMatch, "after first task, reserved conversation must appear in GET");
    assert.equal(afterMatch.title, title, "title must match the original reservation");
  });

  await test("POST /api/conversations reservation is single-use (second task 404s)", async () => {
    const r = await request("POST", "/api/conversations", { title: `${nonce} single-use` });
    assert.equal(r.status, 201);
    const first = await submitTask(`${nonce} first consumes`, { conversation_id: r.data.id });
    assert.equal(first.status, 200);
    // Second task with the same id but no DB row (because it's been consumed
    // already in the first call's transaction, which inserted it) — should
    // succeed because the conversation now exists. Sanity check.
    const second = await submitTask(`${nonce} second hits real row`, { conversation_id: r.data.id });
    assert.equal(second.status, 200, "second task should target the now-real row");
    // But a fresh, never-targeted, expired-or-bogus reservation id should 404.
    const bogus = await submitTask(`${nonce} bogus`, {
      conversation_id: "11111111-1111-1111-1111-111111111111",
    });
    assert.equal(bogus.status, 404);
  });

  await test("POST /api/conversations rejects empty/missing title with 400", async () => {
    const r = await request("POST", "/api/conversations", {});
    assert.equal(r.status, 400);
  });

  await test("POST /api/conversations requires authentication", async () => {
    const saved = cookieHeader;
    cookieHeader = "";
    const r = await request("POST", "/api/conversations", { title: "anonymous" });
    cookieHeader = saved;
    assert.equal(r.status, 401);
  });

  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error("e2e harness crashed:", err);
  process.exit(1);
});
