import { Router } from "express";
import { db } from "@workspace/db";
import { triStateDecisionsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";

const router = Router();

// GET /api/tri-state/by-task/:task_id — get the tri-state decision for a task
router.get("/by-task/:task_id", async (req, res) => {
  const { task_id } = req.params;
  if (!task_id) { res.status(400).json({ error: "Missing task_id" }); return; }

  const [decision] = await db
    .select()
    .from(triStateDecisionsTable)
    .where(eq(triStateDecisionsTable.task_id, task_id))
    .orderBy(desc(triStateDecisionsTable.created_at))
    .limit(1);

  if (!decision) { res.status(404).json({ error: "Tri-state decision not found" }); return; }
  res.json(decision);
});

// GET /api/tri-state/:id — get a specific tri-state decision
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  if (!id) { res.status(400).json({ error: "Missing id" }); return; }

  const [decision] = await db
    .select()
    .from(triStateDecisionsTable)
    .where(eq(triStateDecisionsTable.id, id))
    .limit(1);

  if (!decision) { res.status(404).json({ error: "Not found" }); return; }
  res.json(decision);
});

// GET /api/tri-state — list recent decisions
router.get("/", async (req, res) => {
  const limit = Number(req.query["limit"]) || 50;
  const decisions = await db
    .select()
    .from(triStateDecisionsTable)
    .orderBy(desc(triStateDecisionsTable.created_at))
    .limit(limit);
  res.json(decisions);
});

export default router;
