import { Router } from "express";
import { db } from "@workspace/db";
import { triStateDecisionsTable, tasksTable } from "@workspace/db";
import { eq, desc, and, or, isNull } from "drizzle-orm";
import { z } from "zod";

const router = Router();

const IdParam = z.string().min(1).max(128);
const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// Mirrors the visibility model used across tasks/runs/memory/audit:
// super_admin sees everything; everyone else sees rows for tasks they own
// (user_id = self) plus legacy tasks with no owner stamped.
function visibilityFilter(req: { user?: { id: string; role: string } }) {
  if (req.user?.role === "super_admin") return undefined;
  const uid = req.user?.id ?? "";
  return or(eq(tasksTable.user_id, uid), isNull(tasksTable.user_id));
}

router.get("/by-task/:task_id", async (req, res) => {
  const parsed = IdParam.safeParse(req.params["task_id"]);
  if (!parsed.success) { res.status(400).json({ error: "Invalid task_id" }); return; }

  // Authorize task visibility before returning the decision. Without this,
  // any authenticated user could fetch tri-state outcomes for any task by
  // guessing or enumerating task ids.
  const where = visibilityFilter(req);
  const [task] = where
    ? await db.select({ id: tasksTable.id }).from(tasksTable).where(and(eq(tasksTable.id, parsed.data), where)).limit(1)
    : await db.select({ id: tasksTable.id }).from(tasksTable).where(eq(tasksTable.id, parsed.data)).limit(1);
  if (!task) { res.status(404).json({ error: "Tri-state decision not found" }); return; }

  const [decision] = await db
    .select()
    .from(triStateDecisionsTable)
    .where(eq(triStateDecisionsTable.task_id, parsed.data))
    .orderBy(desc(triStateDecisionsTable.created_at))
    .limit(1);

  if (!decision) { res.status(404).json({ error: "Tri-state decision not found" }); return; }
  res.json(decision);
});

router.get("/:id", async (req, res) => {
  const parsed = IdParam.safeParse(req.params["id"]);
  if (!parsed.success) { res.status(400).json({ error: "Invalid id" }); return; }

  // Join through tasks so a non-super user can only see decisions whose
  // parent task they're allowed to see. Unauthorized rows return 404 so
  // we don't leak existence.
  const where = visibilityFilter(req);
  const rows = where
    ? await db
        .select({ decision: triStateDecisionsTable })
        .from(triStateDecisionsTable)
        .innerJoin(tasksTable, eq(tasksTable.id, triStateDecisionsTable.task_id))
        .where(and(eq(triStateDecisionsTable.id, parsed.data), where))
        .limit(1)
    : await db
        .select({ decision: triStateDecisionsTable })
        .from(triStateDecisionsTable)
        .where(eq(triStateDecisionsTable.id, parsed.data))
        .limit(1);

  const decision = rows[0]?.decision;
  if (!decision) { res.status(404).json({ error: "Not found" }); return; }
  res.json(decision);
});

router.get("/", async (req, res) => {
  const parsed = ListQuery.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Invalid query" }); return; }

  // Same scoping for the list view: super_admin sees the whole stream,
  // everyone else only sees decisions tied to tasks they can see.
  const where = visibilityFilter(req);
  const rows = where
    ? await db
        .select({ decision: triStateDecisionsTable })
        .from(triStateDecisionsTable)
        .innerJoin(tasksTable, eq(tasksTable.id, triStateDecisionsTable.task_id))
        .where(where)
        .orderBy(desc(triStateDecisionsTable.created_at))
        .limit(parsed.data.limit)
    : await db
        .select({ decision: triStateDecisionsTable })
        .from(triStateDecisionsTable)
        .orderBy(desc(triStateDecisionsTable.created_at))
        .limit(parsed.data.limit);

  res.json(rows.map((r) => r.decision));
});

export default router;
