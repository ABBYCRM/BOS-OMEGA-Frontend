CREATE TABLE IF NOT EXISTS "llm_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"base_url" text,
	"status" text DEFAULT 'HEALTHY' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 5 NOT NULL,
	"api_key_env" text,
	"api_key_encrypted" text,
	"api_key_hint" text,
	"last_test_status" text,
	"last_test_message" text,
	"last_test_at" timestamp,
	"discovered_models_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "llm_models" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"model_name" text NOT NULL,
	"capability_tags" text[] DEFAULT '{}' NOT NULL,
	"context_window" integer DEFAULT 8192 NOT NULL,
	"cost_input" real DEFAULT 0 NOT NULL,
	"cost_output" real DEFAULT 0 NOT NULL,
	"reliability_score" real DEFAULT 0.9 NOT NULL,
	"latency_score" real DEFAULT 0.8 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"input_text" text NOT NULL,
	"task_type" text NOT NULL,
	"tri_state" text NOT NULL,
	"selected_provider" text,
	"selected_model" text,
	"final_status" text DEFAULT 'pending' NOT NULL,
	"final_output" text,
	"mode" text DEFAULT 'single' NOT NULL,
	"conversation_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "model_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"attempt_number" integer DEFAULT 1 NOT NULL,
	"status" text NOT NULL,
	"error_type" text,
	"latency_ms" real,
	"token_input" integer,
	"token_output" integer,
	"cost_estimate" real,
	"raw_response" text,
	"is_parallel" boolean DEFAULT false NOT NULL,
	"parallel_group" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "validation_results" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"attempt_id" text,
	"schema_pass" boolean DEFAULT false NOT NULL,
	"safety_pass" boolean DEFAULT false NOT NULL,
	"instruction_pass" boolean DEFAULT false NOT NULL,
	"completeness_pass" boolean DEFAULT false NOT NULL,
	"confidence_score" real DEFAULT 0 NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fallback_events" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"from_provider" text,
	"from_model" text,
	"to_provider" text,
	"to_model" text,
	"reason" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_health" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"status" text DEFAULT 'HEALTHY' NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"schema_failure_count" integer DEFAULT 0 NOT NULL,
	"last_failure" timestamp,
	"last_success" timestamp,
	"avg_latency_ms" real DEFAULT 0 NOT NULL,
	"circuit_opened_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "provider_health_provider_id_unique" UNIQUE("provider_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memory_items" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"layer" text DEFAULT 'scratchpad' NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"authority_level" integer DEFAULT 5 NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"source_task_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text,
	"event_type" text NOT NULL,
	"message" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "execution_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text,
	"mode" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"total_passes" integer,
	"total_agents" integer,
	"models_used" text[],
	"final_score" real,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "series_passes" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text,
	"pass_number" integer NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"role" text NOT NULL,
	"input_snapshot" text,
	"output_snapshot" text,
	"validation_score" real,
	"errors_found" text[],
	"state" text,
	"latency_ms" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "parallel_agents" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"agent_role" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"output" text,
	"score" real,
	"state" text,
	"error_type" text,
	"latency_ms" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "synthesis_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text,
	"consensus_points" text[],
	"contradictions" text[],
	"strongest_sections" text[],
	"rejected_sections" text[],
	"final_synthesis" text,
	"omega_validation" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tri_state_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text,
	"go_score" real NOT NULL,
	"hold_score" real NOT NULL,
	"abort_score" real NOT NULL,
	"evidence_signals" text,
	"collapse_reason" text NOT NULL,
	"final_state" text NOT NULL,
	"confidence_score" real,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text,
	"user_id" text,
	"original_name" text NOT NULL,
	"mime" text NOT NULL,
	"kind" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"extracted_text" text,
	"extraction_status" text DEFAULT 'pending' NOT NULL,
	"extraction_error" text,
	"extraction_meta" text,
	"width" integer,
	"height" integer,
	"duration_ms" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"last_login_at" timestamp
);
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
CREATE TABLE IF NOT EXISTS "bos_devices" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text,
	"install_mode" text DEFAULT 'INDIVIDUAL_CONSENT' NOT NULL,
	"display_name" text NOT NULL,
	"hostname" text,
	"device_pubkey" text NOT NULL,
	"signing_secret" text,
	"paired_by_user_id" text,
	"paired_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp,
	"status" text DEFAULT 'active' NOT NULL,
	"contract_version" text DEFAULT '0.1.0' NOT NULL,
	CONSTRAINT "bos_devices_install_mode_check" CHECK ("bos_devices"."install_mode" IN ('INDIVIDUAL_CONSENT', 'ADMIN_DEPLOYMENT'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bos_install_modes" (
	"code" text PRIMARY KEY NOT NULL,
	"description" text NOT NULL
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
CREATE TABLE IF NOT EXISTS "user_memory_budgets" (
	"user_id" text PRIMARY KEY NOT NULL,
	"canon_budget" integer DEFAULT 3000 NOT NULL,
	"continuity_budget" integer DEFAULT 1500 NOT NULL,
	"patches_budget" integer DEFAULT 1000 NOT NULL,
	"scratchpad_budget" integer DEFAULT 750 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"topic_keywords" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_active_at" timestamp DEFAULT now() NOT NULL,
	"archived" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lattice_exports" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"fidelity_sha256" text NOT NULL,
	"byte_size" integer NOT NULL,
	"task_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "image_quota_overrides" (
	"user_id" text PRIMARY KEY NOT NULL,
	"max_images_per_day" integer,
	"max_usd_cents_per_day" integer,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_runs" ADD CONSTRAINT "execution_runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_passes" ADD CONSTRAINT "series_passes_run_id_execution_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."execution_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parallel_agents" ADD CONSTRAINT "parallel_agents_run_id_execution_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."execution_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthesis_reports" ADD CONSTRAINT "synthesis_reports_run_id_execution_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."execution_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bos_devices" ADD CONSTRAINT "bos_devices_install_mode_bos_install_modes_code_fk" FOREIGN KEY ("install_mode") REFERENCES "public"."bos_install_modes"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_conversation_id_created_at_idx" ON "tasks" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attachments_task_id_idx" ON "attachments" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attachments_sha256_idx" ON "attachments" USING btree ("sha256");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
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
CREATE INDEX IF NOT EXISTS "bos_task_requests_org_idx" ON "bos_task_requests" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_user_idx" ON "conversations" USING btree ("user_id","last_active_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lattice_exports_user_idx" ON "lattice_exports" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"scopes" jsonb DEFAULT '[]' NOT NULL,
	"expires_at" timestamp,
	"last_used_at" timestamp,
	"revoked_at" timestamp,
	"revoked_reason" text,
	"power_shell_only" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_token_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"token_id" text,
	"user_id" text NOT NULL,
	"event_type" text NOT NULL,
	"ip" text,
	"user_agent" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "api_tokens_hash_idx" ON "api_tokens" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_tokens_user_idx" ON "api_tokens" USING btree ("user_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_token_audit_token_idx" ON "api_token_audit" USING btree ("token_id","created_at");
