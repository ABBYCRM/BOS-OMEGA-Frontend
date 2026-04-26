import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const auditLogsTable = pgTable("audit_logs", {
  id: text("id").primaryKey(),
  task_id: text("task_id"),
  event_type: text("event_type").notNull(),
  message: text("message").notNull(),
  metadata: jsonb("metadata"),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const insertAuditSchema = createInsertSchema(auditLogsTable).omit({
  created_at: true,
});
export type InsertAudit = z.infer<typeof insertAuditSchema>;
export type AuditLog = typeof auditLogsTable.$inferSelect;
