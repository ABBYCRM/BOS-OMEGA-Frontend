-- Task #85 — image-generation spend caps.
--
-- Per-user override row (PK = user_id) lets a super_admin tighten or
-- relax the engine-default daily image-count and USD ceilings for a
-- specific user. Both columns are nullable: NULL means "fall back to
-- the env-driven default" so a partial override (e.g. tighter USD cap
-- but default count) doesn't have to repeat the unset side.
--
-- IF NOT EXISTS keeps this migration safe to apply on dev DBs where
-- the table was already created via `drizzle-kit push --force` during
-- iterative development.
CREATE TABLE IF NOT EXISTS "image_quota_overrides" (
  "user_id" text PRIMARY KEY NOT NULL,
  "max_images_per_day" integer,
  "max_usd_cents_per_day" integer,
  "note" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
