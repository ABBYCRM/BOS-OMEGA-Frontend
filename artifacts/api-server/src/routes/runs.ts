import { Router } from "express";
import { db } from "@workspace/db";
import {
  executionRunsTable,
  seriesPassesTable,
  parallelAgentsTable,
  synthesisReportsTable,
  tasksTable,
} from "@workspace/db";
import { eq, desc, or, isNull, inArray } from "drizzle-orm";
import { z } from "zod";

const router = Router();

// Visibility helper: super_admin sees every run; non-super sees runs whose
// task belongs to them (or is legacy/untagged). Runs with no task_id are
// surfaced to all authenticated users since they aren't owned by anyone.
async function visibleRunIds(req: { user?: { id: string; role: string } }): Promise<string[] | "ALL"> {
  if (req.user?.role === "super_admin") return "ALL";
  const uid = req.user?.id ?? "";
  const tasks = await db
    .select({ id: tasksTable.id })
    .from(tasksTable)
    .where(or(eq(tasksTable.user_id, uid), isNull(tasksTable.user_id)));
  const taskIds = tasks.map((t) => t.id);
  if (taskIds.length === 0) {
    const orphanRuns = await db
      .select({ id: executionRunsTable.id })
      .from(executionRunsTable)
      .where(isNull(executionRunsTable.task_id));
    return orphanRuns.map((r) => r.id);
  }
  const runs = await db
    .select({ id: executionRunsTable.id })
    .from(executionRunsTable)
    .where(or(inArray(executionRunsTable.task_id, taskIds), isNull(executionRunsTable.task_id)));
  return runs.map((r) => r.id);
}

const IdParam = z.object({ id: z.string().uuid().or(z.string().min(1).max(128)) });
const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

function parseId(req: { params: Record<string, string | undefined> }): string | null {
  const r = IdParam.safeParse(req.params);
  return r.success ? r.data.id : null;
}

async function isRunVisible(req: { user?: { id: string; role: string } }, runId: string): Promise<boolean> {
  if (req.user?.role === "super_admin") return true;
  const visible = await visibleRunIds(req);
  if (visible === "ALL") return true;
  return visible.includes(runId);
}

router.get("/:id", async (req, res) => {
  const id = parseId(req);
  if (!id) { res.status(400).json({ error: "Invalid run id" }); return; }

  if (!(await isRunVisible(req, id))) {
    res.status(404).json({ error: "Run not found" });
    return;
  }

  const [run] = await db.select().from(executionRunsTable).where(eq(executionRunsTable.id, id)).limit(1);
  if (!run) { res.status(404).json({ error: "Run not found" }); return; }

  const task = run.task_id
    ? await db.select().from(tasksTable).where(eq(tasksTable.id, run.task_id)).limit(1).then((r) => r[0] || null)
    : null;

  res.json({ run, task });
});

router.get("/:id/series", async (req, res) => {
  const id = parseId(req);
  if (!id) { res.status(400).json({ error: "Invalid run id" }); return; }
  if (!(await isRunVisible(req, id))) {
    res.status(404).json({ error: "Run not found" });
    return;
  }

  const passes = await db
    .select()
    .from(seriesPassesTable)
    .where(eq(seriesPassesTable.run_id, id))
    .orderBy(seriesPassesTable.pass_number);

  res.json(passes);
});

router.get("/:id/parallel-agents", async (req, res) => {
  const id = parseId(req);
  if (!id) { res.status(400).json({ error: "Invalid run id" }); return; }
  if (!(await isRunVisible(req, id))) {
    res.status(404).json({ error: "Run not found" });
    return;
  }

  const agents = await db
    .select()
    .from(parallelAgentsTable)
    .where(eq(parallelAgentsTable.run_id, id))
    .orderBy(parallelAgentsTable.created_at);

  res.json(agents);
});

router.get("/:id/synthesis", async (req, res) => {
  const id = parseId(req);
  if (!id) { res.status(400).json({ error: "Invalid run id" }); return; }
  if (!(await isRunVisible(req, id))) {
    res.status(404).json({ error: "Run not found" });
    return;
  }

  const [report] = await db
    .select()
    .from(synthesisReportsTable)
    .where(eq(synthesisReportsTable.run_id, id))
    .limit(1);

  if (!report) { res.status(404).json({ error: "Synthesis report not found" }); return; }
  res.json(report);
});

router.get("/", async (req, res) => {
  const parsed = ListQuery.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Invalid query" }); return; }
  const visible = await visibleRunIds(req);
  const runs = visible === "ALL"
    ? await db.select().from(executionRunsTable).orderBy(desc(executionRunsTable.started_at)).limit(parsed.data.limit)
    : visible.length === 0
      ? []
      : await db.select().from(executionRunsTable).where(inArray(executionRunsTable.id, visible)).orderBy(desc(executionRunsTable.started_at)).limit(parsed.data.limit);
  res.json(runs);
});

export default router;
