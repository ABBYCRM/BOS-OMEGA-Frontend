import { pgTable, text, integer, real, timestamp } from "drizzle-orm/pg-core";
import { executionRunsTable } from "./executionRuns";

export const seriesPassesTable = pgTable("series_passes", {
  id: text("id").primaryKey(),
  run_id: text("run_id").references(() => executionRunsTable.id),
  pass_number: integer("pass_number").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  role: text("role").notNull(), // DRAFTER | CRITIC | EXPANDER | ADVERSARY | SYNTHESIZER | OMEGA_VALIDATOR
  input_snapshot: text("input_snapshot"), // truncated input sent to this pass
  output_snapshot: text("output_snapshot"), // output from this pass
  validation_score: real("validation_score"),
  errors_found: text("errors_found").array(),
  state: text("state"), // GO | HOLD | ABORT
  latency_ms: integer("latency_ms"),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export type SeriesPass = typeof seriesPassesTable.$inferSelect;
export type NewSeriesPass = typeof seriesPassesTable.$inferInsert;
