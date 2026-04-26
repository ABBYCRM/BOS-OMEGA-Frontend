import { pgTable, text, real, timestamp } from "drizzle-orm/pg-core";

export const triStateDecisionsTable = pgTable("tri_state_decisions", {
  id: text("id").primaryKey(),
  // task_id is loosely linked — the decision is created before the task row exists,
  // so we don't enforce a FK constraint here.
  task_id: text("task_id"),
  go_score: real("go_score").notNull(),
  hold_score: real("hold_score").notNull(),
  abort_score: real("abort_score").notNull(),
  evidence_signals: text("evidence_signals"), // JSON array of EvidenceSignal
  collapse_reason: text("collapse_reason").notNull(),
  final_state: text("final_state").notNull(), // GO | HOLD | ABORT
  confidence_score: real("confidence_score"),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export type TriStateDecision = typeof triStateDecisionsTable.$inferSelect;
export type NewTriStateDecision = typeof triStateDecisionsTable.$inferInsert;
