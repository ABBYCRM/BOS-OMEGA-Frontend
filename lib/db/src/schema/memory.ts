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
  created_at: timestamp("created_at").notNull().defaultNow(),
  updated_at: timestamp("updated_at").notNull().defaultNow(),
});

export const insertMemorySchema = createInsertSchema(memoryItemsTable).omit({
  created_at: true,
  updated_at: true,
});
export type InsertMemory = z.infer<typeof insertMemorySchema>;
export type MemoryItem = typeof memoryItemsTable.$inferSelect;
