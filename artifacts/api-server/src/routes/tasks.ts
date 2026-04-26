import { Router } from "express";
import { db } from "@workspace/db";
import {
  tasksTable,
  modelAttemptsTable,
  validationResultsTable,
  fallbackEventsTable,
  auditLogsTable,
  attachmentsTable,
  executionRunsTable,
} from "@workspace/db";
import { eq, desc, count, sql, and, or, isNull, inArray } from "drizzle-orm";
import { runBosPipeline } from "../bos/pipeline.js";
import { CreateTaskBody, ListTasksQueryParams } from "@workspace/api-zod";
import { logger } from "../lib/logger.js";
import { expensiveLimiter } from "../lib/security/rateLimit.js";

const router = Router();

router.post("/", expensiveLimiter, async (req, res) => {
  const parsed = CreateTaskBody.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn({ issues: parsed.error.issues, body: req.body }, "CreateTask validation failed");
    res.status(400).json({
      error: "Invalid request body",
      code: "INPUT_ERROR",
      issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message, code: i.code })),
    });
    return;
  }

  // Cross-tenant attachment guard. The pipeline re-links each attachment's
  // task_id to the new task and feeds its bytes/text into the LLM context.
  // Without checking ownership here, any authenticated user who learns
  // another user's attachment id could exfiltrate the file's contents and
  // hijack the row. super_admin is allowed to attach anything; everyone
  // else must own the attachment (or it must be a legacy NULL row).
  const attachment_ids = parsed.data.attachment_ids ?? [];
  if (attachment_ids.length > 0 && req.user?.role !== "super_admin") {
    const owners = await db
      .select({ id: attachmentsTable.id, user_id: attachmentsTable.user_id })
      .from(attachmentsTable)
      .where(inArray(attachmentsTable.id, attachment_ids));
    const owned = new Map(owners.map((r) => [r.id, r.user_id]));
    const uid = req.user?.id ?? "";
    const denied = attachment_ids.filter((id) => {
      const o = owned.get(id);
      if (o === undefined) return true;        // unknown id
      if (o === null) return false;            // legacy untagged
      return o !== uid;                        // someone else's
    });
    if (denied.length > 0) {
      res.status(404).json({
        error: "One or more attachments not found",
        code: "NOT_FOUND",
        denied,
      });
      return;
    }
  }

  try {
    const result = await runBosPipeline({
      input: parsed.data.input,
      mode: parsed.data.mode as "single" | "parallel" | "consensus" | "series_pass" | "boil_the_ocean" | "auto" | undefined,
      task_type_override: parsed.data.task_type_override || undefined,
      parallel_models: parsed.data.parallel_models || undefined,
      max_models: parsed.data.max_models || undefined,
      agents_per_model: parsed.data.agents_per_model || undefined,
      attachment_ids: attachment_ids.length > 0 ? attachment_ids : undefined,
      persona: (parsed.data.persona as "legal" | "engineering" | "cyber" | undefined) || undefined,
      // Ownership is set atomically inside the pipeline's saveTask INSERT
      // so newly created tasks are never momentarily visible to other
      // tenants via the legacy NULL-fallback in visibility filters.
      user_id: req.user?.id ?? null,
    });

    const task_rows = await db.select().from(tasksTable).where(eq(tasksTable.id, result.task_id)).limit(1);
    const task = task_rows[0];
    // Merge run_id and execution_mode into the response
    res.json(task ? { ...task, run_id: result.run_id, execution_mode: result.execution_mode } : { id: result.task_id, ...result });
  } catch (err) {
    req.log.error({ err }, "Pipeline error");
    res.status(500).json({ error: "Internal pipeline error", code: "SYSTEM_ERROR" });
  }
});

router.get("/stats", async (req, res) => {
  try {
    // Stats must respect the same role-based visibility model as /tasks.
    // For non-super users the totals, by-type, by-provider, attempt costs
    // and fallback counts are all restricted to tasks they can actually
    // see (own + legacy NULL). Without this, /stats leaks aggregated
    // cross-tenant activity (counts, totals, costs, latencies).
    const where = visibilityFilter(req);

    const totalsQuery = db
      .select({
        total_tasks: count(),
        go_count: sql<number>`count(*) filter (where tri_state = 'GO')`,
        hold_count: sql<number>`count(*) filter (where tri_state = 'HOLD')`,
        abort_count: sql<number>`count(*) filter (where tri_state = 'ABORT')`,
      })
      .from(tasksTable);
    const [totals] = where ? await totalsQuery.where(where) : await totalsQuery;

    // For attempts and fallbacks, narrow to tasks visible to this user.
    // Super_admin (`where === undefined`) skips the join and aggregates
    // everything, matching the unfiltered list views.
    const attempts_stats = where
      ? await db
          .select({
            avg_latency: sql<number>`avg(${modelAttemptsTable.latency_ms})`,
            total_cost: sql<number>`sum(${modelAttemptsTable.cost_estimate})`,
          })
          .from(modelAttemptsTable)
          .innerJoin(tasksTable, eq(tasksTable.id, modelAttemptsTable.task_id))
          .where(where)
      : await db
          .select({
            avg_latency: sql<number>`avg(latency_ms)`,
            total_cost: sql<number>`sum(cost_estimate)`,
          })
          .from(modelAttemptsTable);

    const fallback_count = where
      ? await db
          .select({ c: count() })
          .from(fallbackEventsTable)
          .innerJoin(tasksTable, eq(tasksTable.id, fallbackEventsTable.task_id))
          .where(where)
      : await db.select({ c: count() }).from(fallbackEventsTable);

    const by_type_query = db
      .select({ task_type: tasksTable.task_type, c: count() })
      .from(tasksTable)
      .groupBy(tasksTable.task_type);
    const by_type_rows = where ? await by_type_query.where(where) : await by_type_query;

    const by_provider_query = db
      .select({ provider: tasksTable.selected_provider, c: count() })
      .from(tasksTable)
      .groupBy(tasksTable.selected_provider);
    const by_provider_rows = where ? await by_provider_query.where(where) : await by_provider_query;

    const total = totals?.total_tasks || 0;
    const go = totals?.go_count || 0;
    const success_rate = total > 0 ? go / total : 0;

    res.json({
      total_tasks: total,
      go_count: go,
      hold_count: totals?.hold_count || 0,
      abort_count: totals?.abort_count || 0,
      avg_latency_ms: attempts_stats[0]?.avg_latency || 0,
      total_cost_estimate: attempts_stats[0]?.total_cost || 0,
      tasks_by_type: Object.fromEntries(by_type_rows.map((r) => [r.task_type, r.c])),
      tasks_by_provider: Object.fromEntries(by_provider_rows.filter((r) => r.provider).map((r) => [r.provider!, r.c])),
      fallback_count: fallback_count[0]?.c || 0,
      success_rate,
    });
  } catch (err) {
    req.log.error({ err }, "Stats error");
    res.status(500).json({ error: "Failed to get stats", code: "SYSTEM_ERROR" });
  }
});

// Role-aware visibility:
//  - super_admin sees every task in the system (unfiltered).
//  - everyone else sees only tasks they created (user_id = req.user.id) plus
//    legacy tasks that pre-date user tagging (user_id is NULL), so existing
//    workspaces don't go dark after the migration.
function visibilityFilter(req: { user?: { id: string; role: string } }) {
  if (req.user?.role === "super_admin") return undefined;
  const uid = req.user?.id ?? "";
  return or(eq(tasksTable.user_id, uid), isNull(tasksTable.user_id));
}

router.get("/", async (req, res) => {
  const parsed = ListTasksQueryParams.safeParse(req.query);
  const limit = parsed.success ? (parsed.data.limit ?? 50) : 50;
  const offset = parsed.success ? (parsed.data.offset ?? 0) : 0;

  const where = visibilityFilter(req);
  const tasks = where
    ? await db.select().from(tasksTable).where(where).orderBy(desc(tasksTable.created_at)).limit(limit).offset(offset)
    : await db.select().from(tasksTable).orderBy(desc(tasksTable.created_at)).limit(limit).offset(offset);
  const total_rows = where
    ? await db.select({ c: count() }).from(tasksTable).where(where)
    : await db.select({ c: count() }).from(tasksTable);

  res.json({ tasks, total: total_rows[0]?.c || 0, limit, offset });
});

router.get("/:id", async (req, res) => {
  const { id } = req.params;
  if (!id) { res.status(400).json({ error: "Missing id" }); return; }

  const where = visibilityFilter(req);
  const [task] = where
    ? await db.select().from(tasksTable).where(and(eq(tasksTable.id, id), where)).limit(1)
    : await db.select().from(tasksTable).where(eq(tasksTable.id, id)).limit(1);
  if (!task) { res.status(404).json({ error: "Task not found", code: "NOT_FOUND" }); return; }

  const [attempts, validation, fallbacks, audit, runs] = await Promise.all([
    db.select().from(modelAttemptsTable).where(eq(modelAttemptsTable.task_id, id)).orderBy(modelAttemptsTable.attempt_number),
    db.select().from(validationResultsTable).where(eq(validationResultsTable.task_id, id)),
    db.select().from(fallbackEventsTable).where(eq(fallbackEventsTable.task_id, id)).orderBy(desc(fallbackEventsTable.created_at)),
    db.select().from(auditLogsTable).where(eq(auditLogsTable.task_id, id)).orderBy(auditLogsTable.created_at),
    // Surface the latest execution_run id directly so the super-admin
    // override UI never has to dig through audit metadata to discover
    // a run id (which isn't reliably stamped on every event).
    db
      .select({ id: executionRunsTable.id })
      .from(executionRunsTable)
      .where(eq(executionRunsTable.task_id, id))
      .orderBy(desc(executionRunsTable.started_at))
      .limit(1),
  ]);

  let bos_output = null;
  try {
    if (task.final_output) bos_output = JSON.parse(task.final_output);
  } catch {}

  const run_id = runs[0]?.id ?? null;
  res.json({ task, attempts, validation, fallbacks, audit, bos_output, run_id });
});

router.get("/:id/attempts", async (req, res) => {
  const { id } = req.params;
  if (!id) { res.status(400).json({ error: "Missing id" }); return; }

  // Confirm the requester can see the parent task before returning attempts.
  // Without this, a non-super user with a task id could enumerate every
  // model attempt in the system.
  const where = visibilityFilter(req);
  const [task] = where
    ? await db.select({ id: tasksTable.id }).from(tasksTable).where(and(eq(tasksTable.id, id), where)).limit(1)
    : await db.select({ id: tasksTable.id }).from(tasksTable).where(eq(tasksTable.id, id)).limit(1);
  if (!task) { res.status(404).json({ error: "Task not found", code: "NOT_FOUND" }); return; }

  const attempts = await db
    .select()
    .from(modelAttemptsTable)
    .where(eq(modelAttemptsTable.task_id, id))
    .orderBy(modelAttemptsTable.attempt_number);

  res.json(attempts);
});

export default router;
