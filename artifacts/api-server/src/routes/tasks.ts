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
import { eq, desc, count, sql, and, inArray } from "drizzle-orm";
import { runBosPipeline } from "../bos/pipeline.js";
import { CreateTaskBody, ListTasksQueryParams } from "@workspace/api-zod";
import { logger } from "../lib/logger.js";
import { expensiveLimiter } from "../lib/security/rateLimit.js";
import { z } from "zod";
import {
  planConversationAssignment,
  consumeReservation,
  ConversationNotFoundError,
  deriveTitle,
  deriveKeywords,
  type ConvDecision,
} from "../bos/conversationClusterer.js";

// Lattice continuity (Task #68) — these two fields are NOT part of the
// orval-generated CreateTaskBody schema (we deliberately don't regen
// openapi.yaml mid-feature), so the orval zod parser would silently
// strip them. Parse them off the raw body with a side schema before
// invoking the clusterer.
const ConversationCreateExtras = z.object({
  conversation_id: z.string().uuid().optional(),
  force_new_conversation: z.boolean().optional(),
});

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

  // Lattice continuity (Task #68): plan a conversation assignment
  // BEFORE the pipeline runs. We deliberately do NOT commit the
  // conversation row here — `planConversationAssignment` only reads
  // (it does ownership-check the explicit id). The actual INSERT or
  // UPDATE happens transactionally with the task row inside
  // pipeline.saveTask, so a downstream failure cannot strand an
  // empty conversations row. Three precedence levels: explicit id >
  // force_new > heuristic Jaccard. Cross-tenant leakage is
  // impossible because candidate threads are filtered by user_id
  // before scoring. Anonymous tasks (no req.user) skip clustering
  // entirely — there is nothing to scope to.
  const extras = ConversationCreateExtras.safeParse(req.body ?? {});
  if (!extras.success) {
    res.status(400).json({
      error: "Invalid conversation parameters",
      code: "INPUT_ERROR",
      issues: extras.error.issues.map((i) => ({ path: i.path, message: i.message, code: i.code })),
    });
    return;
  }
  let conversation_decision: ConvDecision | null = null;
  if (req.user?.id) {
    // Manual-create reservation path: when the client previously called
    // POST /api/conversations, the returned id is a reservation (not yet
    // in the DB). The first task that targets it materializes the row
    // transactionally with `commitConversationDecision`. Consume the
    // reservation BEFORE falling through to the standard planner so an
    // explicit conversation_id from the manual-create UX doesn't 404.
    if (extras.data.conversation_id) {
      const reserved = consumeReservation(req.user.id, extras.data.conversation_id);
      if (reserved) {
        conversation_decision = {
          kind: "new",
          conversation_id: reserved.id,
          title: reserved.title,
          topic_keywords: deriveKeywords(parsed.data.input),
          method: "force_new",
        };
      }
    }
    if (!conversation_decision) {
      try {
        conversation_decision = await planConversationAssignment({
          userId: req.user.id,
          inputText: parsed.data.input,
          explicitId: extras.data.conversation_id ?? null,
          forceNew: extras.data.force_new_conversation ?? false,
        });
      } catch (err) {
        if (err instanceof ConversationNotFoundError) {
          res.status(404).json({ error: err.message, code: err.code });
          return;
        }
        // Clustering DB read failed transiently. Rather than silently
        // dropping the task into an unscoped row (which weakens the
        // "every authenticated task is conversation-scoped" contract
        // and is a pain to clean up later), fall back to a deterministic
        // force-new decision so the task lands in a fresh thread we can
        // audit and reassign. The new conversation row is still created
        // atomically with the task INSERT in saveTask.
        req.log.warn({ err }, "Conversation clustering failed; falling back to force_new for this task");
        conversation_decision = {
          kind: "new",
          conversation_id: (await import("crypto")).randomUUID(),
          title: deriveTitle(parsed.data.input),
          topic_keywords: deriveKeywords(parsed.data.input),
          method: "force_new",
        };
      }
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
      persona_slot: (parsed.data as { persona_slot?: string }).persona_slot as ("A"|"B"|"C"|undefined) || undefined,
      // Ownership is set atomically inside the pipeline's saveTask INSERT
      // so newly created tasks are never momentarily visible to other
      // tenants via the legacy NULL-fallback in visibility filters.
      user_id: req.user?.id ?? null,
      conversation_decision,
    });

    const task_rows = await db.select().from(tasksTable).where(eq(tasksTable.id, result.task_id)).limit(1);
    const task = task_rows[0];
    // Merge run_id and execution_mode into the response
    res.json(task ? { ...task, run_id: result.run_id, execution_mode: result.execution_mode } : { id: result.task_id, ...result });
  } catch (err) {
    // BOP.CANON_GOVERNANCE.v1: surface CANON_LOAD_ERROR distinctly so
    // operators / monitoring can tell "the model contract failed to load"
    // apart from generic pipeline crashes.
    if (err && typeof err === "object" && (err as { code?: string }).code === "CANON_LOAD_ERROR") {
      req.log.error({ err }, "CANON_LOAD_ERROR — refusing to call model without governance overlay");
      res.status(500).json({
        error: "Canon governance memory failed to load",
        code: "CANON_LOAD_ERROR",
        message: (err as Error).message || "Canon load failed",
      });
      return;
    }
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
//  - everyone else sees only tasks they created (user_id = req.user.id).
//
// Pre-self-signup, this filter also returned tasks where user_id IS NULL
// so the original single-admin workspace wouldn't go dark after the
// user-tagging migration. That was safe when the only authenticated
// account was the admin. Once self-signup landed (anyone on the
// internet can become a `user`), keeping the NULL clause leaked all
// 69 legacy admin-era tasks to every new account. NULL-tagged rows are
// now admin-and-up only — admins still see them via the unfiltered
// branch, regular users see only the rows they actually own.
function visibilityFilter(req: { user?: { id: string; role: string } }) {
  if (req.user?.role === "super_admin") return undefined;
  const uid = req.user?.id ?? "";
  return eq(tasksTable.user_id, uid);
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

  // Task #49: scrub the un-truncated `memory_context_full` field out of the
  // task-detail audit payload. The full context can be tens of KB per task
  // and is fetched on demand via GET /api/tasks/:id/memory-context — keeping
  // it in the inline trace would balloon every TaskDetail response and
  // re-download it on every audit-list refresh.
  const trimmed_audit = audit.map((row) => {
    if (row.event_type !== "MEMORY_INJECTED" || !row.metadata || typeof row.metadata !== "object") {
      return row;
    }
    const meta = row.metadata as Record<string, unknown>;
    if (!("memory_context_full" in meta)) return row;
    const { memory_context_full: _omit, ...rest } = meta;
    return { ...row, metadata: rest };
  });

  const run_id = runs[0]?.id ?? null;
  res.json({ task, attempts, validation, fallbacks, audit: trimmed_audit, bos_output, run_id });
});

// Task #49: return the un-truncated memory_context the orchestrator injected
// for this task. Visibility is gated on the same role-aware filter as
// GET /api/tasks/:id so a non-super user can never read the memory text of
// another user's task. The full payload lives in the MEMORY_INJECTED audit
// row's metadata (see pipeline.ts). For tasks created before Task #49 the
// full payload is absent; we transparently fall back to the bounded preview
// so the panel still shows something useful and reports `truncated: true`.
router.get("/:id/memory-context", async (req, res) => {
  const { id } = req.params;
  if (!id) { res.status(400).json({ error: "Missing id" }); return; }

  const where = visibilityFilter(req);
  const [task] = where
    ? await db.select({ id: tasksTable.id }).from(tasksTable).where(and(eq(tasksTable.id, id), where)).limit(1)
    : await db.select({ id: tasksTable.id }).from(tasksTable).where(eq(tasksTable.id, id)).limit(1);
  if (!task) { res.status(404).json({ error: "Task not found", code: "NOT_FOUND" }); return; }

  // The orchestrator emits exactly one MEMORY_INJECTED event per task, but
  // older tasks (or future re-runs) could have multiple — pick the most
  // recent so the user sees what was injected for the current trace.
  const [row] = await db
    .select()
    .from(auditLogsTable)
    .where(and(eq(auditLogsTable.task_id, id), eq(auditLogsTable.event_type, "MEMORY_INJECTED")))
    .orderBy(desc(auditLogsTable.created_at))
    .limit(1);

  if (!row) {
    res.status(404).json({ error: "No memory context recorded for this task", code: "NOT_FOUND" });
    return;
  }

  const meta = (row.metadata && typeof row.metadata === "object")
    ? (row.metadata as Record<string, unknown>)
    : {};
  const full = typeof meta.memory_context_full === "string" ? meta.memory_context_full : null;
  const preview = typeof meta.memory_context_preview === "string" ? meta.memory_context_preview : "";
  const chars = typeof meta.memory_context_chars === "number" ? meta.memory_context_chars : (full?.length ?? preview.length);

  if (full !== null) {
    res.json({ memory_context: full, chars, truncated: false });
    return;
  }
  // Legacy task — full payload was never persisted. Return the preview
  // and signal that this is the most we can serve.
  res.json({ memory_context: preview, chars, truncated: preview.length < chars });
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
