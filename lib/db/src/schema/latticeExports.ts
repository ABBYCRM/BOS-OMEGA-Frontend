import { pgTable, text, integer, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Fidelity Lattice Continuity Protocol — `lattice_exports` audit table.
 *
 * Every time a user exports a lattice (canon + continuity + patches +
 * scratchpad + selected task transcripts) we record one row here so the
 * audit trail proves who took the data, when, and what its sha256
 * fidelity hash was. The hash is recomputed on import; a mismatch is the
 * tamper-evidence signal that import-side validation refuses.
 *
 * Owned by Task #66 (schema foundations). The actual export/import
 * pipeline lands in the downstream "export, import & user-menu UI"
 * lattice task; this file only defines the table.
 *
 * Columns:
 *   - `user_id` — who initiated the export.
 *   - `fidelity_sha256` — sha256 of the canonical-JSON serialization
 *     of the exported payload. 64 hex chars.
 *   - `byte_size` — size of the serialized payload in bytes (the same
 *     bytes that were hashed). Surfaced in the UI and used by import
 *     to short-circuit obvious size mismatches before hashing.
 *   - `task_count` — how many task transcripts were bundled. Pure
 *     metadata, but the audit log surfaces it so reviewers can see at
 *     a glance what scope an export covered.
 */
export const latticeExportsTable = pgTable(
  "lattice_exports",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id").notNull(),
    fidelity_sha256: text("fidelity_sha256").notNull(),
    byte_size: integer("byte_size").notNull(),
    task_count: integer("task_count").notNull().default(0),
    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    user_idx: index("lattice_exports_user_idx").on(t.user_id, t.created_at),
  }),
);

export type LatticeExport = typeof latticeExportsTable.$inferSelect;
export type NewLatticeExport = typeof latticeExportsTable.$inferInsert;
