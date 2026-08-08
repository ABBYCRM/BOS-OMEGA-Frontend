import { pgTable, text, integer, jsonb, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * BOS-OMEGA API Tokens
 *
 * Each row is one user-issued token that the BOS-OMEGA external API
 * accepts as a Bearer credential. The plaintext token is shown to the
 * user exactly once on creation and never stored — we keep only the
 * sha256 hash, scopes, expiry, and audit fields.
 *
 * Token format: `bos_<24-char prefix>_<32-char random secret>` (e.g.
 * `bos_AbCdEf1234567890_a1b2c3d4e5f6...`). The prefix doubles as a
 * fast-lookup index when logging failures.
 *
 * Scopes (string array, AND of all required to authorize a request):
 *   - "memory:read"         list memory items (all layers)
 *   - "memory:write"        create/update/delete memory items
 *   - "memory:canon:read"   list canon items
 *   - "memory:canon:write"  create/update/delete canon items (admin only)
 *   - "memory:scratchpad:read"
 *   - "memory:scratchpad:write"
 *   - "memory:continuity:read"
 *   - "memory:continuity:write"
 *   - "conversations:read"  list/get conversations
 *   - "conversations:write" create/update conversations
 *   - "tasks:read"          list/get tasks
 *   - "tasks:write"         submit new tasks
 *   - "audit:read"          list audit log entries
 *   - "continuity:export"   export bos-omega.continuity-bundle.v1
 *   - "continuity:import"   rehydrate from a bundle
 */
export const apiTokensTable = pgTable("api_tokens", {
  id: text("id").primaryKey(),
  user_id: text("user_id").notNull(),
  name: text("name").notNull(),
  // sha256 hash of the full token string. Never the plaintext.
  token_hash: text("token_hash").notNull().unique(),
  // First 12 chars of the token after "bos_" — used for fast lookup and
  // displayed masked in the UI so the user can tell tokens apart.
  token_prefix: text("token_prefix").notNull(),
  scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
  expires_at: timestamp("expires_at"),
  last_used_at: timestamp("last_used_at"),
  // Soft-revoke: revoked_at set means the token is dead but the row is
  // preserved for audit (so we know who issued what to whom).
  revoked_at: timestamp("revoked_at"),
  revoked_reason: text("revoked_reason"),
  // PowerShell-only filter — the operator can tag a token as "ps-only"
  // so it can only be used from the local PowerShell bridge, never from
  // arbitrary web origins. UI tokens omit this flag.
  power_shell_only: boolean("power_shell_only").notNull().default(false),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const insertApiTokenSchema = createInsertSchema(apiTokensTable).omit({
  created_at: true,
  token_hash: true,
  token_prefix: true,
  last_used_at: true,
  revoked_at: true,
});
export type InsertApiToken = z.infer<typeof insertApiTokenSchema>;
export type ApiToken = typeof apiTokensTable.$inferSelect;

/** Audit log for every API token operation. Separate table so we don't
 *  pollute the global audit_logs. */
export const apiTokenAuditTable = pgTable("api_token_audit", {
  id: text("id").primaryKey(),
  token_id: text("token_id"),
  user_id: text("user_id").notNull(),
  event_type: text("event_type").notNull(),
  // CREATE | USE | REVOKE | USE_FAILED | SCOPE_DENIED | EXPIRED
  ip: text("ip"),
  user_agent: text("user_agent"),
  metadata: jsonb("metadata"),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const insertApiTokenAuditSchema = createInsertSchema(apiTokenAuditTable).omit({
  created_at: true,
});
export type InsertApiTokenAudit = z.infer<typeof insertApiTokenAuditSchema>;
export type ApiTokenAudit = typeof apiTokenAuditTable.$inferSelect;
