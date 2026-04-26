/**
 * @workspace/local-agent-contracts
 *
 * Wire-format and shared TS types for the BOS-Omega Local Automation
 * Agent. This package owns the contract that the server (`api-server`),
 * the bos-omega UI, the reference test agent, and the future Windows
 * native agent must all agree on.
 *
 * Workstream split (the source-of-truth layer-cut for the local agent):
 *   - Task #21: schema + contracts + base policy engine.
 *   - Task #22: signed-request middleware + tamper-evident audit.
 *   - Task #23: pairing/approval/audit UI on bos-omega.
 *   - Task #24: reference agent + gated dev console.
 *   - Task #25: spec test matrix.
 *   - Task #26-29: Windows-native runtime (deferred).
 *   - Task #32 (this task): multi-user / enterprise hooks. Adds
 *     `OrgScope`, `EnterprisePolicyBinding`, `WindowsSessionInfo`,
 *     `InstallMode`, and the `windows_session` field on every transport
 *     event. Must be designed so #21 lands on top without rewriting
 *     consumers.
 *
 * IMPORTANT: types here are wire-format. Do NOT change a field name or
 * shape without bumping the package version and updating every consumer.
 * The reference agent (Task #24) and the Windows agent (Task #26) both
 * depend on this contract being stable across releases.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

/**
 * Bumped whenever a breaking wire-format change is introduced. The agent
 * sends this on its first request after pairing; the server rejects any
 * agent whose major version is unknown.
 */
export const LOCAL_AGENT_CONTRACT_VERSION = "0.2.0" as const;

// ---------------------------------------------------------------------------
// Install modes
// ---------------------------------------------------------------------------

/**
 * How a device was registered to the server.
 *
 * - `INDIVIDUAL_CONSENT`: the human at the keyboard ran the installer,
 *   entered a pair code surfaced in the bos-omega UI, and confirmed the
 *   device on the approval screen. This is the default and matches the
 *   personal-laptop install story.
 *
 * - `ADMIN_DEPLOYMENT`: the device came up under a management tool
 *   (Intune / GPO / RMM / silent MSI), read an org-level config file
 *   containing an enrollment secret, and registered against the server
 *   without an interactive pair-code dance. The device is bound to the
 *   org at registration and cannot be moved between orgs locally.
 *
 * Existing personal-install rows that pre-date this column are
 * backfilled to `INDIVIDUAL_CONSENT` and stay unaffected.
 */
export type InstallMode = "INDIVIDUAL_CONSENT" | "ADMIN_DEPLOYMENT";

export const InstallModeSchema = z.enum([
  "INDIVIDUAL_CONSENT",
  "ADMIN_DEPLOYMENT",
]);

// ---------------------------------------------------------------------------
// Org scope
// ---------------------------------------------------------------------------

/**
 * An organization the agent is bound to. Defined by a super_admin in the
 * bos-omega Enterprise tab and stored in `bos_orgs`.
 *
 * `slug` is intentionally the human handle used in URLs and config files
 * — short, lowercase, dash-or-underscore — so an enterprise admin can
 * write `org_enrollment_secret` against a memorable handle instead of a
 * UUID. The slug is unique server-side; once issued it is not renamed.
 */
export type OrgScope = {
  org_id: string;
  slug: string;
  display_name: string;
  status: "active" | "archived";
};

export const OrgScopeSchema: z.ZodType<OrgScope> = z.object({
  org_id: z.string().uuid(),
  slug: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, "slug must be lower-kebab/snake"),
  display_name: z.string().min(1).max(200),
  status: z.enum(["active", "archived"]),
});

// ---------------------------------------------------------------------------
// Policy field paths and enterprise binding
// ---------------------------------------------------------------------------

/**
 * Org-locked policy fields are addressed by a path string instead of an
 * enum so future schema additions don't require a coordinated release of
 * the contract package. Path segments are dot-separated and constrained
 * to the same regex as JSON object keys we generate ourselves
 * (`[a-z0-9_]+`). Arbitrary characters are NOT allowed — the path is
 * sometimes used as a JSONB lookup, and we want a tight grammar.
 *
 * Examples:
 *   - `allowlist.scripts.signed_bos_scripts`
 *   - `blocklist.extensions.exe`
 *   - `network.outbound.cidrs`
 *   - `prompts.require_user_confirmation`
 */
export type PolicyFieldPath = string & { readonly __brand: "PolicyFieldPath" };

export const PolicyFieldPathSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/, "Invalid policy field path")
  .transform((v) => v as PolicyFieldPath);

/**
 * One row of `bos_org_policy_overrides`. When present for a given
 * `(org_id, policy_field_path)` pair, the device-local policy MUST
 * NOT widen that field. The policy engine compares the device-local
 * value to `locked_value`; a "wider" value (e.g. adding more entries
 * to an allowlist, lowering a confirmation requirement) is rejected
 * with `ENTERPRISE_POLICY_FIELD_LOCKED`.
 *
 * `locked_value` is an opaque JSON blob — the policy engine knows how
 * to compare values per-field. New field paths just add a comparator
 * registration; the table schema itself doesn't change.
 */
export type EnterprisePolicyOverride = {
  org_id: string;
  policy_field_path: PolicyFieldPath;
  locked_value: unknown;
  set_by_user_id: string;
  set_at: string; // ISO-8601
};

/**
 * The enterprise binding handed to the policy engine. Concentrating the
 * org-level inputs in a single struct keeps the engine signature tidy
 * and lets us add fields (e.g. tenant-wide kill switches) without a
 * fan-out across every call site.
 */
export type EnterprisePolicyBinding = {
  org: OrgScope;
  overrides: ReadonlyArray<EnterprisePolicyOverride>;
};

// ---------------------------------------------------------------------------
// Windows session info
// ---------------------------------------------------------------------------

/**
 * Description of the Windows interactive session a task is being run
 * for. Sent by the agent on every task evaluation, execution, and
 * audit event. Persisted on the matching DB rows so an auditor can
 * answer "which logged-in human's session executed this script?"
 *
 * SECURITY MODEL: this struct is treated as untrusted input from the
 * agent. We persist it and use it for binding (e.g. an approval issued
 * for SID A cannot be consumed by a request from SID B), but we never
 * use it to elevate trust. The cryptographic device identity (Task #21
 * / Task #26) remains the root of trust.
 *
 * `sid` is the Windows SID string (e.g. `S-1-5-21-...`). On non-Windows
 * platforms (the reference agent's CI mode) the agent populates a
 * synthetic SID-shaped string so the contract stays uniform.
 */
export type WindowsSessionInfo = {
  sid: string;
  username: string;
  session_id: number;
  is_remote_session: boolean;
  is_admin_session: boolean;
};

export const WindowsSessionInfoSchema: z.ZodType<WindowsSessionInfo> = z.object({
  // Windows SIDs start with `S-` and contain hyphenated decimal segments.
  // The reference agent in non-Windows mode emits a synthetic
  // `S-REF-<uuid>` — the regex below allows both shapes.
  sid: z
    .string()
    .min(3)
    .max(184)
    .regex(/^S-[A-Za-z0-9-]+$/, "Invalid Windows SID format"),
  username: z.string().min(1).max(256),
  session_id: z.number().int().min(0).max(0xffffffff),
  is_remote_session: z.boolean(),
  is_admin_session: z.boolean(),
});

// ---------------------------------------------------------------------------
// Rejection reasons
// ---------------------------------------------------------------------------

/**
 * Wire-stable reason strings the policy engine emits when a request,
 * approval, or execution is rejected. Adding a new reason is non-
 * breaking; renaming an existing one IS breaking and requires a contract
 * version bump.
 *
 * Tasks #21 owns `POLICY_*` reasons; this task (#32) adds the
 * `ENTERPRISE_*` and `SESSION_*` reasons. They live in the same enum so
 * audit log filtering can treat them uniformly.
 */
export type LocalAgentRejectionReason =
  // Personal-install policy reasons (defined in Task #21).
  | "POLICY_NOT_IN_ALLOWLIST"
  | "POLICY_BLOCKED_EXTENSION"
  | "POLICY_REQUIRES_CONFIRMATION"
  | "POLICY_OUTBOUND_CIDR_DENIED"
  | "POLICY_RATE_LIMITED"
  // Enterprise additions (this task).
  | "ENTERPRISE_POLICY_FIELD_LOCKED"
  | "ENTERPRISE_ORG_MISMATCH"
  | "SESSION_BINDING_MISMATCH"
  | "SESSION_INFO_MALFORMED"
  | "INSTALL_MODE_DOWNGRADE_DENIED";

// ---------------------------------------------------------------------------
// Transport interface — the wire contract every agent implements
// ---------------------------------------------------------------------------

/**
 * The shape of a task evaluation request the agent sends to the server.
 *
 * The server uses `windows_session` (a) to bind the eventual approval
 * token to this exact session and (b) to persist on the audit row so
 * forensics can answer the "which human" question after the fact.
 *
 * `org_id` is non-null only for devices registered under
 * `ADMIN_DEPLOYMENT`. Personal-install devices send `org_id: null` and
 * skip the enterprise checks entirely.
 */
export type LocalAgentTaskRequestPayload = {
  task_request_id: string;
  device_id: string;
  org_id: string | null;
  windows_session: WindowsSessionInfo;
  action: {
    kind: "exec_script" | "exec_binary" | "modify_file" | "outbound_http";
    target: string;
    args?: ReadonlyArray<string>;
    metadata?: Record<string, unknown>;
  };
  requested_at: string; // ISO-8601
  contract_version: typeof LOCAL_AGENT_CONTRACT_VERSION;
};

/**
 * Approval token issued by the server after a human approves the task
 * in the bos-omega UI. The agent presents this back on the execution
 * request; the server checks that:
 *   - the token is bound to the same `device_id` and `windows_session.sid`,
 *   - the token has not been consumed (one-shot),
 *   - the device's `org_id` matches the approver's `org_id` (when both
 *     sides are org-bound).
 */
export type LocalAgentApprovalToken = {
  token_id: string;
  task_request_id: string;
  device_id: string;
  org_id: string | null;
  bound_session_sid: string;
  approved_by_user_id: string;
  issued_at: string;
  expires_at: string;
  signature: string;
};

/**
 * Execution report posted back by the agent after running (or refusing
 * to run) the action. Persisted on `bos_task_executions` and joined
 * into the hash-chained audit log.
 */
export type LocalAgentExecutionReport = {
  task_request_id: string;
  device_id: string;
  org_id: string | null;
  windows_session: WindowsSessionInfo;
  approval_token_id: string;
  outcome:
    | { kind: "completed"; exit_code: number; stdout_excerpt: string }
    | { kind: "refused"; reason: LocalAgentRejectionReason }
    | { kind: "timeout" }
    | { kind: "agent_error"; message: string };
  started_at: string;
  finished_at: string;
};

/**
 * The transport interface all agent implementations satisfy. Both the
 * reference agent (Task #24, also extended in this task for
 * enrollment-secret pairing) and the future Windows native agent (Task
 * #26) consume this interface.
 *
 * Implementations are responsible for:
 *   - signing requests with the device key (Task #22),
 *   - retry/backoff,
 *   - pinning the server's TLS cert.
 *
 * The interface intentionally returns server-side row IDs and discrete
 * outcomes, not raw HTTP responses, so it can be re-implemented over a
 * named-pipe / IPC transport without changing callers.
 */
export interface LocalAgentTransport {
  registerDevice(args: {
    install_mode: InstallMode;
    pair_code?: string;
    org_enrollment_secret?: string;
    contract_version: typeof LOCAL_AGENT_CONTRACT_VERSION;
  }): Promise<{
    device_id: string;
    org_id: string | null;
    install_mode: InstallMode;
  }>;

  submitTaskRequest(payload: LocalAgentTaskRequestPayload): Promise<{
    task_request_id: string;
    decision: "AUTO_APPROVED" | "AWAITING_APPROVAL" | "REJECTED";
    rejection_reason?: LocalAgentRejectionReason;
  }>;

  awaitApproval(task_request_id: string): Promise<LocalAgentApprovalToken>;

  reportExecution(report: LocalAgentExecutionReport): Promise<{ ok: true }>;
}

// ---------------------------------------------------------------------------
// Enterprise enrollment config (consumed by Windows tasks #27/#29)
// ---------------------------------------------------------------------------

/**
 * The on-disk JSON config the agent reads at start when launched under
 * `ADMIN_DEPLOYMENT`. The MSI (Task #29) and tray (Task #27) lay this
 * file down at a well-known path on first boot from the org's config
 * package. The agent does not write this file; it is read-only input
 * provided by the management tool.
 *
 * `allowlist_overrides` and `blocklist_extensions` here are
 * org-suggested defaults applied on first boot. They do NOT supersede
 * `bos_org_policy_overrides` server-side — that is the authoritative
 * lock surface.
 */
export type EnterpriseAgentConfigFile = {
  server_url: string;
  org_enrollment_secret: string;
  allowlist_overrides?: ReadonlyArray<string>;
  blocklist_extensions?: ReadonlyArray<string>;
  telemetry_endpoint?: string;
  audit_export_endpoint?: string;
  contract_version?: typeof LOCAL_AGENT_CONTRACT_VERSION;
};

export const EnterpriseAgentConfigFileSchema: z.ZodType<EnterpriseAgentConfigFile> =
  z.object({
    server_url: z.string().url(),
    org_enrollment_secret: z.string().min(32).max(512),
    allowlist_overrides: z.array(z.string().min(1).max(1024)).optional(),
    blocklist_extensions: z
      .array(z.string().regex(/^\.[a-z0-9]+$/i, "extensions look like .exe"))
      .optional(),
    telemetry_endpoint: z.string().url().optional(),
    audit_export_endpoint: z.string().url().optional(),
    contract_version: z.literal(LOCAL_AGENT_CONTRACT_VERSION).optional(),
  });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Cheap structural compare for whether `candidate` is "wider" than
 * `locked` for the given policy field. The policy engine uses this for
 * `ENTERPRISE_POLICY_FIELD_LOCKED` checks. The semantics are
 * deliberately conservative: arrays must be exact subsets, scalars
 * must be equal. Anything ambiguous defaults to "wider" (i.e. blocked)
 * so a misconfigured local override can never silently bypass an
 * enterprise lock.
 */
export function isWiderThanLockedValue(
  candidate: unknown,
  locked: unknown,
): boolean {
  if (Array.isArray(locked)) {
    if (!Array.isArray(candidate)) return true;
    const lockedSet = new Set(locked.map((x) => JSON.stringify(x)));
    for (const item of candidate) {
      if (!lockedSet.has(JSON.stringify(item))) return true;
    }
    return false;
  }
  if (typeof locked === "boolean" || typeof locked === "number" || typeof locked === "string") {
    return candidate !== locked;
  }
  if (locked === null) return candidate !== null;
  // Object-valued locks: require exact deep equality. Future field-
  // specific comparators can override this path before reaching here.
  return JSON.stringify(candidate) !== JSON.stringify(locked);
}
