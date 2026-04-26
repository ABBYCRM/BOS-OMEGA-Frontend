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
  | "TRI_STATE_EVALUATED"
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
  | "CRITICAL_AUDIT_FAILURE";

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
