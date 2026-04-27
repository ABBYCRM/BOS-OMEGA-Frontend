import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";

/**
 * Task #85 — per-user image-generation spend cap overrides.
 *
 * Engine defaults are env-driven (IMAGE_QUOTA_DAILY_COUNT_DEFAULT,
 * IMAGE_QUOTA_DAILY_USD_CENTS_DEFAULT). A row in this table replaces
 * EITHER cap (or both). NULL fields fall back to the engine default,
 * so an admin can raise just the count without rewriting the USD cap.
 *
 * Usage is NOT persisted here — it is derived live from audit_logs
 * IMAGE_GENERATED / IMAGE_EDIT_COMPLETED events joined to tasks.user_id
 * over the current UTC calendar day. That keeps the schema small,
 * preserves auditability (the chain alone explains every charge), and
 * makes resetting at UTC midnight automatic.
 */
export const imageQuotaOverridesTable = pgTable("image_quota_overrides", {
  user_id: text("user_id").primaryKey(),
  /** Daily count cap. NULL = use engine default. */
  max_images_per_day: integer("max_images_per_day"),
  /** Daily USD cap in CENTS (integer to avoid float drift). NULL = use engine default. */
  max_usd_cents_per_day: integer("max_usd_cents_per_day"),
  /** Free-form admin note explaining why this override exists. */
  note: text("note"),
  created_at: timestamp("created_at").notNull().defaultNow(),
  updated_at: timestamp("updated_at").notNull().defaultNow(),
});

export type ImageQuotaOverrideRow = typeof imageQuotaOverridesTable.$inferSelect;
export type NewImageQuotaOverride = typeof imageQuotaOverridesTable.$inferInsert;
