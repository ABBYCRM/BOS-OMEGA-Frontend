// Startup migration runner for the api-server.
//
// `drizzle-kit` is a devDependency and is NOT installed in the
// production container, so we use the production-safe migrator
// exported by `drizzle-orm/node-postgres/migrator` (a regular dep).
// The migrations folder is staged into `artifacts/api-server/dist/migrations`
// by the build command in the DO App Platform spec.
//
// Idempotent: drizzle's migrator tracks applied migrations in
// `__drizzle_migrations` and only applies the diff.
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (!process.env.DATABASE_URL) {
  console.error("[migrate] DATABASE_URL is not set; skipping migrations");
  process.exit(0);
}

// Same DATABASE_SSL handling as lib/db/src/index.ts — managed
// Postgres (DO) needs `sslmode=no-verify`; Replit's DB keeps the
// default chain verification. We rewrite the URL's sslmode here
// because pg's connection-string parser would otherwise let the
// URL override any explicit ssl option we pass.
let connectionString = process.env.DATABASE_URL;
if (process.env.DATABASE_SSL === "no-verify") {
  const url = new URL(connectionString);
  url.searchParams.set("sslmode", "no-verify");
  connectionString = url.toString();
}

const MIGRATIONS_CANDIDATES = [
  // Production layout (migrations copied next to dist by the build).
  path.resolve(__dirname, "migrations"),
  // Dev layout (cwd = repo root).
  path.resolve(__dirname, "..", "..", "lib", "db", "drizzle", "migrations"),
  // Dev layout (cwd = artifacts/api-server).
  path.resolve(__dirname, "..", "lib", "db", "drizzle", "migrations"),
];
const migrationsFolder = MIGRATIONS_CANDIDATES.find((p) => existsSync(p));

if (!migrationsFolder) {
  console.error(
    "[migrate] no migrations folder found in any of:",
    MIGRATIONS_CANDIDATES,
  );
  process.exit(1);
}

console.log(`[migrate] applying migrations from ${migrationsFolder}`);

const pool = new pg.Pool({ connectionString });
const db = drizzle(pool);

try {
  await migrate(db, { migrationsFolder });
  console.log("[migrate] migrations applied");
} catch (err) {
  console.error("[migrate] failed:", err);
  process.exit(1);
} finally {
  await pool.end();
}
