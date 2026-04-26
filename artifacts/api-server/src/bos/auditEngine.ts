import { db } from "@workspace/db";
import { auditLogsTable } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { randomUUID } from "crypto";

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
  | "CIRCUIT_BREAKER_CLOSED";

export async function auditLog(
  task_id: string | undefined,
  event_type: AuditEventType,
  message: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  try {
    await db.insert(auditLogsTable).values({
      id: randomUUID(),
      task_id: task_id || null,
      event_type,
      message,
      metadata: metadata || null,
    });
  } catch (err) {
    logger.error({ err, event_type, message }, "Failed to write audit log");
  }
}
