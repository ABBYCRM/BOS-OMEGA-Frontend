import { pgTable, text, integer, real, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const modelAttemptsTable = pgTable("model_attempts", {
  id: text("id").primaryKey(),
  task_id: text("task_id").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  attempt_number: integer("attempt_number").notNull().default(1),
  status: text("status").notNull(),
  error_type: text("error_type"),
  latency_ms: real("latency_ms"),
  token_input: integer("token_input"),
  token_output: integer("token_output"),
  cost_estimate: real("cost_estimate"),
  raw_response: text("raw_response"),
  is_parallel: boolean("is_parallel").notNull().default(false),
  parallel_group: text("parallel_group"),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const insertAttemptSchema = createInsertSchema(modelAttemptsTable).omit({
  created_at: true,
});
export type InsertAttempt = z.infer<typeof insertAttemptSchema>;
export type ModelAttempt = typeof modelAttemptsTable.$inferSelect;
