import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";

export const userMemoryBudgetsTable = pgTable("user_memory_budgets", {
  user_id: text("user_id").primaryKey(),
  canon_budget: integer("canon_budget").notNull().default(3000),
  continuity_budget: integer("continuity_budget").notNull().default(1500),
  patches_budget: integer("patches_budget").notNull().default(1000),
  scratchpad_budget: integer("scratchpad_budget").notNull().default(750),
  updated_at: timestamp("updated_at").notNull().defaultNow(),
});

export type UserMemoryBudgetsRow = typeof userMemoryBudgetsTable.$inferSelect;
export type NewUserMemoryBudgets = typeof userMemoryBudgetsTable.$inferInsert;
