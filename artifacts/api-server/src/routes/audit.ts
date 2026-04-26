import { Router } from "express";
import { db } from "@workspace/db";
import { auditLogsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { ListAuditLogsQueryParams } from "@workspace/api-zod";

const router = Router();

router.get("/", async (req, res) => {
  const parsed = ListAuditLogsQueryParams.safeParse(req.query);
  const limit = parsed.success ? (parsed.data.limit ?? 100) : 100;
  const task_id = parsed.success ? parsed.data.task_id : undefined;

  const query = db.select().from(auditLogsTable).orderBy(desc(auditLogsTable.created_at)).limit(limit);

  let logs;
  if (task_id) {
    logs = await db.select().from(auditLogsTable).where(eq(auditLogsTable.task_id, task_id)).orderBy(auditLogsTable.created_at).limit(limit);
  } else {
    logs = await query;
  }

  res.json(logs);
});

export default router;
