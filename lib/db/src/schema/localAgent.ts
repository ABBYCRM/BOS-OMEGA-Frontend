import {
  pgTable,
  text,
  timestamp,
  jsonb,
  integer,
  boolean,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * BOS-Omega Local Automation Agent — DB schema.
 *
 * This file owns the server-side persistence for the local-agent surface
 * (Tasks #21–#32). It intentionally lives in a single file because every
 * column on every table participates in either:
 *   - the policy engine evaluation (T003),
 *   - the hash-chained audit log (Task #22),
 *   - or the enterprise binding (this task — #32).
 * Splitting it would obscure the cross-row invariants documented inline
 * below.
 *
 * Migration / backfill rules:
 *   - All `org_id` columns are NULLABLE. Existing personal-install rows
 *     stay `NULL`; only new admin-deployment registrations are required
 *     to have one. The policy engine treats `NULL` as "no enterprise
 *     binding — fall through to per-device policy".
 *   - `install_mode` defaults to `'INDIVIDUAL_CONSENT'` so legacy rows
 *     and seed data don't silently inherit admin-deployment semantics.
 *   - `windows_session` is JSONB, validated server-side against
 *     `WindowsSessionInfoSchema` from @workspace/local-agent-contracts.
 *     We deliberately do NOT split the SID into its own column — the
 *     query patterns we need (per-task forensic lookup) all read the
 *     whole struct, and a JSONB blob keeps the contract one-to-one
 *     with the wire format.
 *   - Audit row hash chain: each `bos_audit_log` row stores both its
 *     own SHA-256 (`row_hash`) and the previous row's hash
 *     (`prev_row_hash`). Tampering anywhere breaks the chain. The
 *     chain is per-device so a device that is offline doesn't gate
 *     other devices' chains.
 */

// ---------------------------------------------------------------------------
// bos_orgs — organizations defined by a super_admin in the Enterprise tab.
// ---------------------------------------------------------------------------

export const bosOrgsTable = pgTable(
  "bos_orgs",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    display_name: text("display_name").notNull(),
    status: text("status").notNull().default("active"),
    enrollment_secret_hash: text("enrollment_secret_hash"),
    created_by_user_id: text("created_by_user_id").notNull(),
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    slug_unique: uniqueIndex("bos_orgs_slug_unique").on(t.slug),
  }),
);

export type BosOrg = typeof bosOrgsTable.$inferSelect;
export type NewBosOrg = typeof bosOrgsTable.$inferInsert;

// ---------------------------------------------------------------------------
// bos_pair_codes — single-use pairing codes for INDIVIDUAL_CONSENT registration.
// ---------------------------------------------------------------------------
// A super_admin (or an Admin in a future role expansion) mints a code in the
// Local Agent UI, hands the plaintext to the laptop user once, and the user's
// reference agent presents it to /api/v1/devices/register. Only the SHA-256
// of the code is stored. A code is single-use (consumed_at) and time-bounded
// (expires_at) — both are enforced at redemption time inside a SELECT ... FOR
// UPDATE transaction so two parallel registrations cannot both consume the
// same code.

export const bosPairCodesTable = pgTable(
  "bos_pair_codes",
  {
    id: text("id").primaryKey(),
    code_hash: text("code_hash").notNull(),
    created_by_user_id: text("created_by_user_id").notNull(),
    expires_at: timestamp("expires_at").notNull(),
    consumed_at: timestamp("consumed_at"),
    consumed_by_device_id: text("consumed_by_device_id"),
    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    code_hash_unique: uniqueIndex("bos_pair_codes_code_hash_unique").on(t.code_hash),
  }),
);

export type BosPairCode = typeof bosPairCodesTable.$inferSelect;

// ---------------------------------------------------------------------------
// bos_install_modes — reference table for the install_mode enum.
// Acts as the source of truth for valid install_mode codes; every
// `bos_devices.install_mode` is FK'd into this table so the set of
// values is enforceable + extensible without an ALTER TYPE.
// Seeded by the migration with INDIVIDUAL_CONSENT and ADMIN_DEPLOYMENT.
// ---------------------------------------------------------------------------

export const bosInstallModesTable = pgTable("bos_install_modes", {
  code: text("code").primaryKey(),
  description: text("description").notNull(),
});

export type BosInstallMode = typeof bosInstallModesTable.$inferSelect;

// ---------------------------------------------------------------------------
// bos_devices — paired Windows workstations.
// ---------------------------------------------------------------------------

export const bosDevicesTable = pgTable(
  "bos_devices",
  {
    id: text("id").primaryKey(),
    org_id: text("org_id"),
    install_mode: text("install_mode")
      .notNull()
      .default("INDIVIDUAL_CONSENT")
      .references(() => bosInstallModesTable.code),
    display_name: text("display_name").notNull(),
    hostname: text("hostname"),
    device_pubkey: text("device_pubkey").notNull(),
    // Per-device HMAC signing secret (32 random bytes, hex-encoded).
    // Generated server-side at registration, returned to the agent
    // exactly once in the registration response, and persisted here
    // for HMAC recomputation on subsequent requests. This is what the
    // signed-request middleware (`signedRequest.ts`) uses — not the
    // device public key, which is public material and would weaken
    // request authenticity if used as the HMAC secret.
    //
    // At-rest encryption / rotation are owned by Task #22 (full
    // signed-request surface); this column is the seam those changes
    // will modify, not the schema layout.
    signing_secret: text("signing_secret"),
    paired_by_user_id: text("paired_by_user_id"),
    paired_at: timestamp("paired_at").notNull().defaultNow(),
    last_seen_at: timestamp("last_seen_at"),
    status: text("status").notNull().default("active"),
    contract_version: text("contract_version").notNull().default("0.1.0"),
  },
  (t) => ({
    org_idx: index("bos_devices_org_idx").on(t.org_id),
    pubkey_unique: uniqueIndex("bos_devices_pubkey_unique").on(t.device_pubkey),
    install_mode_check: check(
      "bos_devices_install_mode_check",
      sql`${t.install_mode} IN ('INDIVIDUAL_CONSENT', 'ADMIN_DEPLOYMENT')`,
    ),
  }),
);

export type BosDevice = typeof bosDevicesTable.$inferSelect;
export type NewBosDevice = typeof bosDevicesTable.$inferInsert;

// ---------------------------------------------------------------------------
// bos_agent_policies — per-device policy snapshot.
// ---------------------------------------------------------------------------
// A device can have at most one active policy row. The policy is JSONB —
// shape is owned by the policy engine, not the schema, so a new field
// can ship without a migration. Edits go through the API which checks
// org_policy_overrides and rejects with ENTERPRISE_POLICY_FIELD_LOCKED.

export const bosAgentPoliciesTable = pgTable(
  "bos_agent_policies",
  {
    id: text("id").primaryKey(),
    device_id: text("device_id").notNull(),
    org_id: text("org_id"),
    policy: jsonb("policy").notNull(),
    version: integer("version").notNull().default(1),
    set_by_user_id: text("set_by_user_id"),
    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    device_idx: index("bos_agent_policies_device_idx").on(t.device_id),
  }),
);

export type BosAgentPolicy = typeof bosAgentPoliciesTable.$inferSelect;

// ---------------------------------------------------------------------------
// bos_org_policy_overrides — server-authoritative org locks.
// ---------------------------------------------------------------------------
// Composite-unique on (org_id, policy_field_path). When a row exists,
// devices in that org cannot widen the field locally.

export const bosOrgPolicyOverridesTable = pgTable(
  "bos_org_policy_overrides",
  {
    id: text("id").primaryKey(),
    org_id: text("org_id").notNull(),
    policy_field_path: text("policy_field_path").notNull(),
    locked_value: jsonb("locked_value").notNull(),
    set_by_user_id: text("set_by_user_id").notNull(),
    set_at: timestamp("set_at").notNull().defaultNow(),
  },
  (t) => ({
    org_path_unique: uniqueIndex("bos_org_policy_overrides_org_path_unique").on(
      t.org_id,
      t.policy_field_path,
    ),
  }),
);

export type BosOrgPolicyOverride =
  typeof bosOrgPolicyOverridesTable.$inferSelect;

// ---------------------------------------------------------------------------
// bos_task_requests — agent-submitted requests awaiting policy / approval.
// ---------------------------------------------------------------------------

export const bosTaskRequestsTable = pgTable(
  "bos_task_requests",
  {
    id: text("id").primaryKey(),
    device_id: text("device_id").notNull(),
    org_id: text("org_id"),
    windows_session: jsonb("windows_session").notNull(),
    action: jsonb("action").notNull(),
    decision: text("decision").notNull(),
    rejection_reason: text("rejection_reason"),
    requested_at: timestamp("requested_at").notNull().defaultNow(),
    decided_at: timestamp("decided_at"),
  },
  (t) => ({
    device_idx: index("bos_task_requests_device_idx").on(t.device_id),
    org_idx: index("bos_task_requests_org_idx").on(t.org_id),
  }),
);

export type BosTaskRequest = typeof bosTaskRequestsTable.$inferSelect;

// ---------------------------------------------------------------------------
// bos_approval_tokens — one-shot tokens issued to a specific session.
// ---------------------------------------------------------------------------

export const bosApprovalTokensTable = pgTable(
  "bos_approval_tokens",
  {
    id: text("id").primaryKey(),
    task_request_id: text("task_request_id").notNull(),
    device_id: text("device_id").notNull(),
    org_id: text("org_id"),
    bound_session_sid: text("bound_session_sid").notNull(),
    approved_by_user_id: text("approved_by_user_id").notNull(),
    issued_at: timestamp("issued_at").notNull().defaultNow(),
    expires_at: timestamp("expires_at").notNull(),
    consumed_at: timestamp("consumed_at"),
    signature: text("signature").notNull(),
  },
  (t) => ({
    request_idx: index("bos_approval_tokens_request_idx").on(t.task_request_id),
  }),
);

export type BosApprovalToken = typeof bosApprovalTokensTable.$inferSelect;

// ---------------------------------------------------------------------------
// bos_task_executions — outcome of an approved task.
// ---------------------------------------------------------------------------

export const bosTaskExecutionsTable = pgTable(
  "bos_task_executions",
  {
    id: text("id").primaryKey(),
    task_request_id: text("task_request_id").notNull(),
    approval_token_id: text("approval_token_id").notNull(),
    device_id: text("device_id").notNull(),
    org_id: text("org_id"),
    windows_session: jsonb("windows_session").notNull(),
    outcome_kind: text("outcome_kind").notNull(),
    outcome: jsonb("outcome").notNull(),
    started_at: timestamp("started_at").notNull(),
    finished_at: timestamp("finished_at").notNull(),
    recorded_at: timestamp("recorded_at").notNull().defaultNow(),
  },
  (t) => ({
    request_idx: index("bos_task_executions_request_idx").on(t.task_request_id),
    org_idx: index("bos_task_executions_org_idx").on(t.org_id),
  }),
);

export type BosTaskExecution = typeof bosTaskExecutionsTable.$inferSelect;

// ---------------------------------------------------------------------------
// bos_audit_log — hash-chained audit trail.
// ---------------------------------------------------------------------------

export const bosAuditLogTable = pgTable(
  "bos_audit_log",
  {
    id: text("id").primaryKey(),
    device_id: text("device_id"),
    org_id: text("org_id"),
    actor_user_id: text("actor_user_id"),
    event_type: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    windows_session: jsonb("windows_session"),
    prev_row_hash: text("prev_row_hash"),
    row_hash: text("row_hash").notNull(),
    is_critical: boolean("is_critical").notNull().default(false),
    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    device_idx: index("bos_audit_log_device_idx").on(t.device_id, t.created_at),
    org_idx: index("bos_audit_log_org_idx").on(t.org_id, t.created_at),
    event_idx: index("bos_audit_log_event_idx").on(t.event_type),
  }),
);

export type BosAuditLogRow = typeof bosAuditLogTable.$inferSelect;
