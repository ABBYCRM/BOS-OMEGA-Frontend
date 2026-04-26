import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import {
  db,
  tasksTable,
  executionRunsTable,
} from "@workspace/db";
import { requireRole, type AuthenticatedUser } from "../lib/security/auth.js";
import { auditLog } from "../bos/auditEngine.js";

const router = Router();

// All override actions are super_admin-only and must carry a `reason` text
// that lands in the audit log. The override does not retry the pipeline —
// it just snaps the persisted state into a sane terminal value so the
// operator can move forward.
router.use(requireRole("super_admin"));

const ReasonSchema = z.string().trim().min(3).max(2000);

const UnlockTaskBody = z.object({
  task_id: z.string().min(1).max(128),
  reason: ReasonSchema,
});

const ForceTriStateBody = z.object({
  task_id: z.string().min(1).max(128),
  decision: z.enum(["GO", "HOLD", "ABORT"]),
  reason: ReasonSchema,
});

const ResetRunBody = z.object({
  run_id: z.string().min(1).max(128),
  reason: ReasonSchema,
});

router.post("/unlock-task", async (req, res) => {
  const parsed = UnlockTaskBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      code: "INPUT_ERROR",
      issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
    });
    return;
  }
  const actor = req.user as AuthenticatedUser;

  const [task] = await db
    .select()
    .from(tasksTable)
    .where(eq(tasksTable.id, parsed.data.task_id))
    .limit(1);
  if (!task) {
    res.status(404).json({ error: "Task not found", code: "NOT_FOUND" });
    return;
  }
  if (task.tri_state !== "HOLD" && task.final_status !== "HELD") {
    res.status(409).json({
      error: "Task is not on HOLD",
      code: "NOT_HELD",
      current: { tri_state: task.tri_state, final_status: task.final_status },
    });
    return;
  }

  // Semantics: this is the super-admin "approve and release" path for a
  // task the safety/tri-state pipeline parked on HOLD pending human
  // review. The pipeline has already finished its execution by the time
  // a task lands on HOLD — there is nothing to "resume". The operator's
  // review is itself the terminal event, so we promote tri_state to GO
  // and final_status to COMPLETED. The operator's reason and the prior
  // state are recorded in the audit log so the provenance stays honest.
  // (To explicitly reject a held task, the operator uses force-tri-state
  //  with decision = "ABORT" instead.)
  await db
    .update(tasksTable)
    .set({ tri_state: "GO", final_status: "COMPLETED" })
    .where(eq(tasksTable.id, task.id));

  await auditLog(task.id, "OVERRIDE_TASK_UNLOCKED", `HOLD released by super_admin (operator approval; marked COMPLETED)`, {
    actor_user_id: actor.id,
    target_task_id: task.id,
    previous_tri_state: task.tri_state,
    previous_final_status: task.final_status,
    new_tri_state: "GO",
    new_final_status: "COMPLETED",
    reason: parsed.data.reason,
  });

  res.json({ ok: true, task_id: task.id, tri_state: "GO", final_status: "COMPLETED" });
});

router.post("/force-tri-state", async (req, res) => {
  const parsed = ForceTriStateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      code: "INPUT_ERROR",
      issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
    });
    return;
  }
  const actor = req.user as AuthenticatedUser;

  const [task] = await db
    .select()
    .from(tasksTable)
    .where(eq(tasksTable.id, parsed.data.task_id))
    .limit(1);
  if (!task) {
    res.status(404).json({ error: "Task not found", code: "NOT_FOUND" });
    return;
  }

  // Snap the task's tri-state to the forced value. We DO NOT touch the
  // existing tri_state_decisions row — those represent the pipeline's actual
  // computed decisions. Instead, the override is recorded only in the audit
  // log so the trail stays honest.
  // Match the canonical uppercase casing the pipeline writes
  // ("HELD" / "ABORTED" / "COMPLETED" / "RUNNING") so the frontend
  // status badges and filters stay consistent after an override.
  const finalStatus =
    parsed.data.decision === "GO"
      ? "COMPLETED"
      : parsed.data.decision === "ABORT"
        ? "ABORTED"
        : "HELD";

  await db
    .update(tasksTable)
    .set({ tri_state: parsed.data.decision, final_status: finalStatus })
    .where(eq(tasksTable.id, task.id));

  await auditLog(task.id, "OVERRIDE_TRI_STATE_FORCED", `Tri-state forced to ${parsed.data.decision} by super_admin override`, {
    actor_user_id: actor.id,
    target_task_id: task.id,
    previous_tri_state: task.tri_state,
    forced_tri_state: parsed.data.decision,
    reason: parsed.data.reason,
  });

  res.json({ ok: true, task_id: task.id, tri_state: parsed.data.decision });
});

router.post("/reset-run", async (req, res) => {
  const parsed = ResetRunBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      code: "INPUT_ERROR",
      issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
    });
    return;
  }
  const actor = req.user as AuthenticatedUser;

  const [run] = await db
    .select()
    .from(executionRunsTable)
    .where(eq(executionRunsTable.id, parsed.data.run_id))
    .limit(1);
  if (!run) {
    res.status(404).json({ error: "Run not found", code: "NOT_FOUND" });
    return;
  }
  if (run.status === "completed" || run.status === "aborted") {
    res.status(409).json({
      error: "Run is already terminal",
      code: "ALREADY_TERMINAL",
      current: { status: run.status },
    });
    return;
  }

  // Semantics: this is the super-admin "reset a stuck execution_run"
  // path. A run can get wedged in `running` if a provider call hangs or
  // a process restart leaves no observer to mark it terminal. We can't
  // safely "rewind and replay" a partially-spent multi-provider run
  // (some attempts already cost money and emitted side-effects), so
  // reset = cancel-the-stuck-run cleanly: stamp status="aborted" and
  // set completed_at so dashboards stop counting it as in-flight. The
  // owner can then resubmit a fresh task. The audit row records this
  // is an operator-driven reset (not a model-driven failure).
  await db
    .update(executionRunsTable)
    .set({ status: "aborted", completed_at: new Date() })
    .where(eq(executionRunsTable.id, run.id));

  await auditLog(run.task_id ?? undefined, "OVERRIDE_RUN_RESET", `Run ${run.id} reset by super_admin (stuck run cancelled, status -> aborted)`, {
    actor_user_id: actor.id,
    target_run_id: run.id,
    target_task_id: run.task_id ?? null,
    previous_status: run.status,
    new_status: "aborted",
    operator_initiated: true,
    reason: parsed.data.reason,
  });

  res.json({ ok: true, run_id: run.id, status: "aborted" });
});

export default router;
