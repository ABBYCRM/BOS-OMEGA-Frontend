import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const fallbackEventsTable = pgTable("fallback_events", {
  id: text("id").primaryKey(),
  task_id: text("task_id").notNull(),
  from_provider: text("from_provider"),
  from_model: text("from_model"),
  to_provider: text("to_provider"),
  to_model: text("to_model"),
  reason: text("reason").notNull(),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const insertFallbackSchema = createInsertSchema(fallbackEventsTable).omit({
  created_at: true,
});
export type InsertFallback = z.infer<typeof insertFallbackSchema>;
export type FallbackEvent = typeof fallbackEventsTable.$inferSelect;
