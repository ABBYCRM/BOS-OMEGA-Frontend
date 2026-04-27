import { db } from "@workspace/db";
import { auditLogsTable } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";

type AuditEventType =
  | "TASK_RECEIVED"
  | "INPUT_GATE_RESULT"
  | "TASK_CLASSIFIED"
  | "MODEL_SELECTED"
  | "LLM_CALL_STARTED"
  | "LLM_CALL_COMPLETED"
  | "LLM_CALL_FAILED"
  | "VALIDATION_COMPLETED"
  | "REPAIR_APPLIED"
  | "FALLBACK_TRIGGERED"
  | "PARALLEL_EXECUTION_STARTED"
  | "PARALLEL_EXECUTION_COMPLETED"
  | "MERGE_COMPLETED"
  | "TASK_COMPLETED"
  | "TASK_ABORTED"
  | "TASK_HELD"
  | "CIRCUIT_BREAKER_OPENED"
  | "CIRCUIT_BREAKER_CLOSED"
  | "ATTACHMENT_NOTES"
  | "ATTACHMENT_INJECTION_FLAGGED"
  | "MODE_SELECTED"
  | "MODE_DOWNGRADED"
  | "BTO_STARTED"
  | "BTO_AGENTS_DISPATCHED"
  | "BTO_AGENTS_COMPLETED"
  | "BTO_ABORTED"
  | "BTO_SYNTHESIS_STARTED"
  | "BTO_SYNTHESIS_COMPLETED"
  | "BTO_ADVERSARIAL_COMPLETED"
  | "BTO_COMPLETED"
  | "SERIES_PASS_STARTED"
  | "SERIES_PASS_STEP"
  | "SERIES_PASS_ABORTED"
  | "SERIES_PASS_COMPLETED"
  | "PROVIDER_KEY_UPDATED"
  | "PROVIDER_KEY_CLEARED"
  | "PROVIDER_TESTED"
  | "PROVIDER_DISCOVERY_FAILED"
  | "PROVIDER_MODELS_DISCOVERED"
  | "PROVIDER_REMOVED"
  | "BUDGET_EXCEEDED"
  | "CRITICAL_AUDIT_FAILURE"
  | "AUTH_LOGIN_SUCCESS"
  | "AUTH_LOGIN_FAILED"
  | "USER_CREATED"
  | "USER_DISABLED"
  | "USER_ENABLED"
  | "USER_ROLE_CHANGED"
  | "USER_PASSWORD_RESET"
  | "USER_DELETED"
  | "OWNER_ACCOUNT_CREATED"
  | "OWNER_ACCOUNT_REPAIRED"
  | "OWNER_ACCOUNT_PROTECTED_MUTATION_BLOCKED"
  | "OVERRIDE_TASK_UNLOCKED"
  | "OVERRIDE_TRI_STATE_FORCED"
  | "OVERRIDE_RUN_RESET"
  // R-5: provider key resolution & call routing visibility.
  // Emitted on every provider call so the audit chain shows whether the
  // call went direct (db/env/legacy), via the Replit AI Integrations proxy,
  // or fell through to mock mode.
  | "KEY_RESOLVED"
  | "PROXY_CALL"
  | "MOCK_MODE_USED"
  // R-1: per-response audit events for parallel/consensus mode so the
  // audit chain shows which model produced which role's output and
  // which roles failed.
  | "PARALLEL_RESPONSE_RECEIVED"
  | "PARALLEL_RESPONSE_FAILED"
  // Follow-up #41: when series_pass / boil_the_ocean cannot produce a
  // real GO answer because every (or every critical) underlying call
  // failed — usually mock-mode/no-key or provider outage — we degrade
  // the final state to HOLD and audit the reason. These complement the
  // existing SERIES_PASS_ABORTED / BTO_ABORTED events, which fire only
  // on explicit ABORT signals from the model itself.
  | "SERIES_PASS_DEGRADED"
  | "BTO_DEGRADED"
  | "BTO_SYNTHESIS_FAILED"
  | "BTO_ADVERSARIAL_FAILED"
  // Task #46: orchestrator emits this once per task immediately after
  // memory retrieval (canon + continuity + patches + scratchpad), so the
  // audit trail shows exactly what memory_context was injected into the
  // model prompt in every execution mode.
  | "MEMORY_INJECTED"
  | "LLM_INPUT_PREPARED"
  // BOP.FRONT_DOOR.v1 — preflight classification fires on every task,
  // before the BOS Tri-State engine sees the input. Now an observability
  // signal only — the engine is invoked for every safe non-empty input.
  | "FRONT_DOOR_CLASSIFIED"
  // BOP.CANON_GOVERNANCE.v1 — Canon is the model's behaviour contract.
  // CANON_HASH_LOGGED records the sha256 fingerprint of the canon block
  // injected on this request so audits can prove which Canon governed it.
  // CANON_LOAD_ERROR is fail-fast: emitted when the canon layer cannot
  // be loaded or is empty, before the model is invoked. The route layer
  // surfaces it as a 500 with code "CANON_LOAD_ERROR".
  // TRI_STATE_RECORDED replaces TRI_STATE_EVALUATED: the runtime no
  // longer collapses Tri-State; the model decides and the runtime only
  // records the result as display-only metadata.
  | "CANON_HASH_LOGGED"
  | "CANON_LOAD_ERROR"
  | "TRI_STATE_RECORDED";

const AUDIT_QUEUE_DIR = process.env["AUDIT_QUEUE_DIR"] || path.resolve(process.cwd(), ".local", "audit-queue");
const AUDIT_QUEUE_FILE = path.join(AUDIT_QUEUE_DIR, "pending.jsonl");
const COMPLIANCE_MODE = (process.env["COMPLIANCE_MODE"] || "").toLowerCase() === "true"
  || process.env["COMPLIANCE_MODE"] === "1";
const MAX_DB_RETRIES = 3;

let lastFailureSurfaced = false;

/**
 * v1.1 audit durability — has the most recent attempt failed in a way that
 * compliance-mode tasks must HOLD on?
 *
 * Pipelines call this AFTER they've fired their normal audit events; if it
 * returns true the task degrades to HOLD per the failure-mode matrix.
 */
export function complianceHoldRequired(): boolean {
  return COMPLIANCE_MODE && lastFailureSurfaced;
}

/**
 * Reset the failure flag — called by the pipeline once it has surfaced the
 * failure to the user, so subsequent unrelated tasks aren't poisoned.
 */
export function clearComplianceFailure(): void {
  lastFailureSurfaced = false;
}

async function appendToDurableQueue(record: Record<string, unknown>): Promise<void> {
  await fs.mkdir(AUDIT_QUEUE_DIR, { recursive: true });
  await fs.appendFile(AUDIT_QUEUE_FILE, JSON.stringify(record) + "\n", "utf8");
}

async function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * v1.1 hardened audit write:
 *   1. Try the DB write up to MAX_DB_RETRIES times with linear backoff.
 *   2. If all retries fail, append the event to a durable JSONL queue.
 *   3. Emit a CRITICAL_AUDIT_FAILURE log line.
 *   4. Mark `lastFailureSurfaced` so compliance-mode pipelines HOLD.
 *
 * The function never throws — losing audit visibility must not crash the
 * task — but it does record loudly when DB durability is compromised.
 */
export async function auditLog(
  task_id: string | undefined,
  event_type: AuditEventType,
  message: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  const id = randomUUID();
  const record = {
    id,
    task_id: task_id || null,
    event_type,
    message,
    metadata: metadata || null,
  };

  let last_err: unknown;
  for (let attempt = 1; attempt <= MAX_DB_RETRIES; attempt++) {
    try {
      await db.insert(auditLogsTable).values(record);
      return;
    } catch (err) {
      last_err = err;
      if (attempt < MAX_DB_RETRIES) {
        await sleep(50 * attempt);
      }
    }
  }

  // All DB attempts failed. Surface the failure SYNCHRONOUSLY before any
  // further awaits — the compliance-mode pipeline reads `complianceHoldRequired()`
  // synchronously, and any pending audit awaits must not race ahead of that flag.
  lastFailureSurfaced = true;
  try {
    await appendToDurableQueue({
      ...record,
      enqueued_at: new Date().toISOString(),
      reason: "audit_db_write_failed",
    });
    logger.error(
      { err: last_err, event_type, message, task_id, queue: AUDIT_QUEUE_FILE },
      "CRITICAL_AUDIT_FAILURE — DB write failed after retries; appended to durable queue",
    );
  } catch (queue_err) {
    logger.fatal(
      { db_err: last_err, queue_err, event_type, message, task_id },
      "CRITICAL_AUDIT_FAILURE — DB and durable queue both failed; audit event LOST",
    );
  }
}
