import { Router } from "express";
import { db } from "@workspace/db";
import { auditLogsTable, tasksTable } from "@workspace/db";
import { eq, desc, and, or, isNull, inArray, sql } from "drizzle-orm";
import { ListAuditLogsQueryParams } from "@workspace/api-zod";

const router = Router();

// Audit log visibility:
//  - super_admin sees every entry, including override and user-management
//    actions taken on tasks they don't own.
//  - non-super sees entries scoped to tasks they can see (their own tasks
//    plus legacy untagged tasks). For task-less rows (system-level events
//    like USER_CREATED / USER_DISABLED), we further restrict by metadata so
//    a non-super user only sees null-task rows where they were either the
//    actor or the target — never other users' management actions.
async function audienceFilter(req: { user?: { id: string; role: string } }) {
  if (req.user?.role === "super_admin") return undefined;
  const uid = req.user?.id ?? "";
  const visibleTasks = await db
    .select({ id: tasksTable.id })
    .from(tasksTable)
    .where(or(eq(tasksTable.user_id, uid), isNull(tasksTable.user_id)));
  const ids = visibleTasks.map((r) => r.id);
  const nullTaskSelfClause = and(
    isNull(auditLogsTable.task_id),
    or(
      sql`${auditLogsTable.metadata}->>'actor_user_id' = ${uid}`,
      sql`${auditLogsTable.metadata}->>'target_user_id' = ${uid}`,
    ),
  );
  return ids.length > 0
    ? or(inArray(auditLogsTable.task_id, ids), nullTaskSelfClause)
    : nullTaskSelfClause;
}

router.get("/", async (req, res) => {
  const parsed = ListAuditLogsQueryParams.safeParse(req.query);
  const limit = parsed.success ? (parsed.data.limit ?? 100) : 100;
  const task_id = parsed.success ? parsed.data.task_id : undefined;

  const audience = await audienceFilter(req);
  const taskClause = task_id ? eq(auditLogsTable.task_id, task_id) : undefined;
  const where =
    audience && taskClause ? and(taskClause, audience)
      : audience ?? taskClause;

  const logs = where
    ? await db.select().from(auditLogsTable).where(where).orderBy(desc(auditLogsTable.created_at)).limit(limit)
    : await db.select().from(auditLogsTable).orderBy(desc(auditLogsTable.created_at)).limit(limit);

  // Task #49: scrub the un-truncated memory_context_full out of generic
  // audit-list responses too. The full payload is intentionally retrievable
  // only via GET /api/tasks/:id/memory-context (which loads it on demand);
  // returning it inline here would bloat audit-list responses by tens of
  // KB per task and defeat the on-demand loading model.
  const sanitized = logs.map((row) => {
    if (row.event_type !== "MEMORY_INJECTED" || !row.metadata || typeof row.metadata !== "object") {
      return row;
    }
    const meta = row.metadata as Record<string, unknown>;
    if (!("memory_context_full" in meta)) return row;
    const { memory_context_full: _omit, ...rest } = meta;
    return { ...row, metadata: rest };
  });

  res.json(sanitized);
});

export default router;
