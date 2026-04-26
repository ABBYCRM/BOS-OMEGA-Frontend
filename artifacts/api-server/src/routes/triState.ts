import { Router } from "express";
import { db } from "@workspace/db";
import { triStateDecisionsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { z } from "zod";

const router = Router();

const IdParam = z.string().min(1).max(128);
const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

router.get("/by-task/:task_id", async (req, res) => {
  const parsed = IdParam.safeParse(req.params["task_id"]);
  if (!parsed.success) { res.status(400).json({ error: "Invalid task_id" }); return; }

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

  const [decision] = await db
    .select()
    .from(triStateDecisionsTable)
    .where(eq(triStateDecisionsTable.id, parsed.data))
    .limit(1);

  if (!decision) { res.status(404).json({ error: "Not found" }); return; }
  res.json(decision);
});

router.get("/", async (req, res) => {
  const parsed = ListQuery.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Invalid query" }); return; }
  const decisions = await db
    .select()
    .from(triStateDecisionsTable)
    .orderBy(desc(triStateDecisionsTable.created_at))
    .limit(parsed.data.limit);
  res.json(decisions);
});

export default router;
