import { Router } from "express";
import { db } from "@workspace/db";
import { fallbackEventsTable, tasksTable } from "@workspace/db";
import { desc, eq, or, isNull, inArray } from "drizzle-orm";
import { ListFallbackEventsQueryParams } from "@workspace/api-zod";

const router = Router();

router.get("/", async (req, res) => {
  const parsed = ListFallbackEventsQueryParams.safeParse(req.query);
  const limit = parsed.success ? (parsed.data.limit ?? 50) : 50;

  // Fallback events are linked to a task. Non-super-admin users only see
  // events for tasks they own (or legacy untagged tasks) plus events with
  // no task_id at all. super_admin sees the unfiltered set.
  if (req.user?.role === "super_admin") {
    const events = await db.select().from(fallbackEventsTable).orderBy(desc(fallbackEventsTable.created_at)).limit(limit);
    res.json(events);
    return;
  }

  const uid = req.user?.id ?? "";
  const visibleTasks = await db
    .select({ id: tasksTable.id })
    .from(tasksTable)
    .where(or(eq(tasksTable.user_id, uid), isNull(tasksTable.user_id)));
  const ids = visibleTasks.map((t) => t.id);
  const where = ids.length > 0
    ? or(inArray(fallbackEventsTable.task_id, ids), isNull(fallbackEventsTable.task_id))
    : isNull(fallbackEventsTable.task_id);
  const events = await db
    .select()
    .from(fallbackEventsTable)
    .where(where)
    .orderBy(desc(fallbackEventsTable.created_at))
    .limit(limit);
  res.json(events);
});

export default router;
