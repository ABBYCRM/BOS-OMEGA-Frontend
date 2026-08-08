import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// Managed Postgres providers (e.g. DigitalOcean) use certificates that fail
// Node's default chain verification. Opt into relaxed TLS via env flag,
// keeping strict verification everywhere else (Replit's DB needs no SSL tweak).
const ssl =
  process.env.DATABASE_SSL === "no-verify"
    ? { rejectUnauthorized: false }
    : undefined;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ...(ssl ? { ssl } : {}),
});
export const db = drizzle(pool, { schema });

export * from "./schema";
