import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

// Drizzle-kit's `generate` resolves these as relative-to-cwd paths and
// concatenates with a leading `./`, so passing absolutes here produced
// `.//<abs>/...` and broke `pnpm run generate`. The package.json scripts
// always invoke drizzle-kit from this directory, so relative paths are
// safe and consistent for both `push` and `generate`.
export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./drizzle/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
