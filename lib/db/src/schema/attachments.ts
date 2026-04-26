import { pgTable, text, timestamp, integer, index } from "drizzle-orm/pg-core";

export const attachmentsTable = pgTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    task_id: text("task_id"),
    user_id: text("user_id"),
    original_name: text("original_name").notNull(),
    mime: text("mime").notNull(),
    kind: text("kind").notNull(),
    size_bytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    storage_key: text("storage_key").notNull(),
    extracted_text: text("extracted_text"),
    extraction_status: text("extraction_status").notNull().default("pending"),
    extraction_error: text("extraction_error"),
    extraction_meta: text("extraction_meta"),
    width: integer("width"),
    height: integer("height"),
    duration_ms: integer("duration_ms"),
    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    by_task: index("attachments_task_id_idx").on(t.task_id),
    by_sha: index("attachments_sha256_idx").on(t.sha256),
  }),
);

export type Attachment = typeof attachmentsTable.$inferSelect;
export type InsertAttachment = typeof attachmentsTable.$inferInsert;
