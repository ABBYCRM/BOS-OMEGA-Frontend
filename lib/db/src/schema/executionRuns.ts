import { pgTable, text, integer, real, timestamp } from "drizzle-orm/pg-core";
import { tasksTable } from "./tasks";

export const executionRunsTable = pgTable("execution_runs", {
  id: text("id").primaryKey(),
  task_id: text("task_id").references(() => tasksTable.id),
  mode: text("mode").notNull(), // normal | series_pass | boil_the_ocean
  status: text("status").notNull().default("running"), // running | completed | failed | held | aborted
  total_passes: integer("total_passes"),
  total_agents: integer("total_agents"),
  models_used: text("models_used").array(),
  final_score: real("final_score"),
  started_at: timestamp("started_at").notNull().defaultNow(),
  completed_at: timestamp("completed_at"),
});

export type ExecutionRun = typeof executionRunsTable.$inferSelect;
export type NewExecutionRun = typeof executionRunsTable.$inferInsert;
