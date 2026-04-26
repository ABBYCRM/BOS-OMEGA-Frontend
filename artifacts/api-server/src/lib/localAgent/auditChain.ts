import { createHash, randomUUID } from "node:crypto";
import { db, bosAuditLogTable } from "@workspace/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { logger } from "../logger.js";
import type { WindowsSessionInfo } from "@workspace/local-agent-contracts";

/**
 * Append-only, hash-chained audit writer for the local-agent surface
 * (Task #22 owns the full primitive — this file lays the foundation
 * for #32 so org / windows_session columns flow through from day one).
 *
 * Each row stores `prev_row_hash` (the previous row's `row_hash` in
 * the same per-device chain) and `row_hash` (SHA-256 over a stable
 * canonical encoding of this row's content). Tampering with any
 * historical row breaks the chain at that row and every subsequent
 * row.
 *
 * Chains are scoped per device. A device that's offline doesn't
 * stall other devices' chains. The price is that an audit reader
 * must verify N chains instead of one — a deliberate trade for
 * availability.
 *
 * Org-level audit roll-ups (e.g. "show me everything for ACME")
 * happen at read time by joining over `bos_audit_log.org_id`.
 */

export type LocalAgentAuditEvent =
  // Pairing / lifecycle
  | "DEVICE_PAIRED"
  | "DEVICE_REVOKED"
  | "DEVICE_INSTALL_MODE_CHANGE_DENIED"
  | "PAIR_CODE_MINTED"
  // Policy
  | "POLICY_UPDATED"
  | "POLICY_FIELD_LOCK_VIOLATED"
  // Org admin
  | "ORG_CREATED"
  | "ORG_POLICY_OVERRIDE_SET"
  | "ORG_POLICY_OVERRIDE_CLEARED"
  | "ORG_ENROLLMENT_SECRET_ROTATED"
  // Task lifecycle
  | "TASK_REQUEST_RECEIVED"
  | "TASK_REQUEST_REJECTED"
  | "APPROVAL_ISSUED"
  | "APPROVAL_REJECTED_CROSS_ORG"
  | "EXECUTION_REPORTED"
  | "EXECUTION_GATE_REJECTED"
  | "SESSION_BINDING_MISMATCH"
  | "SESSION_INFO_MALFORMED"
  // Critical
  | "CRITICAL_AUDIT_FAILURE";

export type AppendAuditArgs = {
  device_id: string | null;
  org_id: string | null;
  actor_user_id: string | null;
  event_type: LocalAgentAuditEvent;
  payload: Record<string, unknown>;
  windows_session?: WindowsSessionInfo | null;
  is_critical?: boolean;
};

/**
 * Append a row to the chain. Returns the hash of the appended row.
 *
 * NOTE: this is intentionally not transactional with the caller's
 * write. The contract is "audit-first" — call this BEFORE the state-
 * changing write, so a failure here aborts the surrounding action.
 * Task #22 will fold this into the same DB transaction as the
 * state-mutating row; that change is non-breaking for the call shape.
 */
export async function appendLocalAgentAudit(args: AppendAuditArgs): Promise<string> {
  const id = randomUUID();
  const created_at = new Date();

  // Chain selection:
  //   - device-bound events chain on `device_id` (one chain per device).
  //   - device-less, org-bound events (org admin actions like
  //     ORG_CREATED, ORG_POLICY_OVERRIDE_SET, ORG_ENROLLMENT_SECRET_ROTATED)
  //     chain on `(org_id, device_id IS NULL)` so the org-level admin
  //     trail is also tamper-evident.
  //   - device-less AND org-less events (platform-wide, e.g. a future
  //     CRITICAL_AUDIT_FAILURE with no org context) chain on
  //     `(device_id IS NULL, org_id IS NULL)` — a single global chain.
  let prev: Array<{ row_hash: string }> = [];
  if (args.device_id) {
    prev = await db
      .select({ row_hash: bosAuditLogTable.row_hash })
      .from(bosAuditLogTable)
      .where(eq(bosAuditLogTable.device_id, args.device_id))
      .orderBy(desc(bosAuditLogTable.created_at))
      .limit(1);
  } else if (args.org_id) {
    prev = await db
      .select({ row_hash: bosAuditLogTable.row_hash })
      .from(bosAuditLogTable)
      .where(
        and(
          isNull(bosAuditLogTable.device_id),
          eq(bosAuditLogTable.org_id, args.org_id),
        ),
      )
      .orderBy(desc(bosAuditLogTable.created_at))
      .limit(1);
  } else {
    prev = await db
      .select({ row_hash: bosAuditLogTable.row_hash })
      .from(bosAuditLogTable)
      .where(
        and(
          isNull(bosAuditLogTable.device_id),
          isNull(bosAuditLogTable.org_id),
        ),
      )
      .orderBy(desc(bosAuditLogTable.created_at))
      .limit(1);
  }

  const prev_row_hash = prev[0]?.row_hash ?? null;

  const canonical = JSON.stringify({
    id,
    device_id: args.device_id,
    org_id: args.org_id,
    actor_user_id: args.actor_user_id,
    event_type: args.event_type,
    payload: args.payload,
    windows_session: args.windows_session ?? null,
    prev_row_hash,
    created_at: created_at.toISOString(),
  });
  const row_hash = createHash("sha256").update(canonical).digest("hex");

  try {
    await db.insert(bosAuditLogTable).values({
      id,
      device_id: args.device_id,
      org_id: args.org_id,
      actor_user_id: args.actor_user_id,
      event_type: args.event_type,
      payload: args.payload,
      windows_session: args.windows_session ?? null,
      prev_row_hash,
      row_hash,
      is_critical: args.is_critical ?? false,
      created_at,
    });
    return row_hash;
  } catch (err) {
    // We deliberately log fatal here — if the chain breaks silently the
    // whole point of tamper-evidence is defeated. Task #22 wires this
    // into the COMPLIANCE_MODE hold gate the rest of the platform uses.
    logger.fatal({ err, event_type: args.event_type }, "Local-agent audit append failed");
    throw err;
  }
}
