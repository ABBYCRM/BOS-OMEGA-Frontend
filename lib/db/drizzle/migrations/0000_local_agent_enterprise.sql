-- Local Agent enterprise / multi-user foundation (Task #32).
--
-- This migration is intentionally additive. It creates only the new
-- bos_* tables and indexes; it does NOT touch any pre-existing
-- platform tables (llm_providers, tasks, users, attachments, etc.),
-- which were created earlier via `drizzle-kit push` against a live
-- DB. Each statement uses IF NOT EXISTS so the file is safe to
-- replay against an environment that already had `db push` run.
--
-- Backfill notes:
--   - bos_devices.install_mode defaults to 'INDIVIDUAL_CONSENT' so
--     any device row written before the column existed is treated
--     as a personal install (matches the historical default).
--   - bos_devices.org_id is nullable; existing rows remain
--     personal-scope (org_id NULL) until an admin explicitly
--     attaches them to an org.
--   - bos_devices.contract_version defaults to '0.1.0', which is
--     the value LOCAL_AGENT_CONTRACT_VERSION in
--     @workspace/local-agent-contracts at the time of this
--     migration.
--
-- Day-to-day schema evolution remains `pnpm --filter @workspace/db
-- run push`; this artifact exists so a fresh / cold-start
-- deployment can be brought to the Task #32 schema state via
-- `drizzle-kit migrate` without depending on the live shadow DB.

CREATE TABLE IF NOT EXISTS "bos_orgs" (
        "id" text PRIMARY KEY NOT NULL,
        "slug" text NOT NULL,
        "display_name" text NOT NULL,
        "status" text DEFAULT 'active' NOT NULL,
        "enrollment_secret_hash" text,
        "created_by_user_id" text NOT NULL,
        "created_at" timestamp DEFAULT now() NOT NULL,
        "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bos_pair_codes" (
        "id" text PRIMARY KEY NOT NULL,
        "code_hash" text NOT NULL,
        "created_by_user_id" text NOT NULL,
        "expires_at" timestamp NOT NULL,
        "consumed_at" timestamp,
        "consumed_by_device_id" text,
        "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Reference table for install_mode codes. Seeded immediately so the
-- FK on bos_devices.install_mode is satisfiable on first insert.
CREATE TABLE IF NOT EXISTS "bos_install_modes" (
        "code" text PRIMARY KEY NOT NULL,
        "description" text NOT NULL
);
--> statement-breakpoint
INSERT INTO "bos_install_modes" ("code", "description") VALUES
        ('INDIVIDUAL_CONSENT', 'Personal install — laptop user paired by typing a one-time code'),
        ('ADMIN_DEPLOYMENT', 'Managed deployment — agent enrolled via org enrollment secret')
ON CONFLICT ("code") DO NOTHING;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bos_devices" (
        "id" text PRIMARY KEY NOT NULL,
        "org_id" text,
        "install_mode" text DEFAULT 'INDIVIDUAL_CONSENT' NOT NULL REFERENCES "bos_install_modes"("code"),
        "display_name" text NOT NULL,
        "hostname" text,
        "device_pubkey" text NOT NULL,
        "signing_secret" text,
        "paired_by_user_id" text,
        "paired_at" timestamp DEFAULT now() NOT NULL,
        "last_seen_at" timestamp,
        "status" text DEFAULT 'active' NOT NULL,
        "contract_version" text DEFAULT '0.1.0' NOT NULL
);
--> statement-breakpoint
-- Replay-safe upgrade path: a bos_devices table created by an earlier
-- `db push` may be missing the new enterprise columns or the FK to
-- bos_install_modes. ADD COLUMN IF NOT EXISTS lets us bring the
-- schema forward without dropping the existing rows.
ALTER TABLE "bos_devices" ADD COLUMN IF NOT EXISTS "org_id" text;--> statement-breakpoint
ALTER TABLE "bos_devices" ADD COLUMN IF NOT EXISTS "install_mode" text DEFAULT 'INDIVIDUAL_CONSENT' NOT NULL;--> statement-breakpoint
ALTER TABLE "bos_devices" ADD COLUMN IF NOT EXISTS "signing_secret" text;--> statement-breakpoint
ALTER TABLE "bos_devices" ADD COLUMN IF NOT EXISTS "contract_version" text DEFAULT '0.1.0' NOT NULL;--> statement-breakpoint
DO $$
BEGIN
        IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'bos_devices_install_mode_bos_install_modes_code_fk'
        ) THEN
                ALTER TABLE "bos_devices"
                        ADD CONSTRAINT "bos_devices_install_mode_bos_install_modes_code_fk"
                        FOREIGN KEY ("install_mode") REFERENCES "bos_install_modes"("code");
        END IF;
END$$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bos_agent_policies" (
        "id" text PRIMARY KEY NOT NULL,
        "device_id" text NOT NULL,
        "org_id" text,
        "policy" jsonb NOT NULL,
        "version" integer DEFAULT 1 NOT NULL,
        "set_by_user_id" text,
        "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bos_org_policy_overrides" (
        "id" text PRIMARY KEY NOT NULL,
        "org_id" text NOT NULL,
        "policy_field_path" text NOT NULL,
        "locked_value" jsonb NOT NULL,
        "set_by_user_id" text NOT NULL,
        "set_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bos_task_requests" (
        "id" text PRIMARY KEY NOT NULL,
        "device_id" text NOT NULL,
        "org_id" text,
        "windows_session" jsonb NOT NULL,
        "action" jsonb NOT NULL,
        "decision" text NOT NULL,
        "rejection_reason" text,
        "requested_at" timestamp DEFAULT now() NOT NULL,
        "decided_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bos_approval_tokens" (
        "id" text PRIMARY KEY NOT NULL,
        "task_request_id" text NOT NULL,
        "device_id" text NOT NULL,
        "org_id" text,
        "bound_session_sid" text NOT NULL,
        "approved_by_user_id" text NOT NULL,
        "issued_at" timestamp DEFAULT now() NOT NULL,
        "expires_at" timestamp NOT NULL,
        "consumed_at" timestamp,
        "signature" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bos_task_executions" (
        "id" text PRIMARY KEY NOT NULL,
        "task_request_id" text NOT NULL,
        "approval_token_id" text NOT NULL,
        "device_id" text NOT NULL,
        "org_id" text,
        "windows_session" jsonb NOT NULL,
        "outcome_kind" text NOT NULL,
        "outcome" jsonb NOT NULL,
        "started_at" timestamp NOT NULL,
        "finished_at" timestamp NOT NULL,
        "recorded_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bos_audit_log" (
        "id" text PRIMARY KEY NOT NULL,
        "device_id" text,
        "org_id" text,
        "actor_user_id" text,
        "event_type" text NOT NULL,
        "payload" jsonb NOT NULL,
        "windows_session" jsonb,
        "prev_row_hash" text,
        "row_hash" text NOT NULL,
        "is_critical" boolean DEFAULT false NOT NULL,
        "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Replay-safe upgrade path for previously-existing local-agent tables.
-- If a prior task workstream created these tables without enterprise
-- columns, ADD COLUMN IF NOT EXISTS brings them forward without
-- dropping rows. windows_session is added nullable on upgrade so
-- pre-existing rows do not violate NOT NULL; future migrations may
-- tighten it after backfill.
ALTER TABLE "bos_agent_policies" ADD COLUMN IF NOT EXISTS "org_id" text;--> statement-breakpoint
ALTER TABLE "bos_task_requests" ADD COLUMN IF NOT EXISTS "org_id" text;--> statement-breakpoint
ALTER TABLE "bos_task_requests" ADD COLUMN IF NOT EXISTS "windows_session" jsonb;--> statement-breakpoint
ALTER TABLE "bos_approval_tokens" ADD COLUMN IF NOT EXISTS "org_id" text;--> statement-breakpoint
ALTER TABLE "bos_task_executions" ADD COLUMN IF NOT EXISTS "org_id" text;--> statement-breakpoint
ALTER TABLE "bos_task_executions" ADD COLUMN IF NOT EXISTS "windows_session" jsonb;--> statement-breakpoint
ALTER TABLE "bos_audit_log" ADD COLUMN IF NOT EXISTS "org_id" text;--> statement-breakpoint
ALTER TABLE "bos_audit_log" ADD COLUMN IF NOT EXISTS "windows_session" jsonb;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bos_agent_policies_device_idx" ON "bos_agent_policies" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bos_approval_tokens_request_idx" ON "bos_approval_tokens" USING btree ("task_request_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bos_audit_log_device_idx" ON "bos_audit_log" USING btree ("device_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bos_audit_log_org_idx" ON "bos_audit_log" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bos_audit_log_event_idx" ON "bos_audit_log" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bos_devices_org_idx" ON "bos_devices" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bos_devices_pubkey_unique" ON "bos_devices" USING btree ("device_pubkey");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bos_org_policy_overrides_org_path_unique" ON "bos_org_policy_overrides" USING btree ("org_id","policy_field_path");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bos_orgs_slug_unique" ON "bos_orgs" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bos_pair_codes_code_hash_unique" ON "bos_pair_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bos_task_executions_request_idx" ON "bos_task_executions" USING btree ("task_request_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bos_task_executions_org_idx" ON "bos_task_executions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bos_task_requests_device_idx" ON "bos_task_requests" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bos_task_requests_org_idx" ON "bos_task_requests" USING btree ("org_id");
