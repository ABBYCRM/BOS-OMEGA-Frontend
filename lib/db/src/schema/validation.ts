import { pgTable, text, boolean, real, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const validationResultsTable = pgTable("validation_results", {
  id: text("id").primaryKey(),
  task_id: text("task_id").notNull(),
  attempt_id: text("attempt_id"),
  schema_pass: boolean("schema_pass").notNull().default(false),
  safety_pass: boolean("safety_pass").notNull().default(false),
  instruction_pass: boolean("instruction_pass").notNull().default(false),
  completeness_pass: boolean("completeness_pass").notNull().default(false),
  confidence_score: real("confidence_score").notNull().default(0),
  notes: text("notes"),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const insertValidationSchema = createInsertSchema(validationResultsTable).omit({
  created_at: true,
});
export type InsertValidation = z.infer<typeof insertValidationSchema>;
export type ValidationResult = typeof validationResultsTable.$inferSelect;
