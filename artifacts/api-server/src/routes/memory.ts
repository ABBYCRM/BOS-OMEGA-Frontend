import { Router } from "express";
import { db } from "@workspace/db";
import { memoryItemsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { randomUUID } from "crypto";
import { CreateMemoryBody, UpdateMemoryBody } from "@workspace/api-zod";

const router = Router();

router.get("/", async (_req, res) => {
  const items = await db.select().from(memoryItemsTable).orderBy(desc(memoryItemsTable.updated_at));
  res.json(items);
});

router.post("/", async (req, res) => {
  const parsed = CreateMemoryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", code: "INPUT_ERROR" });
    return;
  }

  const [item] = await db.insert(memoryItemsTable).values({
    id: randomUUID(),
    layer: parsed.data.layer,
    title: parsed.data.title,
    content: parsed.data.content,
    authority_level: parsed.data.authority_level ?? 5,
  }).returning();

  res.status(201).json(item);
});

router.patch("/:id", async (req, res) => {
  const { id } = req.params;
  if (!id) { res.status(400).json({ error: "Missing id" }); return; }

  const parsed = UpdateMemoryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", code: "INPUT_ERROR" });
    return;
  }

  const updates: Record<string, unknown> = { updated_at: new Date() };
  if (parsed.data.title !== undefined) updates["title"] = parsed.data.title;
  if (parsed.data.content !== undefined) updates["content"] = parsed.data.content;
  if (parsed.data.authority_level !== undefined) updates["authority_level"] = parsed.data.authority_level;
  if (parsed.data.layer !== undefined) updates["layer"] = parsed.data.layer;

  const [updated] = await db.update(memoryItemsTable).set(updates).where(eq(memoryItemsTable.id, id)).returning();
  if (!updated) { res.status(404).json({ error: "Memory item not found" }); return; }
  res.json(updated);
});

router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  if (!id) { res.status(400).json({ error: "Missing id" }); return; }

  const [deleted] = await db
    .delete(memoryItemsTable)
    .where(eq(memoryItemsTable.id, id))
    .returning({ id: memoryItemsTable.id, layer: memoryItemsTable.layer, title: memoryItemsTable.title });

  if (!deleted) { res.status(404).json({ error: "Memory item not found" }); return; }

  req.log?.warn(
    { event: "MEMORY_DELETED", memory_id: deleted.id, layer: deleted.layer, title: deleted.title },
    `Memory item deleted (layer=${deleted.layer})`,
  );
  res.status(204).end();
});

export default router;
