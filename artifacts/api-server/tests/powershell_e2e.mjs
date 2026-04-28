#!/usr/bin/env node
/**
 * End-to-end test for the POST /api/powershell host-command surface.
 *
 * The companion file `tests/powershell_unit.mjs` only exercises the
 * in-process runPowerShell helper. THIS test exercises the full HTTP
 * stack — auth gate, role gate, env-flag gate, body-size cap, and the
 * audit-row shape on both the success and failure execution paths.
 *
 * The four gate states:
 *
 *   1. Anonymous  → 401 UNAUTHENTICATED  (requireAuth never reached)
 *   2. admin role → 403 FORBIDDEN        (requireRole rejects non-super)
 *   3. super_admin, POWERSHELL_ENDPOINT_ENABLED unset → 404 POWERSHELL_DISABLED
 *   4. super_admin, flag on, body > 4 KB → 413 COMMAND_TOO_LARGE
 *      super_admin, flag on, valid command → 200 + POWERSHELL_EXECUTED audit row
 *      super_admin, flag on, failing command → 500 + POWERSHELL_FAILED audit row
 *
 * Both audit rows must carry `command_sha256` (full sha256 of the
 * raw command bytes) and `command_bytes` (UTF-8 byte length).
 *
 * The test is fully self-contained:
 *   - Spawns the prebuilt API server twice (once without the flag, once
 *     with it) on a free port using the harness pattern from
 *     `tests/run-r1-r5-e2e.mjs`.
 *   - Drops a fake `pwsh` shim into a temp directory and prepends it to
 *     PATH for the second spawn so the success path can be exercised
 *     in CI environments that don't have a real PowerShell binary.
 *
 * Usage:
 *   $ DATABASE_URL=postgres://… node tests/powershell_e2e.mjs
 *
 * Required env when spawning:
 *   - DATABASE_URL — Postgres URL the API server will seed and query.
 * Optional env when spawning:
 *   - PORT (defaults to a random free port)
 *   - SESSION_SECRET (defaults to an ephemeral 32+ char per-run value)
 *   - ADMIN_EMAIL (defaults to admin@bos-omega.local)
 *   - ADMIN_PASSWORD (defaults to BosOmegaTestAdmin_2026!)
 *   - REBUILD=1 — force a fresh `pnpm run build` even if dist/ already
 *     exists (recommended in CI so we never test a stale binary).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_DIR = path.resolve(HERE, "..");
const DIST = path.join(API_DIR, "dist", "index.mjs");

// ----------------------------------------------------------------------
// Harness plumbing (mirrors run-r1-r5-e2e.mjs).
// ----------------------------------------------------------------------

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(base, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/healthz`);
      if (res.ok) return;
      lastErr = new Error(`healthz status ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`API server did not become healthy in ${timeoutMs}ms: ${lastErr?.message ?? "unknown"}`);
}

function runChild(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function buildIfNeeded() {
  const force = process.env.REBUILD === "1";
  if (existsSync(DIST) && !force) return;
  console.log(`[harness] ${force ? "REBUILD=1 — rebuilding" : "dist/ missing — building"}…`);
  const code = await runChild("pnpm", ["run", "build"], { cwd: API_DIR });
  if (code !== 0) throw new Error(`build failed with exit code ${code}`);
}

async function spawnServer(extraEnv) {
  const port = await pickFreePort();
  const base = `http://127.0.0.1:${port}`;
  const sessionSecret = process.env.SESSION_SECRET
    || `pwsh-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}-padding-padding`;
  const adminPassword = process.env.ADMIN_PASSWORD || "BosOmegaTestAdmin_2026!";
  const nodeEnv = process.env.NODE_ENV || "development";
  const serverEnv = {
    ...process.env,
    PORT: String(port),
    SESSION_SECRET: sessionSecret,
    ADMIN_PASSWORD: adminPassword,
    NODE_ENV: nodeEnv,
    ...extraEnv,
  };
  console.log(`[harness] spawning API server on ${base} (POWERSHELL_ENDPOINT_ENABLED=${serverEnv.POWERSHELL_ENDPOINT_ENABLED ?? "<unset>"})`);
  const server = spawn(process.execPath, ["--enable-source-maps", DIST], {
    env: serverEnv,
    stdio: ["ignore", "inherit", "inherit"],
  });
  let serverExit = null;
  server.on("exit", (code, signal) => {
    serverExit = { code, signal };
    console.log(`[harness] server exited code=${code} signal=${signal}`);
  });
  const stop = async () => {
    if (server.exitCode === null && !server.killed) {
      try { server.kill("SIGTERM"); } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 250));
      if (server.exitCode === null) {
        try { server.kill("SIGKILL"); } catch { /* ignore */ }
      }
    }
  };
  try {
    await waitForHealth(base, 30_000);
  } catch (err) {
    await stop();
    throw err;
  }
  if (serverExit) {
    throw new Error("server exited before tests started");
  }
  return { base, stop, adminPassword };
}

// ----------------------------------------------------------------------
// Fake `pwsh` shim. runPowerShell.ts spawns the binary by name so any
// executable on PATH wins. The shim is intentionally minimal:
//   - "echo test" (the probe runPowerShell uses to discover a usable
//     binary) prints "test" and exits 0.
//   - Anything containing "FAIL_PLEASE" exits 2 to drive the failure
//     path that emits POWERSHELL_FAILED.
//   - Everything else echoes its `-Command` argument and exits 0,
//     which is what the success path asserts against.
// We point the shim at process.execPath (Node) so we don't depend on
// `/usr/bin/env` or any specific shell being available.
// ----------------------------------------------------------------------

function createFakePwshDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "pwsh-e2e-shim-"));
  // The sh wrapper just forwards every argument to node so we don't have to
  // worry about shebang length limits or sh quoting rules around the embedded
  // JS source.
  const shim = path.join(dir, "pwsh");
  const jsFile = path.join(dir, "pwsh.js");
  const wrapper = `#!/bin/sh
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(jsFile)} "$@"
`;
  // The shim is invoked as `pwsh -Command "<cmd>"` (see runPowerShell.ts), so
  // we look up the command argument by name rather than by position.
  const js = `'use strict';
const args = process.argv.slice(2);
const idx = args.indexOf('-Command');
const cmd = idx >= 0 ? (args[idx + 1] || '') : '';
if (cmd === 'echo test') { console.log('test'); process.exit(0); }
if (cmd.indexOf('FAIL_PLEASE') !== -1) { console.error('fake pwsh failure'); process.exit(2); }
console.log(cmd);
process.exit(0);
`;
  writeFileSync(shim, wrapper);
  writeFileSync(jsFile, js);
  chmodSync(shim, 0o755);
  return dir;
}

// ----------------------------------------------------------------------
// HTTP helpers — each test holds its own cookie jar so the four roles
// don't bleed into each other.
// ----------------------------------------------------------------------

function makeClient(base) {
  let cookieHeader = "";
  async function request(method, path, body) {
    const headers = { "Content-Type": "application/json" };
    if (cookieHeader) headers["Cookie"] = cookieHeader;
    const res = await fetch(`${base}${path}`, {
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
  return { request, get cookie() { return cookieHeader; } };
}

async function login(client, email, password) {
  const { res, data } = await client.request("POST", "/api/auth/login", { email, password });
  if (!res.ok) {
    throw new Error(`login ${email} → ${res.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  }
  if (!client.cookie.includes("bos_session=")) {
    throw new Error(`login ${email} succeeded but no session cookie captured`);
  }
}

// ----------------------------------------------------------------------
// Test runner.
// ----------------------------------------------------------------------

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
    pass++;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.stack || err.message}`);
    fail++;
  }
}

// Find the most recent audit row of `eventType` in the visible audit log.
// super_admin sees every row (audit.ts audienceFilter), so this is reliable.
//
// powershell.ts uses `void auditLog(...)` (fire-and-forget), so the row can
// still be in flight when the HTTP response arrives. We poll for up to ~3 s
// before giving up, which is well within normal latency for an in-process
// Drizzle insert and avoids flaking on slow CI.
async function findLatestAuditRow(adminClient, eventType, predicate) {
  const deadline = Date.now() + 3000;
  let lastEntries = [];
  while (Date.now() < deadline) {
    const { res, data } = await adminClient.request("GET", "/api/audit?limit=50");
    assert.equal(res.status, 200, `GET /api/audit → ${res.status}`);
    const entries = Array.isArray(data) ? data : (data?.entries ?? []);
    lastEntries = entries;
    const matches = entries.filter((row) => row.event_type === eventType
      && (!predicate || predicate(row)));
    if (matches.length > 0) return matches[0]; // ordered desc by created_at
    await new Promise((r) => setTimeout(r, 100));
  }
  const seen = lastEntries.filter((r) => r.event_type === eventType).length;
  throw new Error(
    `no ${eventType} row matching predicate found within 3s (saw ${seen} ${eventType} rows total in latest 50)`,
  );
}

function assertAuditCommandFingerprint(row, { expectedSha256, expectedBytes, label }) {
  assert.ok(row.metadata && typeof row.metadata === "object",
    `${label}: audit row metadata must be an object`);
  const meta = row.metadata;
  assert.equal(typeof meta.command_sha256, "string",
    `${label}: command_sha256 must be a string`);
  assert.match(meta.command_sha256, /^[0-9a-f]{64}$/,
    `${label}: command_sha256 must be a 64-char hex SHA-256, got ${meta.command_sha256}`);
  if (expectedSha256) {
    assert.equal(meta.command_sha256, expectedSha256,
      `${label}: command_sha256 must match the SHA-256 of the submitted command`);
  }
  assert.equal(typeof meta.command_bytes, "number",
    `${label}: command_bytes must be a number`);
  if (expectedBytes !== undefined) {
    assert.equal(meta.command_bytes, expectedBytes,
      `${label}: command_bytes must equal the UTF-8 byte length of the submitted command`);
  }
}

async function sha256Hex(s) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(s, "utf8").digest("hex");
}

// ----------------------------------------------------------------------
// Phase A — server WITHOUT POWERSHELL_ENDPOINT_ENABLED. Covers the
// anonymous, regular-admin, and super-admin-flag-off gate states.
// ----------------------------------------------------------------------

async function phaseA(server) {
  const { base, adminPassword } = server;
  const adminEmail = process.env.ADMIN_EMAIL || "admin@bos-omega.local";

  // Set up a regular admin user (one-time per database) so the role-gate
  // test has a non-super_admin to log in as. The seeded super_admin owns
  // /api/users so we use it to create the regular admin.
  const superClient = makeClient(base);
  await login(superClient, adminEmail, adminPassword);

  const regularEmail = `pwsh-e2e-admin-${Date.now()}@bos-omega.local`;
  const regularPassword = "PwshE2eAdmin_2026!Pad";
  {
    const { res, data } = await superClient.request("POST", "/api/users", {
      email: regularEmail,
      password: regularPassword,
      role: "admin",
      reason: "powershell e2e — non-super-admin role-gate fixture",
    });
    if (res.status !== 201) {
      throw new Error(`could not create regular admin fixture: ${res.status} ${JSON.stringify(data)}`);
    }
  }

  // Per-run unique marker so the phase-A sanity check at the end of the
  // phase can distinguish "no audit row written for *our* attempted
  // commands" from "old rows happen to live in this database from prior
  // phase-B runs". Every command we submit in phase A embeds the
  // marker, and the SHA-256 of any submitted command will not collide
  // with rows from prior runs.
  const phaseAMarker = `pwsh-e2e-OFF-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const submittedShas = new Set();
  async function recordSha(command) {
    submittedShas.add(await sha256Hex(command));
  }

  await test("anonymous POST /api/powershell → 401 UNAUTHENTICATED", async () => {
    const anon = makeClient(base);
    const command = `Write-Output '${phaseAMarker}-anon'`;
    await recordSha(command);
    const { res, data } = await anon.request("POST", "/api/powershell", { command });
    assert.equal(res.status, 401, `expected 401, got ${res.status}: ${JSON.stringify(data)}`);
    assert.equal(data?.code, "UNAUTHENTICATED",
      `expected code UNAUTHENTICATED, got ${data?.code}`);
  });

  await test("regular admin POST /api/powershell → 403 FORBIDDEN", async () => {
    const admin = makeClient(base);
    await login(admin, regularEmail, regularPassword);
    const command = `Write-Output '${phaseAMarker}-admin'`;
    await recordSha(command);
    const { res, data } = await admin.request("POST", "/api/powershell", { command });
    assert.equal(res.status, 403, `expected 403, got ${res.status}: ${JSON.stringify(data)}`);
    assert.equal(data?.code, "FORBIDDEN",
      `expected code FORBIDDEN, got ${data?.code}`);
  });

  await test("super_admin POST /api/powershell with flag OFF → 404 POWERSHELL_DISABLED", async () => {
    const command = `Write-Output '${phaseAMarker}-super'`;
    await recordSha(command);
    const { res, data } = await superClient.request("POST", "/api/powershell", { command });
    assert.equal(res.status, 404, `expected 404, got ${res.status}: ${JSON.stringify(data)}`);
    assert.equal(data?.code, "POWERSHELL_DISABLED",
      `expected code POWERSHELL_DISABLED, got ${data?.code}`);
  });

  // Sanity: with the flag OFF, no POWERSHELL_EXECUTED / POWERSHELL_FAILED
  // row may have been written for any of the commands we submitted in
  // this phase. The 401/403/404 paths all bail before the audit write,
  // so we assert that none of our per-run command SHAs landed in the
  // audit chain. (Rows from prior phase-B runs against the same DB are
  // tolerated because their SHAs differ from anything submitted here.)
  await test("flag OFF leaves no POWERSHELL_EXECUTED / POWERSHELL_FAILED audit rows for our submissions", async () => {
    const { res, data } = await superClient.request("GET", "/api/audit?limit=200");
    assert.equal(res.status, 200);
    const entries = Array.isArray(data) ? data : (data?.entries ?? []);
    const hits = entries.filter((r) =>
      r.event_type === "POWERSHELL_EXECUTED" || r.event_type === "POWERSHELL_FAILED",
    );
    for (const row of hits) {
      const meta = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
      assert.equal(
        submittedShas.has(meta.command_sha256), false,
        `flag-OFF run must not have written ${row.event_type} for any of our submitted commands (sha256=${meta.command_sha256})`,
      );
    }
  });
}

// ----------------------------------------------------------------------
// Phase B — server WITH POWERSHELL_ENDPOINT_ENABLED=1 and a fake `pwsh`
// shim on PATH so we can exercise the success and failure execution
// paths deterministically. Covers the body-cap (413), success audit
// row, and failure audit row.
// ----------------------------------------------------------------------

async function phaseB(server) {
  const { base, adminPassword } = server;
  const adminEmail = process.env.ADMIN_EMAIL || "admin@bos-omega.local";
  const superClient = makeClient(base);
  await login(superClient, adminEmail, adminPassword);

  await test("super_admin flag ON, body > 4 KB → 413 COMMAND_TOO_LARGE", async () => {
    const oversized = "x".repeat(4 * 1024 + 1); // 4097 bytes ASCII = 4097 UTF-8 bytes
    const { res, data } = await superClient.request("POST", "/api/powershell", { command: oversized });
    assert.equal(res.status, 413, `expected 413, got ${res.status}: ${JSON.stringify(data)}`);
    assert.equal(data?.code, "COMMAND_TOO_LARGE",
      `expected code COMMAND_TOO_LARGE, got ${data?.code}`);
  });

  // Success path — runPowerShell discovers our shim, runs it, exits 0,
  // route returns 200 + writes POWERSHELL_EXECUTED with command_sha256
  // and command_bytes.
  await test("super_admin flag ON, valid command → 200 + POWERSHELL_EXECUTED audit row carries command_sha256 + command_bytes", async () => {
    // Use a unique marker so we can find the row deterministically even
    // if the database carries rows from previous runs.
    const marker = `pwsh-e2e-OK-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const command = `Write-Output '${marker}'`;
    const { res, data } = await superClient.request("POST", "/api/powershell", { command });
    if (res.status !== 200) {
      throw new Error(`expected 200, got ${res.status}: ${JSON.stringify(data)}`);
    }
    const expectedSha = await sha256Hex(command);
    const expectedBytes = Buffer.byteLength(command, "utf8");
    const row = await findLatestAuditRow(superClient, "POWERSHELL_EXECUTED",
      (r) => (r.metadata?.command_sha256 === expectedSha));
    assertAuditCommandFingerprint(row, {
      expectedSha256: expectedSha,
      expectedBytes,
      label: "POWERSHELL_EXECUTED",
    });
    assert.equal(row.metadata?.outcome, "ok",
      `POWERSHELL_EXECUTED.outcome must be 'ok', got ${row.metadata?.outcome}`);
    assert.equal(typeof row.metadata?.output_bytes, "number",
      `POWERSHELL_EXECUTED.output_bytes must be a number`);
  });

  // Failure path — the shim recognises FAIL_PLEASE and exits 2, which
  // makes runPowerShell reject. The route returns 500 + writes
  // POWERSHELL_FAILED with command_sha256 and command_bytes.
  await test("super_admin flag ON, failing command → 500 + POWERSHELL_FAILED audit row carries command_sha256 + command_bytes", async () => {
    const marker = `pwsh-e2e-FAIL_PLEASE-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const command = `Write-Output '${marker}'; throw 'boom'`;
    const { res, data } = await superClient.request("POST", "/api/powershell", { command });
    if (res.status !== 500) {
      throw new Error(`expected 500, got ${res.status}: ${JSON.stringify(data)}`);
    }
    assert.equal(data?.code, "POWERSHELL_FAILED",
      `expected code POWERSHELL_FAILED, got ${data?.code}`);
    const expectedSha = await sha256Hex(command);
    const expectedBytes = Buffer.byteLength(command, "utf8");
    const row = await findLatestAuditRow(superClient, "POWERSHELL_FAILED",
      (r) => (r.metadata?.command_sha256 === expectedSha));
    assertAuditCommandFingerprint(row, {
      expectedSha256: expectedSha,
      expectedBytes,
      label: "POWERSHELL_FAILED",
    });
    assert.equal(row.metadata?.outcome, "error",
      `POWERSHELL_FAILED.outcome must be 'error', got ${row.metadata?.outcome}`);
    assert.equal(typeof row.metadata?.error, "string",
      `POWERSHELL_FAILED.error must be a string`);
  });
}

// ----------------------------------------------------------------------
// Main.
// ----------------------------------------------------------------------

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("[harness] DATABASE_URL is required to spawn the API server");
    process.exit(2);
  }

  await buildIfNeeded();

  console.log("\n[harness] phase A — POWERSHELL_ENDPOINT_ENABLED unset");
  let serverA;
  try {
    serverA = await spawnServer({ POWERSHELL_ENDPOINT_ENABLED: "" });
  } catch (err) {
    console.error(`[harness] failed to start phase A server: ${err.message}`);
    process.exit(1);
  }
  try {
    await phaseA(serverA);
  } finally {
    await serverA.stop();
  }

  console.log("\n[harness] phase B — POWERSHELL_ENDPOINT_ENABLED=1 + fake pwsh on PATH");
  const fakeDir = createFakePwshDir();
  console.log(`[harness] fake pwsh shim: ${fakeDir}/pwsh`);
  const augmentedPath = `${fakeDir}${path.delimiter}${process.env.PATH ?? ""}`;
  let serverB;
  try {
    serverB = await spawnServer({
      POWERSHELL_ENDPOINT_ENABLED: "1",
      PATH: augmentedPath,
    });
  } catch (err) {
    console.error(`[harness] failed to start phase B server: ${err.message}`);
    process.exit(1);
  }
  try {
    await phaseB(serverB);
  } finally {
    await serverB.stop();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[harness] crashed:", err);
  process.exit(1);
});
