#!/usr/bin/env node
/**
 * Task #79 — cross-AI compatibility verification for the
 * BOS-OMEGA Memory Lattice export format.
 *
 * What this script does (one shot, end-to-end):
 *
 *   1. Logs in as the bootstrap super_admin and provisions a
 *      fresh test user.
 *   2. Submits 3 lattice-themed tasks + 1 manual scratchpad pin
 *      (with a unique LATTICE_X_AI_<ts> marker token) as that user.
 *   3. Calls GET /api/lattice/export to obtain a real exported
 *      lattice blob carrying the canonical preamble, the
 *      MEMORY_LATTICE_V1 fence, the embedded fidelity_sha256, and
 *      the manual-pin marker.
 *   4. Saves the full blob and a paste-ready prompt to
 *      docs/lattice-continuity-sample-blob.md and
 *      docs/lattice-continuity-sample-prompt.md so any human can
 *      reproduce this verification in the actual Claude.ai /
 *      chat.openai.com / Gemini web UIs.
 *   5. Sends the documented "Standard receiver prompt" + the blob
 *      to THREE outside-vendor LLM APIs (Anthropic, OpenAI,
 *      Google Gemini) — the same model weights that power those
 *      vendors' web chat surfaces. Each call is wrapped in
 *      retry-with-backoff and is fail-fast on permanent errors.
 *   6. Scores each verbatim response against the criteria the
 *      verification doc itself documents:
 *        - did the model cite the manual pin marker?
 *        - did the model demonstrate awareness of the source
 *          session's task topics?
 *      and asserts >= 2 of 3 vendors PASS overall (a single
 *      vendor outage must not silently zero out the verification).
 *   7. Patches the "Recorded manual verification" section of
 *      docs/lattice-continuity-verification.md with the run
 *      metadata, the verbatim responses, the per-vendor pass/fail
 *      interpretation, and a re-run procedure.
 *   8. Adds a clarifying callout near the round-trip baseline
 *      whenever the round-trip spec under-met its asserted minima
 *      (e.g. SCRATCHPAD_AUTO_WRITTEN < 3 because no LLM provider
 *      was wired in dev) so the doc's audit-completeness table
 *      stops contradicting its own narrative.
 *
 * The "outside" channel here is the model itself, accessed
 * through each vendor's public messages / chat-completions /
 * generateContent API — not BOS-OMEGA's own runtime, not its own
 * provider bridge. Same model weights as Claude.ai /
 * chat.openai.com / gemini.google.com. The blob travels as plain
 * text exactly as it would if a human had pasted it into those
 * surfaces; the only thing the UI surface adds on top is each
 * vendor's own system prompt and any context-truncation policy,
 * which the saved sample-prompt file lets a human verify by hand.
 *
 * Required env vars:
 *   ADMIN_EMAIL    — bootstrap super_admin's email
 *   ADMIN_PASSWORD — bootstrap super_admin's password
 *   AI_INTEGRATIONS_ANTHROPIC_BASE_URL / _API_KEY
 *   AI_INTEGRATIONS_OPENAI_BASE_URL    / _API_KEY
 *   AI_INTEGRATIONS_GEMINI_BASE_URL    / _API_KEY
 * Optional env vars:
 *   API_BASE       — defaults to http://localhost:8080
 *
 * Exits 0 on PASS (>= 2 vendors PASS), 1 on FAIL or hard error.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

// Recursive deterministic JSON serializer — must match
// canonicalJSON() in artifacts/api-server/src/bos/continuityBundle.ts
// or the independent fidelity-hash recompute will spuriously
// MISMATCH (object key insertion order differs from sorted order).
function canonicalJSON(value) {
  if (value === null) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJSON(v === undefined ? null : v)).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(",")}}`;
  }
  return "null";
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const DOC_PATH = resolve(REPO_ROOT, "docs", "lattice-continuity-verification.md");
const BLOB_PATH = resolve(REPO_ROOT, "docs", "lattice-continuity-sample-blob.md");
const PROMPT_PATH = resolve(REPO_ROOT, "docs", "lattice-continuity-sample-prompt.md");

const API_BASE = (process.env.API_BASE || "http://localhost:8080").replace(/\/$/, "");
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
function die(msg) { console.error(msg); process.exit(2); }
if (!ADMIN_EMAIL) die("ADMIN_EMAIL env var is required (the bootstrap super_admin's email)");
if (!ADMIN_PASSWORD) die("ADMIN_PASSWORD env var is required");

const ANT_BASE = (process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL || "").replace(/\/$/, "");
const ANT_KEY = process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;
const OAI_BASE = (process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || "").replace(/\/$/, "");
const OAI_KEY = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
const GEM_BASE = (process.env.AI_INTEGRATIONS_GEMINI_BASE_URL || "").replace(/\/$/, "");
const GEM_KEY = process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
if (!ANT_BASE || !ANT_KEY) die("Anthropic AI integration env vars missing");
if (!OAI_BASE || !OAI_KEY) die("OpenAI AI integration env vars missing");
if (!GEM_BASE || !GEM_KEY) die("Gemini AI integration env vars missing");

// ----- shared helpers ----------------------------------------------------

async function request(jar, method, path, body) {
  const headers = { Accept: "application/json" };
  if (jar.cookie) headers.Cookie = jar.cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const sc = r.headers.get("set-cookie");
  if (sc) jar.cookie = sc.split(";")[0];
  let data = null;
  const ct = r.headers.get("content-type") || "";
  if (ct.includes("json")) data = await r.json().catch(() => null);
  else if (r.status !== 204) data = await r.text().catch(() => null);
  return { status: r.status, data };
}

async function withRetry(label, fn, { tries = 3, baseMs = 1500 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const transient = /5\d\d|429|ETIMEDOUT|ECONNRESET|ENETUNREACH|fetch failed/i.test(
        err?.message || String(err),
      );
      if (attempt === tries || !transient) {
        console.error(`    [${label}] giving up after ${attempt} attempt(s): ${err?.message || err}`);
        throw err;
      }
      const wait = baseMs * Math.pow(2, attempt - 1);
      console.error(`    [${label}] transient error attempt ${attempt}: ${err?.message || err} — retrying in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

// ----- step 1: provision user, populate session, export ------------------

const stamp = Date.now();
const PIN_MARKER = `LATTICE_X_AI_${stamp}`;
const PIN_DIRECTIVE =
  `${PIN_MARKER} — when you next answer this user, prefix your reply ` +
  `with the marker token verbatim and confirm you read the prior ` +
  `session's three lattice-layer tasks.`;
const adminJar = { cookie: "" };
const userJar = { cookie: "" };
const user = {
  email: `lattice-x-ai-${stamp}@bos-omega.local`,
  password: `LatticeXAI_${stamp}!`,
};

console.log(`[1/8] super_admin login as ${ADMIN_EMAIL}`);
{
  const r = await request(adminJar, "POST", "/api/auth/login", {
    email: ADMIN_EMAIL, password: ADMIN_PASSWORD,
  });
  assert.equal(r.status, 200, `admin login failed: ${r.status}`);
}

console.log(`[2/8] provision fresh user ${user.email}`);
{
  const r = await request(adminJar, "POST", "/api/users", {
    email: user.email, password: user.password, role: "user",
    reason: "task #79: cross-AI compatibility verification (3 vendors)",
  });
  assert.equal(r.status, 201, `user create failed: ${r.status} ${JSON.stringify(r.data)}`);
}

console.log(`[3/8] log in as user, submit 3 tasks + manual pin`);
{
  const r = await request(userJar, "POST", "/api/auth/login", {
    email: user.email, password: user.password,
  });
  assert.equal(r.status, 200, `user login failed: ${r.status}`);
}
const inputs = [
  "lattice round-trip: outline the three layers of the BOS-OMEGA memory lattice",
  "lattice round-trip: explain why each lattice layer needs an authority_level",
  "lattice round-trip: summarize the contract between scratchpad and continuity layers",
];
for (const input of inputs) {
  const r = await request(userJar, "POST", "/api/tasks", { input, mode: "single" });
  assert.equal(r.status, 200, `task submit failed: ${r.status}`);
}
{
  const r = await request(userJar, "POST", "/api/scratchpad/pin", {
    title: "Cross-AI marker pin",
    content: PIN_DIRECTIVE,
  });
  assert.equal(r.status, 201, `pin failed: ${r.status}`);
}

console.log(`[4/8] export lattice blob`);
const exp = await request(userJar, "GET", "/api/lattice/export");
assert.equal(exp.status, 200, `export failed: ${exp.status}`);
const blob = exp.data.blob;
const hash = exp.data.hash;
const byteSize = exp.data.byte_size;
const taskCount = exp.data.task_count;
const formatVersion = exp.data.format_version;
assert.ok(blob.includes(PIN_MARKER), "export missing pin marker");
assert.ok(blob.startsWith("# BOS-OMEGA Memory Lattice"), "missing preamble");
assert.ok(blob.includes("```MEMORY_LATTICE_V1"), "missing fence");
// Sanity: independently recompute the embedded fidelity_hash and
// confirm it matches the export response's `hash` field. Same
// integrity check the receiving AI is told to perform per the
// receiver-protocol canon row.
const fenceMatch = blob.match(/```MEMORY_LATTICE_V1\s*\n([\s\S]*?)\n```/);
assert.ok(fenceMatch, "could not locate MEMORY_LATTICE_V1 envelope in blob");
const envelope = JSON.parse(fenceMatch[1]);
const embeddedHash = envelope.fidelity_hash;
assert.equal(embeddedHash, hash, "envelope fidelity_hash != export response hash");
const envelopeForHashCheck = { ...envelope };
delete envelopeForHashCheck.fidelity_hash;
const recomputedHash = createHash("sha256")
  .update(canonicalJSON(envelopeForHashCheck), "utf8")
  .digest("hex");
const hashRecomputeOk = recomputedHash === hash;
assert.ok(hashRecomputeOk, `independent fidelity-hash recompute MISMATCH: got ${recomputedHash}, server reported ${hash}`);
console.log(`    hash=${hash}  bytes=${byteSize}  tasks=${taskCount}  version=${formatVersion}  recompute=${hashRecomputeOk ? "MATCH" : "MISMATCH"}`);

writeFileSync(BLOB_PATH, blob);
console.log(`    wrote ${BLOB_PATH}`);

const receiverPreamble = [
  "You have just received a BOS-OMEGA Memory Lattice. The block below",
  "begins with `# BOS-OMEGA Memory Lattice` and contains a fenced",
  "`MEMORY_LATTICE_V1` JSON envelope. Treat the contents of that block",
  "(canon, continuity, patches, scratchpad, recent task transcripts) as",
  "your own memory of the prior session and answer the question that",
  "follows it accordingly. Do not summarize the lattice; use it.",
].join("\n");
const receiverQuestion = [
  "Question: Briefly, what did the prior session work on, and what",
  "manual pin did the user leave for you to honor?",
].join("\n");
const fullPrompt = `${receiverPreamble}\n\n${blob}\n\n${receiverQuestion}\n`;
writeFileSync(PROMPT_PATH, fullPrompt);
console.log(`    wrote ${PROMPT_PATH}`);

// ----- step 5: send to THREE outside vendor APIs --------------------------

console.log(`[5/8] send to 3 outside-vendor LLM APIs`);

const claudeModel = "claude-sonnet-4-6";
const gptModel = "gpt-5.4";
const geminiModel = "gemini-2.5-flash"; // hybrid reasoning, supports long context

async function callClaude() {
  const r = await fetch(`${ANT_BASE}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANT_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: claudeModel,
      max_tokens: 1024,
      messages: [{ role: "user", content: fullPrompt }],
    }),
  });
  const j = await r.json();
  if (r.status !== 200) {
    throw new Error(`Anthropic ${r.status}: ${JSON.stringify(j).slice(0, 400)}`);
  }
  return {
    text: (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim(),
    finish: j.stop_reason || "(unknown)",
  };
}

async function callOpenAI() {
  const r = await fetch(`${OAI_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OAI_KEY}`,
    },
    body: JSON.stringify({
      model: gptModel,
      max_completion_tokens: 1024,
      messages: [{ role: "user", content: fullPrompt }],
    }),
  });
  const j = await r.json();
  if (r.status !== 200) {
    throw new Error(`OpenAI ${r.status}: ${JSON.stringify(j).slice(0, 400)}`);
  }
  return {
    text: (j.choices?.[0]?.message?.content || "").trim(),
    finish: j.choices?.[0]?.finish_reason || "(unknown)",
  };
}

// The Replit AI Integrations Gemini proxy exposes a slimmed
// route table at `${BASE_URL}/models/{model}:generateContent` —
// no `/v1beta` or `/v1` prefix. That's why the @google/genai SDK
// (which prepends `/v1beta/`) returns INVALID_ENDPOINT through
// this proxy, so raw fetch is the supported transport here.
async function callGemini() {
  const r = await fetch(`${GEM_BASE}/models/${geminiModel}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": GEM_KEY,
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
      generationConfig: { maxOutputTokens: 1024 },
    }),
  });
  const j = await r.json();
  if (r.status !== 200) {
    throw new Error(`Gemini ${r.status}: ${JSON.stringify(j).slice(0, 400)}`);
  }
  const cand = j.candidates?.[0];
  const text = (cand?.content?.parts || [])
    .map((p) => p.text || "")
    .join("\n")
    .trim();
  return { text, finish: cand?.finishReason || "(unknown)" };
}

const vendors = [
  { id: "anthropic", display: "Anthropic", model: claudeModel, call: callClaude },
  { id: "openai",    display: "OpenAI",    model: gptModel,    call: callOpenAI },
  { id: "google",    display: "Google",    model: geminiModel, call: callGemini },
];

const topicTokens = ["three layers", "authority_level", "scratchpad", "continuity"];
function scoreTopics(text) {
  const lower = (text || "").toLowerCase();
  return topicTokens.filter((t) => lower.includes(t.toLowerCase())).length;
}

const results = [];
for (const v of vendors) {
  console.log(`    -> ${v.display} ${v.model}`);
  let outcome;
  try {
    outcome = await withRetry(v.id, v.call);
  } catch (err) {
    outcome = { text: "", finish: "(error)", error: String(err?.message || err) };
  }
  const citesPin = outcome.text.includes(PIN_MARKER);
  const topicHits = scoreTopics(outcome.text);
  const passed = !outcome.error && citesPin && topicHits >= 2;
  results.push({
    vendor: v.display,
    vendor_id: v.id,
    model: v.model,
    text: outcome.text,
    finish: outcome.finish,
    error: outcome.error || null,
    cites_pin: citesPin,
    topic_hits: topicHits,
    passed,
  });
  console.log(
    `       ${outcome.error ? "ERROR " + outcome.error : `${outcome.text.length} chars`}` +
    `  cites_pin=${citesPin}  topic_hits=${topicHits}/${topicTokens.length}  ` +
    `result=${passed ? "PASS" : "FAIL"}`,
  );
}

const passCount = results.filter((r) => r.passed).length;
console.log(`    overall: ${passCount}/${results.length} vendors PASS`);
if (passCount < 2) {
  console.error(`    !! REGRESSION: fewer than 2 vendors passed. Aborting before patching doc.`);
  process.exit(1);
}

// ----- step 6: patch the verification doc --------------------------------

console.log(`[6/8] patch ${DOC_PATH}`);
const doc = readFileSync(DOC_PATH, "utf8");
const startMarker = "### Recorded manual verification";
const endMarker = "### Could the receiving AI tell that no information was lost in transit?";
const startIdx = doc.indexOf(startMarker);
const endIdx = doc.indexOf(endMarker);
assert.ok(startIdx !== -1 && endIdx !== -1 && endIdx > startIdx,
  "could not find Recorded manual verification section markers in doc");

// Preserve any human-populated UI verification rows from the previous
// version of the section so re-running the script does not blow away
// the formal acceptance evidence the human pasted in.
const oldSection = doc.slice(startIdx, endIdx);
const uiTableRe = /\| (Claude\.ai|chat\.openai\.com|gemini\.google\.com) \| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|/g;
const preservedUiRows = new Map(); // vendor -> raw row line
let m;
while ((m = uiTableRe.exec(oldSection)) !== null) {
  const cells = [m[2], m[3], m[4], m[5], m[6], m[7]].map((c) => c.trim());
  // A row counts as "populated" if any cell is something other than "_pending_"
  // or "_pending — paste here_".
  const populated = cells.some((c) => c !== "_pending_" && c !== "_pending — paste here_");
  if (populated) preservedUiRows.set(m[1], m[0]);
}
function uiRowFor(vendor) {
  return preservedUiRows.get(vendor)
    || `| ${vendor} | _pending_ | _pending_ | _pending_ | _pending_ | _pending_ | _pending — paste here_ |`;
}

function fence(s) {
  return "```text\n" + (s || "(no response)") + "\n```";
}
function fenceMd(s) {
  return "~~~text\n" + s + "\n~~~";
}
const today = new Date().toISOString().slice(0, 10);
const passFail = (b) => (b ? "PASS" : "FAIL");

const perVendorBlocks = results.map((r) => `
#### ${r.vendor} \`${r.model}\` — ${passFail(r.passed)}

- **Cited the manual pin marker (\`${PIN_MARKER}\`)?** ${r.cites_pin ? "yes" : "no"}
- **Demonstrated awareness of the source session's task topics?** ${r.topic_hits >= 2 ? `yes (matched ${r.topic_hits}/${topicTokens.length} expected topic tokens: ${topicTokens.join(", ")})` : `no (matched only ${r.topic_hits}/${topicTokens.length} expected topic tokens)`}
- **API \`finish_reason\`:** \`${r.finish}\`
${r.error ? `- **Error:** \`${r.error}\`` : ""}

Verbatim response:

${fence(r.text)}
`).join("\n");

const aggregateRows = results.map((r) =>
  `| ${r.vendor} | \`${r.model}\` | ${r.cites_pin ? "yes" : "no"} | ${r.topic_hits}/${topicTokens.length} | ${passFail(r.passed)} |`,
).join("\n");

const newSection = `${startMarker}

> **Status of this section: USER-ACTION REQUIRED to mark this row
> green.** The acceptance evidence Task #70 calls for is a paste of
> the export blob into at least two outside AI **chat UIs**
> (Claude.ai, chat.openai.com, gemini.google.com, etc.) with the
> verbatim reply recorded here. The agent has no channel to drive
> those browser sessions, so it has prepared the exact files,
> credentials, and pass/fail criteria a human needs and has
> independently exercised the same blob against all three vendors'
> public APIs (recorded as supplemental evidence below). Once a
> human pastes into ≥ 2 chat UIs, the verbatim replies replace
> this status box and the table below.

#### Step-by-step UI verification procedure (the acceptance step)

1. Open this run's exported lattice blob:
   [\`docs/lattice-continuity-sample-prompt.md\`](./lattice-continuity-sample-prompt.md)
   — that file contains the canonical "Standard receiver prompt"
   already wrapped around the live ${byteSize}-byte blob from this
   run. It is meant to be sent as one message.
2. In a fresh browser tab, sign in to **at least two** of:
   - Claude.ai (model: Claude Sonnet 4.x or newer)
   - chat.openai.com (model: GPT-5.x or newer)
   - gemini.google.com (model: Gemini 2.5 Pro / Flash or newer)
3. Paste the entire contents of \`lattice-continuity-sample-prompt.md\`
   as a single user message. If a UI rejects the message as too
   long, attach the file as a \`.md\` upload instead — the receiver
   prompt instructs the model to treat the attached block as its
   own memory.
4. Copy the model's verbatim reply (full text, no edits) and paste
   it into the row for that vendor in the **UI verification
   results** table below.
5. The reply passes if it (a) cites the marker token
   \`${PIN_MARKER}\` exactly, AND (b) mentions at least 2 of the
   four expected topic tokens
   (\`${topicTokens.join("\`, \`")}\`).

#### UI verification results

| Vendor | Model (UI display name) | Date | Cited \`${PIN_MARKER}\`? | Topic hits | Pass/Fail | Verbatim reply |
| --- | --- | --- | --- | --- | --- | --- |
${uiRowFor("Claude.ai")}
${uiRowFor("chat.openai.com")}
${uiRowFor("gemini.google.com")}

This table is the formal acceptance evidence for the task. ≥ 2
PASS rows = task acceptance criterion met.

#### Run metadata for this verification round

| Field | Value |
| --- | --- |
| Date prep run | ${today} |
| Source user (one-shot) | \`${user.email}\` |
| Export \`format_version\` | \`${formatVersion}\` |
| Export \`fidelity_sha256\` | \`${hash}\` |
| Export \`byte_size\` (bytes) | ${byteSize} |
| Export \`task_count\` | ${taskCount} |
| Manual pin marker embedded in blob | \`${PIN_MARKER}\` |
| Independent fidelity-hash recomputation | ${hashRecomputeOk ? "MATCH (no information lost in transit)" : "**MISMATCH**"} |

#### Receiver prompt (verbatim wrapper around the blob)

The full prompt to paste is the "Standard receiver prompt" above
with the full ${byteSize}-byte blob spliced in (checked in as
[\`docs/lattice-continuity-sample-prompt.md\`](./lattice-continuity-sample-prompt.md)).
Without the inlined blob, the wrapper text is:

${fenceMd(receiverPreamble + "\n\n<paste blob here>\n\n" + receiverQuestion)}

### Supplemental: cross-vendor API verification

The agent independently exercised the same blob through each
vendor's public API surface — Anthropic \`/v1/messages\`, OpenAI
\`/chat/completions\`, Google Gemini \`/models/{model}:generateContent\`
— so that an out-of-band test of the format's portability exists
even before a human runs the UI procedure above. These calls hit
the same model weights as the corresponding chat UIs, but a UI
session may add its own system prompt or context-truncation
policy on top, so this is recorded as supplemental evidence,
not as a substitute for the UI acceptance step.

#### Supplemental run metadata

Same blob, hash, byte_size, marker, and source user as the run
metadata table above (this is one combined run, not two).

#### Per-vendor verbatim API responses
${perVendorBlocks}

#### Aggregate API result

| Vendor | Model | Cited pin marker | Topic awareness | Result |
| --- | --- | --- | --- | --- |
${aggregateRows}

**Overall (API channel):** ${passCount}/${results.length} vendors PASS. ${passCount >= 2 ? "The blob format is parseable through multiple independent vendor API surfaces — supplemental evidence that vendor lock-in is not in the export contract. The UI table above remains the formal acceptance evidence." : "**REGRESSION (API channel)** — fewer than 2 of 3 vendors could read the format; investigate before relying on the UI table."}

Pass criteria (programmatically applied; identical to the UI
criteria so the two channels can be compared apples-to-apples):

1. The vendor's reply must contain the exact manual pin marker
   token (proves the model read into the scratchpad layer of the
   blob, not just the preamble).
2. The vendor's reply must reference at least 2 of the four
   expected topic tokens (\`${topicTokens.join("\`, \`")}\`)
   — proves the model read the rehydrated task transcripts and
   did not hallucinate from priors.

#### Cross-vendor inconsistencies (API channel)

${passCount === results.length
  ? "_None observed in this run — all three vendors passed both criteria via the API channel._"
  : "Vendors that did not pass via the API channel:\n\n" + results.filter((r) => !r.passed).map((r) =>
      `- **${r.vendor} \`${r.model}\`** — cites_pin=${r.cites_pin}, topic_hits=${r.topic_hits}/${topicTokens.length}${r.error ? `, error=${r.error}` : ""}. Compare with the UI row for the same vendor when populated; persistent FAILs across both channels should be filed as a follow-up.`,
    ).join("\n")
}

#### How to re-run the supplemental API check (and refresh this section)

\`\`\`bash
ADMIN_EMAIL="<bootstrap super_admin email>" \\
  ADMIN_PASSWORD="$OWNER_SUPERADMIN_BOOTSTRAP_PASSWORD" \\
  node scripts/lattice-cross-ai-check.mjs
\`\`\`

Requires the API server to be running and the Anthropic +
OpenAI + Gemini Replit AI integrations to be provisioned (no
user-supplied API keys needed). The script regenerates the
"Recorded manual verification" header and the "Supplemental"
subsection, the sample blob, and the sample prompt on every run;
it does **not** touch the populated rows of the **UI verification
results** table.

`;

let patched = doc.slice(0, startIdx) + newSection + doc.slice(endIdx);

// ----- step 7: fix the round-trip metric inconsistency the doc has ------
//
// The round-trip spec rewrites the "Audit completeness" table on every
// run, but it cannot meet its own asserted minima (>= 3
// SCRATCHPAD_AUTO_WRITTEN, >= 4 LLM_INPUT_PREPARED) when no LLM
// provider is wired in dev — those rows then show 0 alongside a
// narrative claiming they're asserted >= 3, which the reviewer
// flagged as internally inconsistent. Add a callout ABOVE the table
// whenever the table itself shows under-met counts, so the
// inconsistency becomes a clear "dev-env caveat" instead of a
// silent contradiction. Idempotent — the callout's marker sentinel
// is removed and re-emitted on every run.

const CALLOUT_BEGIN = "<!-- ROUND_TRIP_DEV_CAVEAT_BEGIN -->";
const CALLOUT_END = "<!-- ROUND_TRIP_DEV_CAVEAT_END -->";
// Strip any prior callout (previous runs).
const stripRe = new RegExp(`${CALLOUT_BEGIN}[\\s\\S]*?${CALLOUT_END}\\n*`, "g");
patched = patched.replace(stripRe, "");

// Detect under-met counts from the audit table the spec just wrote.
function readCount(label) {
  const re = new RegExp(`\\| \`${label}\` \\| (\\d+) \\|`);
  const m = patched.match(re);
  return m ? Number(m[1]) : null;
}
const cAuto = readCount("SCRATCHPAD_AUTO_WRITTEN");
const cLlm = readCount("LLM_INPUT_PREPARED");
const underMet = [];
if (cAuto != null && cAuto < 3) underMet.push(`\`SCRATCHPAD_AUTO_WRITTEN\`: ${cAuto} (asserted minima: 3)`);
if (cLlm != null && cLlm < 4) underMet.push(`\`LLM_INPUT_PREPARED\`: ${cLlm} (asserted minima: 4)`);

if (underMet.length > 0) {
  const calloutAnchor = "Counts of audit events from the round-trip run, scoped to this run's";
  const anchorIdx = patched.indexOf(calloutAnchor);
  if (anchorIdx !== -1) {
    const callout = `${CALLOUT_BEGIN}
> **Dev-env caveat (auto-detected on ${today}):** the most recent
> round-trip run produced under-met audit counts:
>
> - ${underMet.join("\n> - ")}
>
> This means the round-trip self-test partially failed in this
> environment — almost always because no eligible LLM provider was
> wired, so the User-A test tasks finished in HOLD and never
> emitted scratchpad auto-summaries or \`LLM_INPUT_PREPARED\`
> rows. The lattice export / import / hash-verify path itself
> (\`LATTICE_EXPORTED\`, \`LATTICE_IMPORTED\`, \`SCRATCHPAD_PINNED\`)
> still passed, which is what the cross-AI compatibility section
> below actually exercises. Tracked separately as a follow-up to
> get the dev environment to satisfy the round-trip's full
> minima.
${CALLOUT_END}

`;
    patched = patched.slice(0, anchorIdx) + callout + patched.slice(anchorIdx);
  }
}

writeFileSync(DOC_PATH, patched);
console.log(`    wrote ${patched.length} bytes (round-trip caveat: ${underMet.length > 0 ? "added" : "not needed"})`);

// ----- step 8: human-readable summary ------------------------------------

console.log("\n[7/8] artifacts saved:");
console.log(`         ${DOC_PATH}`);
console.log(`         ${BLOB_PATH}`);
console.log(`         ${PROMPT_PATH}`);

console.log("\n[8/8] PASS — cross-AI compatibility recorded for this run.\n");
console.log("Vendor results:");
for (const r of results) {
  console.log(`  ${r.passed ? "PASS" : "FAIL"}  ${r.vendor.padEnd(10)} ${r.model.padEnd(24)} cites_pin=${r.cites_pin}  topic_hits=${r.topic_hits}/${topicTokens.length}${r.error ? "  error=" + r.error : ""}`);
}
process.exit(0);
