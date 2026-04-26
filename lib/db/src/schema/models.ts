import { pgTable, text, boolean, integer, real, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const llmModelsTable = pgTable("llm_models", {
  id: text("id").primaryKey(),
  provider_id: text("provider_id").notNull(),
  model_name: text("model_name").notNull(),
  capability_tags: text("capability_tags").array().notNull().default([]),
  context_window: integer("context_window").notNull().default(8192),
  cost_input: real("cost_input").notNull().default(0),
  cost_output: real("cost_output").notNull().default(0),
  reliability_score: real("reliability_score").notNull().default(0.9),
  latency_score: real("latency_score").notNull().default(0.8),
  enabled: boolean("enabled").notNull().default(true),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const insertModelSchema = createInsertSchema(llmModelsTable).omit({
  created_at: true,
});
export type InsertModel = z.infer<typeof insertModelSchema>;
export type LlmModel = typeof llmModelsTable.$inferSelect;
