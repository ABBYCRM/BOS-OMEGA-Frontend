import { pgTable, text, integer, real, timestamp } from "drizzle-orm/pg-core";
import { executionRunsTable } from "./executionRuns";

export const parallelAgentsTable = pgTable("parallel_agents", {
  id: text("id").primaryKey(),
  run_id: text("run_id").references(() => executionRunsTable.id),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  agent_role: text("agent_role").notNull(), // ARCHITECT | CRITIC | RESEARCHER | BUILDER | VALIDATOR
  status: text("status").notNull().default("pending"), // pending | running | completed | failed
  output: text("output"),
  score: real("score"),
  state: text("state"), // GO | HOLD | ABORT
  error_type: text("error_type"),
  latency_ms: integer("latency_ms"),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export type ParallelAgent = typeof parallelAgentsTable.$inferSelect;
export type NewParallelAgent = typeof parallelAgentsTable.$inferInsert;
