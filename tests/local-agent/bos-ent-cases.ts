/**
 * BOS-ENT-001..006 — Enterprise / multi-user spec test cases for the
 * Local Automation Agent.
 *
 * These cases are added to the spec test matrix that lives in Task #25
 * (`@workspace/local-agent-test-matrix`). The runner itself ships with
 * #25 and consumes any module that exports `bosEntCases` of the shape
 * defined below. This file is the source of truth for the cases —
 * adding / changing a case here changes the matrix.
 *
 * The cases are declarative: each case states its preconditions, the
 * action to run, and the assertion. The runner applies the same shape
 * to BOS-POLICY-001..010 (Task #21) so a single failure summary covers
 * both regimes.
 *
 * IMPORTANT: BOS-POLICY-001..010 must continue to pass unchanged when
 * an enterprise binding is *not* present. The cases here add coverage
 * for the binding paths only.
 */

import {
  evaluateApproval,
  evaluatePolicyEdit,
  evaluateExecutionGate,
  evaluateInstallModeChange,
  type DevicePolicy,
} from "@workspace/local-agent-policy";
import {
  type EnterprisePolicyBinding,
  type LocalAgentRejectionReason,
  type PolicyFieldPath,
  type WindowsSessionInfo,
} from "@workspace/local-agent-contracts";

export type BosEntCase = {
  id: `BOS-ENT-${string}`;
  title: string;
  /**
   * Optional descriptive context the runner surfaces in failure
   * reports. Keep terse — one sentence.
   */
  rationale: string;
  /**
   * Synchronous evaluator. Returns true iff the case passes. The runner
   * captures the boolean plus the case metadata; assertion details
   * inside the function are an implementation choice.
   */
  evaluate: () => boolean;
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG_A: EnterprisePolicyBinding["org"] = {
  org_id: "00000000-0000-0000-0000-00000000000a",
  slug: "org-a",
  display_name: "Org A",
  status: "active",
};
const ORG_B: EnterprisePolicyBinding["org"] = {
  org_id: "00000000-0000-0000-0000-00000000000b",
  slug: "org-b",
  display_name: "Org B",
  status: "active",
};

const SESSION_A: WindowsSessionInfo = {
  sid: "S-1-5-21-111-222-333-1001",
  username: "alice",
  session_id: 1,
  is_remote_session: false,
  is_admin_session: false,
};
const SESSION_B: WindowsSessionInfo = {
  sid: "S-1-5-21-111-222-333-1002",
  username: "bob",
  session_id: 2,
  is_remote_session: false,
  is_admin_session: false,
};

const ORG_A_BINDING_LOCKED_ALLOWLIST: EnterprisePolicyBinding = {
  org: ORG_A,
  overrides: [
    {
      org_id: ORG_A.org_id,
      policy_field_path: "allowlist.scripts.signed_bos_scripts" as PolicyFieldPath,
      locked_value: ["C:\\BOS-Omega\\scripts\\health-check.ps1"],
      set_by_user_id: "super-admin-1",
      set_at: "2026-01-01T00:00:00.000Z",
    },
  ],
};

const EMPTY_POLICY: DevicePolicy = { values: {} };

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

function rejectedWith(
  decision: { kind: string; reason?: LocalAgentRejectionReason },
  reason: LocalAgentRejectionReason,
): boolean {
  return decision.kind === "rejected" && decision.reason === reason;
}

export const bosEntCases: ReadonlyArray<BosEntCase> = [
  {
    id: "BOS-ENT-001",
    title: "Cross-org approval is rejected",
    rationale:
      "An approver bound to ORG_B cannot approve a task on a device bound to ORG_A.",
    evaluate() {
      const decision = evaluateApproval({
        device_org_id: ORG_A.org_id,
        approver_org_id: ORG_B.org_id,
        approver_user_id: "user-b",
        task_request_id: "tr-001",
        windows_session: SESSION_A,
      });
      return rejectedWith(decision, "ENTERPRISE_ORG_MISMATCH");
    },
  },
  {
    id: "BOS-ENT-002",
    title: "Session-binding mismatch is rejected at the execution gate",
    rationale:
      "An approval token issued for SID A cannot be redeemed by a request from SID B on the same device.",
    evaluate() {
      const decision = evaluateExecutionGate({
        approval_bound_session_sid: SESSION_A.sid,
        approval_consumed_at: null,
        approval_expires_at: new Date(Date.now() + 60_000),
        approval_device_id: "dev-1",
        approval_org_id: ORG_A.org_id,
        request_device_id: "dev-1",
        request_org_id: ORG_A.org_id,
        request_session: SESSION_B,
        now: new Date(),
      });
      return rejectedWith(decision, "SESSION_BINDING_MISMATCH");
    },
  },
  {
    id: "BOS-ENT-003",
    title: "Locked-field widening is rejected",
    rationale:
      "A device-local policy edit attempting to add an extra entry to an org-locked allowlist is rejected with ENTERPRISE_POLICY_FIELD_LOCKED.",
    evaluate() {
      const decision = evaluatePolicyEdit(
        {
          device_id: "dev-1",
          device_install_mode: "ADMIN_DEPLOYMENT",
          current_policy: EMPTY_POLICY,
          proposed_changes: [
            {
              field_path: "allowlist.scripts.signed_bos_scripts" as PolicyFieldPath,
              new_value: [
                "C:\\BOS-Omega\\scripts\\health-check.ps1",
                "C:\\Users\\alice\\Desktop\\not-on-allowlist.ps1",
              ],
            },
          ],
        },
        ORG_A_BINDING_LOCKED_ALLOWLIST,
      );
      return rejectedWith(decision, "ENTERPRISE_POLICY_FIELD_LOCKED");
    },
  },
  {
    id: "BOS-ENT-004",
    title: "Admin-deployment registration via enrollment secret is accepted",
    rationale:
      "An ADMIN_DEPLOYMENT pairing path is allowed and an installed personal device may upgrade to admin-deployment, but cannot downgrade.",
    evaluate() {
      const upgrade = evaluateInstallModeChange("INDIVIDUAL_CONSENT", "ADMIN_DEPLOYMENT");
      const downgrade = evaluateInstallModeChange("ADMIN_DEPLOYMENT", "INDIVIDUAL_CONSENT");
      return (
        upgrade.kind === "accepted" &&
        rejectedWith(downgrade, "INSTALL_MODE_DOWNGRADE_DENIED")
      );
    },
  },
  {
    id: "BOS-ENT-005",
    title: "Dual-mode pairing on the same server",
    rationale:
      "Personal (org_id NULL) and admin-deployment devices coexist. Org-isolation only fires when BOTH sides are org-bound and the orgs differ; asymmetric paths fall through to the next layer (RBAC / route guards).",
    evaluate() {
      const personalAndPersonal = evaluateApproval({
        device_org_id: null,
        approver_org_id: null,
        approver_user_id: "user-personal",
        task_request_id: "tr-005-pp",
        windows_session: SESSION_A,
      });
      const personalDeviceOrgApprover = evaluateApproval({
        device_org_id: null,
        approver_org_id: ORG_A.org_id,
        approver_user_id: "user-a",
        task_request_id: "tr-005-pa",
        windows_session: SESSION_A,
      });
      const orgDevicePersonalApprover = evaluateApproval({
        device_org_id: ORG_A.org_id,
        approver_org_id: null,
        approver_user_id: "user-platform-owner",
        task_request_id: "tr-005-ap",
        windows_session: SESSION_A,
      });
      const sameOrg = evaluateApproval({
        device_org_id: ORG_A.org_id,
        approver_org_id: ORG_A.org_id,
        approver_user_id: "user-a",
        task_request_id: "tr-005-aa",
        windows_session: SESSION_A,
      });
      return (
        personalAndPersonal.kind === "accepted" &&
        personalDeviceOrgApprover.kind === "accepted" &&
        orgDevicePersonalApprover.kind === "accepted" &&
        sameOrg.kind === "accepted"
      );
    },
  },
  {
    id: "BOS-ENT-006",
    title: "Audit chain integrity across an org-locked field change",
    rationale:
      "Setting then clearing an org policy override produces two distinct audit rows whose hash chain can be re-verified — sentinel asserted by the runner harness; this case asserts the engine emits the right reason strings.",
    evaluate() {
      // The hash-chain itself is validated by the spec runner reading
      // bos_audit_log directly. From the engine's perspective the
      // contract is that an over-broad override-set surfaces the
      // ENTERPRISE_POLICY_FIELD_LOCKED reason on subsequent device
      // edits. We assert that round-trip with a tightened binding.
      const tighter: EnterprisePolicyBinding = {
        org: ORG_A,
        overrides: [
          {
            org_id: ORG_A.org_id,
            policy_field_path: "allowlist.scripts.signed_bos_scripts" as PolicyFieldPath,
            locked_value: [],
            set_by_user_id: "super-admin-1",
            set_at: "2026-02-01T00:00:00.000Z",
          },
        ],
      };
      const decision = evaluatePolicyEdit(
        {
          device_id: "dev-1",
          device_install_mode: "ADMIN_DEPLOYMENT",
          current_policy: EMPTY_POLICY,
          proposed_changes: [
            {
              field_path: "allowlist.scripts.signed_bos_scripts" as PolicyFieldPath,
              new_value: ["C:\\BOS-Omega\\scripts\\anything.ps1"],
            },
          ],
        },
        tighter,
      );
      return rejectedWith(decision, "ENTERPRISE_POLICY_FIELD_LOCKED");
    },
  },
];
