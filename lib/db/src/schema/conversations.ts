import { pgTable, text, timestamp, boolean, index } from "drizzle-orm/pg-core";

/**
 * Fidelity Lattice Continuity Protocol — `conversations` table.
 *
 * A conversation is a server-side grouping of related tasks for one user.
 * Tasks point at a conversation via `tasks.conversation_id` (nullable —
 * pre-existing tasks stay null and are surfaced as "Uncategorized" by the
 * UI).
 *
 * Owned by Task #66 (schema foundations). Business logic — clustering,
 * sidebar grouping, archive — lands in the downstream lattice tasks; this
 * file only defines the table.
 *
 * Notes for downstream tasks:
 *   - `topic_keywords` is a Postgres text[]. The clustering writer picks
 *     this up and uses it for "looks-like-this-thread" matching.
 *   - `last_active_at` is updated by the writer when a new task is
 *     assigned to the conversation. It is intentionally separate from
 *     `created_at` so the sidebar can sort by recency.
 *   - `archived` is a soft-hide flag. Archived conversations are still
 *     readable for export/import; they just don't show up in the
 *     default sidebar.
 */
export const conversationsTable = pgTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id").notNull(),
    title: text("title").notNull(),
    topic_keywords: text("topic_keywords").array().notNull().default([]),
    created_at: timestamp("created_at").notNull().defaultNow(),
    last_active_at: timestamp("last_active_at").notNull().defaultNow(),
    archived: boolean("archived").notNull().default(false),
  },
  (t) => ({
    user_idx: index("conversations_user_idx").on(t.user_id, t.last_active_at),
  }),
);

export type Conversation = typeof conversationsTable.$inferSelect;
export type NewConversation = typeof conversationsTable.$inferInsert;
