import { Router } from "express";
import { db } from "@workspace/db";
import { llmModelsTable, llmProvidersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { CreateModelBody, UpdateModelBody } from "@workspace/api-zod";
import { requireRole } from "../lib/security/auth.js";

const router = Router();

router.use(requireRole("admin", "super_admin"));

router.get("/", async (req, res) => {
  const rows = await db
    .select({ model: llmModelsTable, provider: llmProvidersTable })
    .from(llmModelsTable)
    .leftJoin(llmProvidersTable, eq(llmModelsTable.provider_id, llmProvidersTable.id));

  const models = rows.map(({ model, provider }) => ({
    ...model,
    provider_name: provider?.name || "Unknown",
  }));

  res.json(models);
});

router.post("/", async (req, res) => {
  const parsed = CreateModelBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", code: "INPUT_ERROR" });
    return;
  }

  const [model] = await db.insert(llmModelsTable).values({
    id: randomUUID(),
    provider_id: parsed.data.provider_id,
    model_name: parsed.data.model_name,
    capability_tags: parsed.data.capability_tags,
    context_window: parsed.data.context_window ?? 8192,
    cost_input: parsed.data.cost_input ?? 0,
    cost_output: parsed.data.cost_output ?? 0,
    reliability_score: parsed.data.reliability_score ?? 0.9,
    latency_score: parsed.data.latency_score ?? 0.8,
    enabled: true,
  }).returning();

  res.status(201).json(model);
});

router.patch("/:id", async (req, res) => {
  const { id } = req.params;
  if (!id) { res.status(400).json({ error: "Missing id" }); return; }

  const parsed = UpdateModelBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", code: "INPUT_ERROR" });
    return;
  }

  const updates: Record<string, unknown> = {};
  if (parsed.data.capability_tags !== undefined) updates["capability_tags"] = parsed.data.capability_tags;
  if (parsed.data.context_window !== undefined) updates["context_window"] = parsed.data.context_window;
  if (parsed.data.cost_input !== undefined) updates["cost_input"] = parsed.data.cost_input;
  if (parsed.data.cost_output !== undefined) updates["cost_output"] = parsed.data.cost_output;
  if (parsed.data.reliability_score !== undefined) updates["reliability_score"] = parsed.data.reliability_score;
  if (parsed.data.latency_score !== undefined) updates["latency_score"] = parsed.data.latency_score;
  if (parsed.data.enabled !== undefined) updates["enabled"] = parsed.data.enabled;

  const [updated] = await db.update(llmModelsTable).set(updates).where(eq(llmModelsTable.id, id)).returning();
  if (!updated) { res.status(404).json({ error: "Model not found" }); return; }
  res.json(updated);
});

export default router;
