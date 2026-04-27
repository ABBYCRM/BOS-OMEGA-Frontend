import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { conversationsTable } from "./conversations";

export const tasksTable = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id"),
    input_text: text("input_text").notNull(),
    task_type: text("task_type").notNull(),
    tri_state: text("tri_state").notNull(),
    selected_provider: text("selected_provider"),
    selected_model: text("selected_model"),
    final_status: text("final_status").notNull().default("pending"),
    final_output: text("final_output"),
    mode: text("mode").notNull().default("single"),
    // Fidelity Lattice Continuity Protocol — Task #66.
    // Nullable FK to `conversations.id`. Pre-existing tasks stay null and
    // are surfaced as "Uncategorized" by the conversations sidebar. The
    // clustering writer assigns this column on new tasks; users can also
    // reassign via the conversations UI in a downstream lattice task.
    conversation_id: text("conversation_id").references(() => conversationsTable.id),
    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  // Task #68 — composite index supports the two hot lookups we added:
  //   1. GET /api/conversations/:id orders this conversation's tasks by
  //      created_at (rehydrates the chat thread).
  //   2. The clusterer fetches the last N task inputs per candidate
  //      conversation in `assignConversation()`.
  // Without this index both paths fall back to a scan over `tasks`,
  // which gets slow once a single user has thousands of rows.
  (t) => ({
    tasks_conversation_id_created_at_idx:
      index("tasks_conversation_id_created_at_idx").on(t.conversation_id, t.created_at),
  }),
);

export const insertTaskSchema = createInsertSchema(tasksTable).omit({
  created_at: true,
});
export type InsertTask = z.infer<typeof insertTaskSchema>;
export type Task = typeof tasksTable.$inferSelect;
