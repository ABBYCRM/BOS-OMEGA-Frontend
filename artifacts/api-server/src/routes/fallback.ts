import { Router } from "express";
import { db } from "@workspace/db";
import { fallbackEventsTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import { ListFallbackEventsQueryParams } from "@workspace/api-zod";

const router = Router();

router.get("/", async (req, res) => {
  const parsed = ListFallbackEventsQueryParams.safeParse(req.query);
  const limit = parsed.success ? (parsed.data.limit ?? 50) : 50;
  const events = await db.select().from(fallbackEventsTable).orderBy(desc(fallbackEventsTable.created_at)).limit(limit);
  res.json(events);
});

export default router;
