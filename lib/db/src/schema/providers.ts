import { pgTable, text, boolean, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const llmProvidersTable = pgTable("llm_providers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  base_url: text("base_url"),
  status: text("status").notNull().default("HEALTHY"),
  enabled: boolean("enabled").notNull().default(true),
  priority: integer("priority").notNull().default(5),
  api_key_env: text("api_key_env"),
  created_at: timestamp("created_at").notNull().defaultNow(),
  updated_at: timestamp("updated_at").notNull().defaultNow(),
});

export const insertProviderSchema = createInsertSchema(llmProvidersTable).omit({
  created_at: true,
  updated_at: true,
});
export type InsertProvider = z.infer<typeof insertProviderSchema>;
export type Provider = typeof llmProvidersTable.$inferSelect;
