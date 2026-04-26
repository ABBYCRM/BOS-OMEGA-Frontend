import { pgTable, text, integer, real, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const providerHealthTable = pgTable("provider_health", {
  id: text("id").primaryKey(),
  provider_id: text("provider_id").notNull().unique(),
  status: text("status").notNull().default("HEALTHY"),
  failure_count: integer("failure_count").notNull().default(0),
  schema_failure_count: integer("schema_failure_count").notNull().default(0),
  last_failure: timestamp("last_failure"),
  last_success: timestamp("last_success"),
  avg_latency_ms: real("avg_latency_ms").notNull().default(0),
  circuit_opened_at: timestamp("circuit_opened_at"),
  updated_at: timestamp("updated_at").notNull().defaultNow(),
});

export const insertProviderHealthSchema = createInsertSchema(providerHealthTable).omit({
  updated_at: true,
});
export type InsertProviderHealth = z.infer<typeof insertProviderHealthSchema>;
export type ProviderHealth = typeof providerHealthTable.$inferSelect;
