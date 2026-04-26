import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { executionRunsTable } from "./executionRuns";

export const synthesisReportsTable = pgTable("synthesis_reports", {
  id: text("id").primaryKey(),
  run_id: text("run_id").references(() => executionRunsTable.id),
  consensus_points: text("consensus_points").array(),
  contradictions: text("contradictions").array(),
  strongest_sections: text("strongest_sections").array(),
  rejected_sections: text("rejected_sections").array(),
  final_synthesis: text("final_synthesis"),
  omega_validation: text("omega_validation"), // JSON: { state, schema_pass, safety_pass, completeness_pass, notes }
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export type SynthesisReport = typeof synthesisReportsTable.$inferSelect;
export type NewSynthesisReport = typeof synthesisReportsTable.$inferInsert;
