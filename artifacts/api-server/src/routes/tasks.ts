import { Router } from "express";
import { db } from "@workspace/db";
import {
  tasksTable,
  modelAttemptsTable,
  validationResultsTable,
  fallbackEventsTable,
  auditLogsTable,
} from "@workspace/db";
import { eq, desc, count, sql } from "drizzle-orm";
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

  try {
    const result = await runBosPipeline({
      input: parsed.data.input,
      mode: parsed.data.mode as "single" | "parallel" | "consensus" | "series_pass" | "boil_the_ocean" | "auto" | undefined,
      task_type_override: parsed.data.task_type_override || undefined,
      parallel_models: parsed.data.parallel_models || undefined,
      max_models: parsed.data.max_models || undefined,
      agents_per_model: parsed.data.agents_per_model || undefined,
      attachment_ids: parsed.data.attachment_ids || undefined,
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
    const [totals] = await db
      .select({
        total_tasks: count(),
        go_count: sql<number>`count(*) filter (where tri_state = 'GO')`,
        hold_count: sql<number>`count(*) filter (where tri_state = 'HOLD')`,
        abort_count: sql<number>`count(*) filter (where tri_state = 'ABORT')`,
      })
      .from(tasksTable);

    const attempts_stats = await db
      .select({
        avg_latency: sql<number>`avg(latency_ms)`,
        total_cost: sql<number>`sum(cost_estimate)`,
      })
      .from(modelAttemptsTable);

    const fallback_count = await db.select({ c: count() }).from(fallbackEventsTable);

    const by_type_rows = await db
      .select({ task_type: tasksTable.task_type, c: count() })
      .from(tasksTable)
      .groupBy(tasksTable.task_type);

    const by_provider_rows = await db
      .select({ provider: tasksTable.selected_provider, c: count() })
      .from(tasksTable)
      .groupBy(tasksTable.selected_provider);

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

router.get("/", async (req, res) => {
  const parsed = ListTasksQueryParams.safeParse(req.query);
  const limit = parsed.success ? (parsed.data.limit ?? 50) : 50;
  const offset = parsed.success ? (parsed.data.offset ?? 0) : 0;

  const tasks = await db.select().from(tasksTable).orderBy(desc(tasksTable.created_at)).limit(limit).offset(offset);
  const total_rows = await db.select({ c: count() }).from(tasksTable);

  res.json({ tasks, total: total_rows[0]?.c || 0, limit, offset });
});

router.get("/:id", async (req, res) => {
  const { id } = req.params;
  if (!id) { res.status(400).json({ error: "Missing id" }); return; }

  const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, id)).limit(1);
  if (!task) { res.status(404).json({ error: "Task not found", code: "NOT_FOUND" }); return; }

  const [attempts, validation, fallbacks, audit] = await Promise.all([
    db.select().from(modelAttemptsTable).where(eq(modelAttemptsTable.task_id, id)).orderBy(modelAttemptsTable.attempt_number),
    db.select().from(validationResultsTable).where(eq(validationResultsTable.task_id, id)),
    db.select().from(fallbackEventsTable).where(eq(fallbackEventsTable.task_id, id)).orderBy(desc(fallbackEventsTable.created_at)),
    db.select().from(auditLogsTable).where(eq(auditLogsTable.task_id, id)).orderBy(auditLogsTable.created_at),
  ]);

  let bos_output = null;
  try {
    if (task.final_output) bos_output = JSON.parse(task.final_output);
  } catch {}

  res.json({ task, attempts, validation, fallbacks, audit, bos_output });
});

router.get("/:id/attempts", async (req, res) => {
  const { id } = req.params;
  if (!id) { res.status(400).json({ error: "Missing id" }); return; }

  const attempts = await db
    .select()
    .from(modelAttemptsTable)
    .where(eq(modelAttemptsTable.task_id, id))
    .orderBy(modelAttemptsTable.attempt_number);

  res.json(attempts);
});

export default router;
