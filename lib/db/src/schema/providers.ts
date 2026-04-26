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
  // Encrypted API key stored directly (AES-256-GCM, key derived from SESSION_SECRET).
  // Format: "iv:authTag:ciphertext" (all hex). Empty/null means no DB-stored key.
  api_key_encrypted: text("api_key_encrypted"),
  // Last 4 chars of the cleartext key, for UI hint (never the full key).
  api_key_hint: text("api_key_hint"),
  // Last connection test result for agentic feedback.
  last_test_status: text("last_test_status"), // OK | FAILED | NEVER_TESTED
  last_test_message: text("last_test_message"),
  last_test_at: timestamp("last_test_at"),
  // Number of models discovered from the provider's catalog.
  discovered_models_count: integer("discovered_models_count").notNull().default(0),
  created_at: timestamp("created_at").notNull().defaultNow(),
  updated_at: timestamp("updated_at").notNull().defaultNow(),
});

export const insertProviderSchema = createInsertSchema(llmProvidersTable).omit({
  created_at: true,
  updated_at: true,
});
export type InsertProvider = z.infer<typeof insertProviderSchema>;
export type Provider = typeof llmProvidersTable.$inferSelect;
