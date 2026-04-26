/**
 * @workspace/local-agent-policy
 *
 * Pure, side-effect-free policy engine for the BOS-Omega Local
 * Automation Agent. Every function here takes typed inputs and returns
 * a typed decision — no DB, no network, no clock (callers pass `now`
 * explicitly for replay-friendly testing).
 *
 * Tasks #21 owns the bulk of the per-device policy fields (allowlist,
 * blocklist, confirmation, network) and the BOS-POLICY-001..010 spec
 * test cases. This task (#32) extends the engine signature to accept
 * an optional `EnterprisePolicyBinding` and adds enterprise-class
 * rejection paths:
 *   - `ENTERPRISE_POLICY_FIELD_LOCKED` — a device-local policy edit
 *     attempted to widen an org-locked field.
 *   - `ENTERPRISE_ORG_MISMATCH` — the approver's `org_id` does not
 *     match the device's `org_id`.
 *   - `SESSION_BINDING_MISMATCH` — the executing Windows session is
 *     not the one the approval was issued for.
 *   - `INSTALL_MODE_DOWNGRADE_DENIED` — an admin-deployment device
 *     attempted to re-pair as individual-consent.
 *
 * INVARIANT: the engine never relaxes a per-device policy. Adding an
 * org binding can only narrow the device's effective policy. A device
 * with no org binding behaves exactly as today (the binding parameter
 * is optional).
 */

import {
  type EnterprisePolicyBinding,
  type EnterprisePolicyOverride,
  type InstallMode,
  type LocalAgentRejectionReason,
  type PolicyFieldPath,
  type WindowsSessionInfo,
  isWiderThanLockedValue,
} from "@workspace/local-agent-contracts";

// ---------------------------------------------------------------------------
// Per-device policy shape (the JSONB stored in bos_agent_policies.policy)
// ---------------------------------------------------------------------------

/**
 * A device-local policy. Shape-compatible with what Task #21 will land:
 * we deliberately use a path-keyed shape so future fields don't require
 * a contract bump. The engine here only inspects the fields it knows
 * about and ignores the rest — tomorrow's field is not blocked by
 * today's release.
 */
export type DevicePolicy = {
  // The values are kept loose because the field set evolves. Concrete
  // typing happens at the comparator-registration site.
  values: Record<PolicyFieldPath, unknown>;
};

// ---------------------------------------------------------------------------
// Policy edit — checked against enterprise locks before being persisted
// ---------------------------------------------------------------------------

export type PolicyEditAttempt = {
  device_id: string;
  device_install_mode: InstallMode;
  current_policy: DevicePolicy;
  proposed_changes: ReadonlyArray<{
    field_path: PolicyFieldPath;
    new_value: unknown;
  }>;
};

export type PolicyEditDecision =
  | { kind: "accepted"; resulting_policy: DevicePolicy }
  | {
      kind: "rejected";
      reason: LocalAgentRejectionReason;
      blocked_field_path?: PolicyFieldPath;
      detail: string;
    };

/**
 * Evaluate a policy edit against the org binding. The check is:
 *
 *   for each proposed change:
 *     if the field is org-locked AND the new value is wider than the
 *     locked value → REJECT.
 *     else → accept the change into the resulting policy.
 *
 * "Wider" is intentionally conservative — any structural ambiguity
 * defaults to wider, so a misconfigured local edit cannot silently
 * bypass an enterprise lock. See `isWiderThanLockedValue`.
 */
export function evaluatePolicyEdit(
  attempt: PolicyEditAttempt,
  binding: EnterprisePolicyBinding | null,
): PolicyEditDecision {
  const lockMap = new Map<PolicyFieldPath, EnterprisePolicyOverride>();
  if (binding) {
    for (const o of binding.overrides) lockMap.set(o.policy_field_path, o);
  }

  const next: DevicePolicy = {
    values: { ...attempt.current_policy.values },
  };

  for (const change of attempt.proposed_changes) {
    const lock = lockMap.get(change.field_path);
    if (lock && isWiderThanLockedValue(change.new_value, lock.locked_value)) {
      return {
        kind: "rejected",
        reason: "ENTERPRISE_POLICY_FIELD_LOCKED",
        blocked_field_path: change.field_path,
        detail: `Field "${change.field_path}" is locked by org policy and the proposed value would widen it.`,
      };
    }
    next.values[change.field_path] = change.new_value;
  }

  return { kind: "accepted", resulting_policy: next };
}

// ---------------------------------------------------------------------------
// Approval evaluation — issued by a human in bos-omega for a task request
// ---------------------------------------------------------------------------

export type ApprovalEvaluationInput = {
  device_org_id: string | null;
  approver_org_id: string | null;
  approver_user_id: string;
  task_request_id: string;
  windows_session: WindowsSessionInfo;
};

export type ApprovalEvaluationDecision =
  | { kind: "accepted" }
  | { kind: "rejected"; reason: LocalAgentRejectionReason; detail: string };

/**
 * An approval may only be issued by a user whose `org_id` matches the
 * device's `org_id` WHEN BOTH SIDES ARE ORG-BOUND.
 *
 * The asymmetric paths are deliberately permissive at this layer:
 *   - device personal (NULL) + approver personal (NULL) → accept
 *     (personal-install single-user story)
 *   - device personal (NULL) + approver org-bound → accept
 *     (a super_admin can step in to approve on a BYOD laptop they have
 *     a session for; whether they SHOULD is a session/auth concern, not
 *     an org-binding concern)
 *   - device org-bound + approver personal (NULL) → accept
 *     (a super_admin without an org binding — e.g. the platform owner
 *     — can approve anywhere; no org-vs-org conflict to resolve)
 *   - device org-bound + approver org-bound, same org → accept
 *   - device org-bound + approver org-bound, DIFFERENT orgs → reject
 *     with ENTERPRISE_ORG_MISMATCH (the only configuration that creates
 *     an unambiguous cross-tenant breach)
 *
 * Higher layers (route guards, RBAC) decide whether a given user is
 * even allowed to attempt the approval; this engine only enforces the
 * org-isolation invariant.
 */
export function evaluateApproval(
  input: ApprovalEvaluationInput,
): ApprovalEvaluationDecision {
  const dOrg = input.device_org_id;
  const aOrg = input.approver_org_id;

  if (dOrg !== null && aOrg !== null && dOrg !== aOrg) {
    return {
      kind: "rejected",
      reason: "ENTERPRISE_ORG_MISMATCH",
      detail: `Approver org ${aOrg} does not match device org ${dOrg}.`,
    };
  }
  return { kind: "accepted" };
}

// ---------------------------------------------------------------------------
// Execution gate — final check before the agent runs the action
// ---------------------------------------------------------------------------

export type ExecutionGateInput = {
  approval_bound_session_sid: string;
  approval_consumed_at: Date | null;
  approval_expires_at: Date;
  approval_device_id: string;
  approval_org_id: string | null;
  request_device_id: string;
  request_org_id: string | null;
  request_session: WindowsSessionInfo;
  now: Date;
};

export type ExecutionGateDecision =
  | { kind: "accepted" }
  | { kind: "rejected"; reason: LocalAgentRejectionReason; detail: string };

/**
 * The execution gate is the last check before the agent actually runs
 * the action. It enforces:
 *   - approval is single-use (consumed_at must be null),
 *   - approval has not expired,
 *   - approval was issued for THIS device,
 *   - approval was issued for THIS Windows session SID,
 *   - approval's org binding matches the request's org binding.
 *
 * This is also where `SESSION_BINDING_MISMATCH` is emitted: an
 * approval issued for SID A cannot be redeemed by a request from
 * SID B even on the same device. This blocks an attack where a
 * less-privileged session waits for a more-privileged session's
 * approval to be issued, then tries to consume it.
 */
export function evaluateExecutionGate(
  input: ExecutionGateInput,
): ExecutionGateDecision {
  if (input.approval_consumed_at !== null) {
    return {
      kind: "rejected",
      reason: "POLICY_RATE_LIMITED",
      detail: "Approval token has already been consumed.",
    };
  }
  if (input.now >= input.approval_expires_at) {
    return {
      kind: "rejected",
      reason: "POLICY_RATE_LIMITED",
      detail: "Approval token has expired.",
    };
  }
  if (input.approval_device_id !== input.request_device_id) {
    return {
      kind: "rejected",
      reason: "ENTERPRISE_ORG_MISMATCH",
      detail: "Approval was issued for a different device.",
    };
  }
  if (input.approval_org_id !== input.request_org_id) {
    return {
      kind: "rejected",
      reason: "ENTERPRISE_ORG_MISMATCH",
      detail: "Approval and request disagree on org binding.",
    };
  }
  if (input.approval_bound_session_sid !== input.request_session.sid) {
    return {
      kind: "rejected",
      reason: "SESSION_BINDING_MISMATCH",
      detail: `Approval is bound to SID ${input.approval_bound_session_sid}, request came from SID ${input.request_session.sid}.`,
    };
  }
  return { kind: "accepted" };
}

// ---------------------------------------------------------------------------
// Install-mode change guard
// ---------------------------------------------------------------------------

/**
 * A device that was registered under `ADMIN_DEPLOYMENT` cannot be
 * downgraded to `INDIVIDUAL_CONSENT` by re-pairing — that would let a
 * locally-elevated user shake off the enterprise binding by reinstall.
 * The reverse direction (individual → admin) IS allowed: a personal
 * install joining a managed fleet is the expected upgrade path.
 */
export function evaluateInstallModeChange(
  current: InstallMode,
  proposed: InstallMode,
): { kind: "accepted" } | { kind: "rejected"; reason: LocalAgentRejectionReason; detail: string } {
  if (current === "ADMIN_DEPLOYMENT" && proposed === "INDIVIDUAL_CONSENT") {
    return {
      kind: "rejected",
      reason: "INSTALL_MODE_DOWNGRADE_DENIED",
      detail:
        "Admin-deployment devices cannot be downgraded to individual-consent by re-pairing.",
    };
  }
  return { kind: "accepted" };
}
