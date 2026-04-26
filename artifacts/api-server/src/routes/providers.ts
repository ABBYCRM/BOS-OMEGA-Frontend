import { Router } from "express";
import { db } from "@workspace/db";
import { llmProvidersTable, providerHealthTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { CreateProviderBody, UpdateProviderBody } from "@workspace/api-zod";

const router = Router();

router.get("/", async (req, res) => {
  const providers = await db.select().from(llmProvidersTable).orderBy(llmProvidersTable.priority);
  res.json(providers);
});

router.post("/", async (req, res) => {
  const parsed = CreateProviderBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", code: "INPUT_ERROR" });
    return;
  }

  const id = randomUUID();
  const [provider] = await db.insert(llmProvidersTable).values({
    id,
    name: parsed.data.name,
    base_url: parsed.data.base_url || null,
    priority: parsed.data.priority ?? 5,
    api_key_env: parsed.data.api_key_env || null,
    status: "HEALTHY",
    enabled: true,
  }).returning();

  await db.insert(providerHealthTable).values({
    id: `ph_${id}`,
    provider_id: id,
    status: "HEALTHY",
    failure_count: 0,
    schema_failure_count: 0,
  });

  res.status(201).json(provider);
});

router.patch("/:id", async (req, res) => {
  const { id } = req.params;
  if (!id) { res.status(400).json({ error: "Missing id" }); return; }

  const parsed = UpdateProviderBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", code: "INPUT_ERROR" });
    return;
  }

  const updates: Record<string, unknown> = { updated_at: new Date() };
  if (parsed.data.status !== undefined) updates["status"] = parsed.data.status;
  if (parsed.data.enabled !== undefined) updates["enabled"] = parsed.data.enabled;
  if (parsed.data.priority !== undefined) updates["priority"] = parsed.data.priority;
  if (parsed.data.base_url !== undefined) updates["base_url"] = parsed.data.base_url;

  const [updated] = await db.update(llmProvidersTable).set(updates).where(eq(llmProvidersTable.id, id)).returning();
  if (!updated) { res.status(404).json({ error: "Provider not found" }); return; }

  if (parsed.data.status) {
    await db.update(providerHealthTable).set({ status: parsed.data.status }).where(eq(providerHealthTable.provider_id, id));
  }

  res.json(updated);
});

export default router;
