import { pgTable, text, integer, timestamp, boolean } from "drizzle-orm/pg-core";

/**
 * Task #reflection — Reflection pass audit table.
 *
 * Records the result of every reflection pass: the first-pass state
 * vs the reflection state, the two answers (truncated to 4 KB each),
 * whether the reflection was adopted, and the provider/model that
 * ran it. The operator can read this row to see exactly what the
 * reflection pass changed.
 */
export const reflectionRunsTable = pgTable("reflection_runs", {
  id: text("id").primaryKey(),
  task_id: text("task_id").notNull(),
  first_pass_state: text("first_pass_state").notNull(),
  reflection_state: text("reflection_state").notNull(),
  first_pass_answer: text("first_pass_answer").notNull().default(""),
  reflection_answer: text("reflection_answer").notNull().default(""),
  // Stored as text "true"/"false" because we don't have a boolean
  // helper here; drizzle-pg would auto-convert but we keep the
  // table minimal to avoid the generated-types bloat in the SPA
  // type bundle. Queries that need a bool can compare the text.
  improved: text("improved").notNull().default("false"),
  parse_ok: text("parse_ok").notNull().default("false"),
  confidence: integer("confidence").notNull().default(0),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export type ReflectionRun = typeof reflectionRunsTable.$inferSelect;
