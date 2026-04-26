#!/usr/bin/env node
/**
 * One-command harness for the R-1/R-5 e2e suite.
 *
 *   $ node tests/run-r1-r5-e2e.mjs
 *
 * What it does:
 *   1. Picks an unused TCP port for the API server (or honors PORT env).
 *   2. Spawns the prebuilt server (`node dist/index.mjs`). If `dist/` is
 *      missing, runs `pnpm run build` first.
 *   3. Polls /api/healthz until ready (or fails after 30s).
 *   4. Runs `tests/r1_r5_e2e.mjs` as a child process with API_BASE pointed
 *      at the spawned server.
 *   5. Tears the server down regardless of test outcome and exits with the
 *      test's exit code.
 *
 * If API_BASE is already set in the env, the harness skips the spawn and
 * just runs the test against the external server (handy for CI smoke tests
 * against staging).
 *
 * Required env when spawning:
 *   - DATABASE_URL — the Postgres URL the API server will seed and query.
 * Optional env when spawning:
 *   - PORT (defaults to a random free port)
 *   - SESSION_SECRET (defaults to an ephemeral 32+ char per-run value)
 *   - ADMIN_EMAIL (defaults to admin@bos-omega.local)
 *   - ADMIN_PASSWORD (defaults to BosOmegaTestAdmin_2026!)
 *   - NODE_ENV (defaults to "development" so the spawned server does not
 *     require OWNER_SUPERADMIN_BOOTSTRAP_PASSWORD; pass NODE_ENV=production
 *     explicitly only when you have already set that secret)
 *   - REBUILD=1 — force a fresh `pnpm run build` even if dist/ already exists
 *     (recommended in CI so the harness never tests a stale binary).
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_DIR = path.resolve(HERE, "..");
const DIST = path.join(API_DIR, "dist", "index.mjs");

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

async function runTest(env) {
  const code = await runChild(process.execPath, [path.join(HERE, "r1_r5_e2e.mjs")], { env });
  return code;
}

async function main() {
  // External-server mode: caller already has a server up.
  if (process.env.API_BASE) {
    console.log(`[harness] API_BASE provided (${process.env.API_BASE}); skipping spawn`);
    if (!process.env.ADMIN_PASSWORD) {
      console.error("[harness] ADMIN_PASSWORD is required when API_BASE is provided");
      process.exit(2);
    }
    process.exit(await runTest(process.env));
  }

  if (!process.env.DATABASE_URL) {
    console.error("[harness] DATABASE_URL is required to spawn the API server");
    process.exit(2);
  }

  await buildIfNeeded();

  const port = process.env.PORT ? Number(process.env.PORT) : await pickFreePort();
  const base = `http://127.0.0.1:${port}`;
  // Generated per-run so the tests don't accidentally reuse a stale cookie
  // from another harness invocation. Must be >=32 chars per auth.ts.
  const sessionSecret = process.env.SESSION_SECRET
    || `r1r5-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}-padding-padding`;
  const adminPassword = process.env.ADMIN_PASSWORD || "BosOmegaTestAdmin_2026!";

  // Default to "development" so the spawned server's owner reconcile path
  // does NOT require OWNER_SUPERADMIN_BOOTSTRAP_PASSWORD (which would hard-
  // fail boot in production). Operators who explicitly set NODE_ENV=production
  // are expected to also provide OWNER_SUPERADMIN_BOOTSTRAP_PASSWORD; we
  // surface that requirement up front so the failure mode is obvious.
  const nodeEnv = process.env.NODE_ENV || "development";
  if (nodeEnv === "production" && !process.env.OWNER_SUPERADMIN_BOOTSTRAP_PASSWORD) {
    console.error(
      "[harness] NODE_ENV=production requires OWNER_SUPERADMIN_BOOTSTRAP_PASSWORD; either unset NODE_ENV or provide the secret",
    );
    process.exit(2);
  }
  const serverEnv = {
    ...process.env,
    PORT: String(port),
    SESSION_SECRET: sessionSecret,
    ADMIN_PASSWORD: adminPassword,
    NODE_ENV: nodeEnv,
  };

  console.log(`[harness] spawning API server on ${base}`);
  const server = spawn(process.execPath, ["--enable-source-maps", DIST], {
    env: serverEnv,
    stdio: ["ignore", "inherit", "inherit"],
  });

  let serverExit = null;
  server.on("exit", (code, signal) => {
    serverExit = { code, signal };
    console.log(`[harness] server exited code=${code} signal=${signal}`);
  });

  const cleanup = () => {
    if (server.exitCode === null && !server.killed) {
      try { server.kill("SIGTERM"); } catch { /* ignore */ }
      // Hard kill if it doesn't go quietly.
      setTimeout(() => {
        if (server.exitCode === null) {
          try { server.kill("SIGKILL"); } catch { /* ignore */ }
        }
      }, 3000).unref();
    }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });

  try {
    await waitForHealth(base, 30_000);
  } catch (err) {
    console.error(`[harness] ${err.message}`);
    cleanup();
    process.exit(1);
  }
  if (serverExit) {
    console.error("[harness] server exited before tests started");
    process.exit(1);
  }

  const testEnv = {
    ...process.env,
    API_BASE: base,
    ADMIN_PASSWORD: adminPassword,
    ADMIN_EMAIL: process.env.ADMIN_EMAIL || "admin@bos-omega.local",
  };

  let code = 1;
  try {
    code = await runTest(testEnv);
  } finally {
    cleanup();
  }
  process.exit(code);
}

main().catch((err) => {
  console.error("[harness] crashed:", err);
  process.exit(1);
});
