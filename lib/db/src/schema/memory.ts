import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const memoryItemsTable = pgTable("memory_items", {
  id: text("id").primaryKey(),
  user_id: text("user_id"),
  layer: text("layer").notNull().default("scratchpad"),
  title: text("title").notNull(),
  content: text("content").notNull(),
  authority_level: integer("authority_level").notNull().default(5),
  // Fidelity Lattice Continuity Protocol — Task #66.
  // Distinguishes how a scratchpad row got there so the UI can render
  // pinned vs auto-summarised entries differently and downstream
  // pruning logic can treat them with different aggressiveness:
  //   - "manual"       (default; legacy rows + user-typed entries)
  //   - "auto_summary" (written by the auto-summarisation writer)
  //   - "manual_pin"   (written by the Pin-this-turn UI control)
  // The column is non-null with a default of "manual" so legacy rows
  // backfill cleanly without an explicit data migration.
  source: text("source").notNull().default("manual"),
  // Task #67 — Lattice continuity scratchpad writer.
  // For source="auto_summary" rows this is the task_id of the task whose
  // completion produced the summary; for source="manual_pin" rows it's
  // the task_id of the message the user pinned (when known). Nullable
  // because legacy rows + freeform manual notes have no source task.
  // Stored as text (not a real FK) so a deleted task does not cascade
  // away the user's continuity history.
  source_task_id: text("source_task_id"),
  created_at: timestamp("created_at").notNull().defaultNow(),
  updated_at: timestamp("updated_at").notNull().defaultNow(),
});

export const insertMemorySchema = createInsertSchema(memoryItemsTable).omit({
  created_at: true,
  updated_at: true,
});
export type InsertMemory = z.infer<typeof insertMemorySchema>;
export type MemoryItem = typeof memoryItemsTable.$inferSelect;
