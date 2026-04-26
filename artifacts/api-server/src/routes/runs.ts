import { Router } from "express";
import { db } from "@workspace/db";
import {
  executionRunsTable,
  seriesPassesTable,
  parallelAgentsTable,
  synthesisReportsTable,
  tasksTable,
} from "@workspace/db";
import { eq, desc } from "drizzle-orm";

const router = Router();

// GET /api/runs/:id — full execution run
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  if (!id) { res.status(400).json({ error: "Missing run id" }); return; }

  const [run] = await db.select().from(executionRunsTable).where(eq(executionRunsTable.id, id)).limit(1);
  if (!run) { res.status(404).json({ error: "Run not found" }); return; }

  const task = run.task_id
    ? await db.select().from(tasksTable).where(eq(tasksTable.id, run.task_id)).limit(1).then((r) => r[0] || null)
    : null;

  res.json({ run, task });
});

// GET /api/runs/:id/series — series pass steps
router.get("/:id/series", async (req, res) => {
  const { id } = req.params;
  if (!id) { res.status(400).json({ error: "Missing run id" }); return; }

  const passes = await db
    .select()
    .from(seriesPassesTable)
    .where(eq(seriesPassesTable.run_id, id))
    .orderBy(seriesPassesTable.pass_number);

  res.json(passes);
});

// GET /api/runs/:id/parallel-agents — BTE agent outputs
router.get("/:id/parallel-agents", async (req, res) => {
  const { id } = req.params;
  if (!id) { res.status(400).json({ error: "Missing run id" }); return; }

  const agents = await db
    .select()
    .from(parallelAgentsTable)
    .where(eq(parallelAgentsTable.run_id, id))
    .orderBy(parallelAgentsTable.created_at);

  res.json(agents);
});

// GET /api/runs/:id/synthesis — synthesis report
router.get("/:id/synthesis", async (req, res) => {
  const { id } = req.params;
  if (!id) { res.status(400).json({ error: "Missing run id" }); return; }

  const [report] = await db
    .select()
    .from(synthesisReportsTable)
    .where(eq(synthesisReportsTable.run_id, id))
    .limit(1);

  if (!report) { res.status(404).json({ error: "Synthesis report not found" }); return; }
  res.json(report);
});

// GET /api/runs — list recent runs
router.get("/", async (req, res) => {
  const limit = Number(req.query["limit"]) || 50;
  const runs = await db
    .select()
    .from(executionRunsTable)
    .orderBy(desc(executionRunsTable.started_at))
    .limit(limit);
  res.json(runs);
});

export default router;
