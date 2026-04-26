import { Router } from "express";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  bosDevicesTable,
  bosTaskRequestsTable,
  bosApprovalTokensTable,
  bosTaskExecutionsTable,
} from "@workspace/db";
import { randomUUID } from "node:crypto";
import {
  makeLocalAgentSignedRequestMiddleware,
  type LocalAgentRequestContext,
} from "../../lib/localAgent/signedRequest.js";
import { appendLocalAgentAudit } from "../../lib/localAgent/auditChain.js";
import { evaluateExecutionGate } from "@workspace/local-agent-policy";

/**
 * `/api/v1/task-requests` — the agent → server task-submission surface.
 *
 * Task #32 owns the architectural seam: this route mounts the
 * signed-request middleware (`signedRequest.ts`) so that every
 * downstream handler (whether it's the eventual full Task #21
 * implementation or a future per-action handler) inherits:
 *   - HMAC verification against the per-device secret
 *   - clock-skew rejection (5 min window)
 *   - WindowsSessionInfo parse + validation, attached to req as
 *     `req.bosLocalAgent`
 *
 * This file ships ONE handler — `POST /` — that captures the
 * task request, persists `windows_session` on the row (the
 * forensic prerequisite for `SESSION_BINDING_MISMATCH` enforcement),
 * and returns `AWAITING_APPROVAL`. The approval issuance + execution
 * gate are wired by Tasks #21 and #25; the seam they extend is the
 * persistence of `windows_session` we do here.
 */

const router = Router();

// Look up a device's per-device HMAC signing secret. The secret is
// minted server-side at registration (POST /v1/devices/register)
// and returned to the agent exactly once; the agent persists it
// locally and uses it for HMAC-SHA256 over every subsequent signed
// request. Notably this does NOT use device_pubkey, which is public
// material and would weaken request authenticity. Task #22 will
// wrap signing_secret with at-rest encryption + rotation; the
// lookup seam stays.
async function lookupDeviceSecret(deviceId: string): Promise<string | null> {
  const [row] = await db
    .select({ signing_secret: bosDevicesTable.signing_secret })
    .from(bosDevicesTable)
    .where(eq(bosDevicesTable.id, deviceId))
    .limit(1);
  return row?.signing_secret ?? null;
}

router.use(makeLocalAgentSignedRequestMiddleware(lookupDeviceSecret));

const TaskActionSchema = z
  .object({
    kind: z.string().min(1).max(64),
  })
  .passthrough();

const TaskRequestBodySchema = z.object({
  action: TaskActionSchema,
});

router.post("/", async (req, res) => {
  const ctx = req.bosLocalAgent as LocalAgentRequestContext | undefined;
  if (!ctx) {
    res.status(500).json({
      error: "Signed-request context missing after middleware pass",
      code: "INTERNAL_MIDDLEWARE_DESYNC",
    });
    return;
  }

  const parsed = TaskRequestBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      code: "INPUT_ERROR",
      issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
    });
    return;
  }

  const [device] = await db
    .select({ id: bosDevicesTable.id, org_id: bosDevicesTable.org_id })
    .from(bosDevicesTable)
    .where(eq(bosDevicesTable.id, ctx.device_id))
    .limit(1);
  if (!device) {
    res.status(404).json({
      error: "Device not found",
      code: "DEVICE_NOT_FOUND",
    });
    return;
  }

  const id = randomUUID();
  await db.insert(bosTaskRequestsTable).values({
    id,
    device_id: device.id,
    org_id: device.org_id,
    windows_session: ctx.windows_session,
    action: parsed.data.action,
    decision: "AWAITING_APPROVAL",
  });

  await appendLocalAgentAudit({
    device_id: device.id,
    org_id: device.org_id,
    actor_user_id: null,
    event_type: "TASK_REQUEST_RECEIVED",
    payload: { task_request_id: id, action_kind: parsed.data.action.kind },
    windows_session: ctx.windows_session,
  });

  res.status(201).json({
    task_request_id: id,
    decision: "AWAITING_APPROVAL",
  });
});

/**
 * `POST /api/v1/task-requests/:id/execute` — the signed, single-use
 * consumption boundary. The agent presents the approval token id it
 * received out-of-band (Tasks #21/#25 issue tokens; Task #32 enforces
 * the gate). Because this route inherits the signed-request
 * middleware, the request is HMAC-verified AND comes pre-decorated
 * with `req.bosLocalAgent.windows_session`, so we can apply the
 * full `evaluateExecutionGate` check — including
 * `SESSION_BINDING_MISMATCH` — at the actual request boundary,
 * not just in the policy library.
 */

const ExecuteBodySchema = z.object({
  approval_token_id: z.string().min(1).max(128),
  outcome: z
    .object({
      kind: z.string().min(1).max(64),
    })
    .passthrough()
    .default({ kind: "completed" }),
  started_at: z.string().datetime().optional(),
  finished_at: z.string().datetime().optional(),
});

router.post("/:id/execute", async (req, res) => {
  const ctx = req.bosLocalAgent as LocalAgentRequestContext | undefined;
  if (!ctx) {
    res.status(500).json({
      error: "Signed-request context missing after middleware pass",
      code: "INTERNAL_MIDDLEWARE_DESYNC",
    });
    return;
  }

  const taskRequestId = String(req.params["id"]);
  const parsed = ExecuteBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      code: "INPUT_ERROR",
      issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
    });
    return;
  }

  const [taskRequest] = await db
    .select()
    .from(bosTaskRequestsTable)
    .where(eq(bosTaskRequestsTable.id, taskRequestId))
    .limit(1);
  if (!taskRequest) {
    res.status(404).json({
      error: "Task request not found",
      code: "TASK_REQUEST_NOT_FOUND",
    });
    return;
  }
  if (taskRequest.device_id !== ctx.device_id) {
    res.status(403).json({
      error: "Task request belongs to a different device",
      code: "DEVICE_MISMATCH",
    });
    return;
  }

  const [token] = await db
    .select()
    .from(bosApprovalTokensTable)
    .where(eq(bosApprovalTokensTable.id, parsed.data.approval_token_id))
    .limit(1);
  if (!token) {
    res.status(404).json({
      error: "Approval token not found",
      code: "APPROVAL_TOKEN_NOT_FOUND",
    });
    return;
  }
  if (token.task_request_id !== taskRequestId) {
    res.status(403).json({
      error: "Approval token was issued for a different task request",
      code: "APPROVAL_TOKEN_MISMATCH",
    });
    return;
  }

  // Evaluate the policy gate *before* trying to consume the token,
  // so we can audit the rejection reason (incl. SESSION_BINDING_MISMATCH).
  const decision = evaluateExecutionGate({
    approval_bound_session_sid: token.bound_session_sid,
    approval_consumed_at: token.consumed_at,
    approval_expires_at: token.expires_at,
    approval_device_id: token.device_id,
    approval_org_id: token.org_id,
    request_device_id: ctx.device_id,
    request_org_id: taskRequest.org_id,
    request_session: ctx.windows_session,
    now: new Date(),
  });

  if (decision.kind === "rejected") {
    // Emit a first-class SESSION_BINDING_MISMATCH event when that's
    // the specific failure mode, so observability dashboards and
    // SIEM rules can pivot on the event_type alone. All other gate
    // rejections still flow under the generic EXECUTION_GATE_REJECTED
    // umbrella with reason in the payload.
    const eventType =
      decision.reason === "SESSION_BINDING_MISMATCH"
        ? "SESSION_BINDING_MISMATCH"
        : "EXECUTION_GATE_REJECTED";
    await appendLocalAgentAudit({
      device_id: ctx.device_id,
      org_id: taskRequest.org_id,
      actor_user_id: null,
      event_type: eventType,
      payload: {
        task_request_id: taskRequestId,
        approval_token_id: token.id,
        reason: decision.reason,
        detail: decision.detail,
      },
      windows_session: ctx.windows_session,
      is_critical: true,
    });
    res.status(403).json({ error: decision.detail, code: decision.reason });
    return;
  }

  // Atomic single-use consume: only update if the token is still
  // unconsumed. If a parallel request already won, returning rows
  // will be empty and we return the same shape as the gate's
  // POLICY_RATE_LIMITED so the caller cannot tell the difference
  // between "expired between gate and consume" and "raced".
  const consumedAt = new Date();
  const consumed = await db
    .update(bosApprovalTokensTable)
    .set({ consumed_at: consumedAt })
    .where(
      and(
        eq(bosApprovalTokensTable.id, token.id),
        isNull(bosApprovalTokensTable.consumed_at),
      ),
    )
    .returning({ id: bosApprovalTokensTable.id });
  if (consumed.length === 0) {
    await appendLocalAgentAudit({
      device_id: ctx.device_id,
      org_id: taskRequest.org_id,
      actor_user_id: null,
      event_type: "EXECUTION_GATE_REJECTED",
      payload: {
        task_request_id: taskRequestId,
        approval_token_id: token.id,
        reason: "POLICY_RATE_LIMITED",
        detail: "Approval token already consumed (race).",
      },
      windows_session: ctx.windows_session,
      is_critical: true,
    });
    res.status(403).json({
      error: "Approval token already consumed",
      code: "POLICY_RATE_LIMITED",
    });
    return;
  }

  const startedAt = parsed.data.started_at ? new Date(parsed.data.started_at) : consumedAt;
  const finishedAt = parsed.data.finished_at ? new Date(parsed.data.finished_at) : consumedAt;
  const executionId = randomUUID();
  await db.insert(bosTaskExecutionsTable).values({
    id: executionId,
    task_request_id: taskRequestId,
    approval_token_id: token.id,
    device_id: ctx.device_id,
    org_id: taskRequest.org_id,
    windows_session: ctx.windows_session,
    outcome_kind: parsed.data.outcome.kind,
    outcome: parsed.data.outcome,
    started_at: startedAt,
    finished_at: finishedAt,
  });

  await appendLocalAgentAudit({
    device_id: ctx.device_id,
    org_id: taskRequest.org_id,
    actor_user_id: null,
    event_type: "EXECUTION_REPORTED",
    payload: {
      task_request_id: taskRequestId,
      approval_token_id: token.id,
      execution_id: executionId,
      outcome_kind: parsed.data.outcome.kind,
    },
    windows_session: ctx.windows_session,
  });

  res.status(201).json({
    execution_id: executionId,
    consumed_at: consumedAt.toISOString(),
  });
});

export default router;
