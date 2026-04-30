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
  // Tagged-task visibility: only the user's own tasks. The legacy NULL
  // fallback was removed when self-signup opened the door to arbitrary
  // accounts — see tasks.ts/visibilityFilter for the full rationale.
  const visibleTasks = await db
    .select({ id: tasksTable.id })
    .from(tasksTable)
    .where(eq(tasksTable.user_id, uid));
  const ids = visibleTasks.map((r) => r.id);
  // NULL-task audit rows (login attempts, password resets, etc.) are
  // still surfaced when the actor or target is the requester themselves
  // — they need to see their own auth events.
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
  // Task #72: pagination contract — `offset` lets the UI fetch older
  // pages without raising `limit` to absurd values. Defaults to 0 so
  // existing single-page callers (and the e2e test suite) keep their
  // current behaviour. Negative values are clamped to 0.
  const rawOffset = parsed.success ? (parsed.data.offset ?? 0) : 0;
  const offset = Math.max(0, rawOffset);
  const task_id = parsed.success ? parsed.data.task_id : undefined;

  const audience = await audienceFilter(req);
  const taskClause = task_id ? eq(auditLogsTable.task_id, task_id) : undefined;
  const where =
    audience && taskClause ? and(taskClause, audience)
      : audience ?? taskClause;

  // Task #72: count the matching rows in a single round-trip alongside
  // the page query so the client can show "Showing X of N" and know
  // when no older entries remain. We reuse the exact same WHERE clause
  // (audience + task filter) to keep the count consistent with what
  // the user is actually allowed to see.
  const countQuery = where
    ? db.select({ count: sql<number>`count(*)::int` }).from(auditLogsTable).where(where)
    : db.select({ count: sql<number>`count(*)::int` }).from(auditLogsTable);
  const pageQuery = where
    ? db.select().from(auditLogsTable).where(where).orderBy(desc(auditLogsTable.created_at)).limit(limit).offset(offset)
    : db.select().from(auditLogsTable).orderBy(desc(auditLogsTable.created_at)).limit(limit).offset(offset);

  const [countRows, logs] = await Promise.all([countQuery, pageQuery]);
  const total = countRows[0]?.count ?? 0;

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

  // Task #72: response is now an envelope so the UI can paginate. The
  // `entries` field carries the page rows; `total`/`limit`/`offset`
  // describe the window so the front-end can render
  // "Showing N of TOTAL" and disable the "Load older entries" button
  // once the end is reached. Existing e2e tests already use the
  // defensive `Array.isArray(r.data) ? r.data : (r.data?.entries ?? [])`
  // pattern (see continuity_bundle_e2e, lattice_e2e, etc.).
  res.json({ entries: sanitized, total, limit, offset });
});

export default router;
