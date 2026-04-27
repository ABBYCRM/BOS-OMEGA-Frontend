import { Router } from "express";
import { db } from "@workspace/db";
import { memoryItemsTable } from "@workspace/db";
import { eq, desc, or, isNull } from "drizzle-orm";
import { randomUUID } from "crypto";
import { CreateMemoryBody, UpdateMemoryBody } from "@workspace/api-zod";
import {
  DEFAULT_BUDGETS,
  MIN_PER_LAYER,
  MIN_CANON_BUDGET,
  MAX_PER_LAYER,
  MAX_TOTAL,
  getEffectiveBudgets,
  getUserBudgetsRowOrNull,
  resetUserBudgets,
  setUserBudgets,
  validateBudgets,
} from "../bos/userBudgets.js";

// Per-layer minimums exposed to the client. Most layers floor at zero so
// the user can disable them; canon has a hard floor so a misconfiguration
// can't brick task execution (see MIN_CANON_BUDGET in userBudgets.ts).
const PER_LAYER_MIN = {
  canon: MIN_CANON_BUDGET,
  continuity: MIN_PER_LAYER,
  patches: MIN_PER_LAYER,
  scratchpad: MIN_PER_LAYER,
} as const;

function budgetLimitsPayload() {
  return {
    min_per_layer: MIN_PER_LAYER,
    max_per_layer: MAX_PER_LAYER,
    max_total: MAX_TOTAL,
    per_layer_min: PER_LAYER_MIN,
  };
}

const router = Router();

// Task #59: per-user memory budget overrides.
//
// GET  /api/memory/budgets            → current user's effective budgets +
//                                       defaults + min/max envelope.
// PUT  /api/memory/budgets            → upsert per-layer budgets (validates
//                                       MIN/MAX_PER_LAYER and MAX_TOTAL).
// DELETE /api/memory/budgets          → drop the row, returning to engine
//                                       defaults.
//
// All three are per-user (req.user.id). Anonymous requests get 401 — these
// endpoints have no super_admin "view another user's budgets" mode by
// design; the budget is a personal preference, not a shared admin setting.

router.get("/budgets", async (req, res) => {
  if (!req.user?.id) {
    res.status(401).json({ error: "Authentication required", code: "UNAUTHENTICATED" });
    return;
  }
  // `has_override` reflects whether a row exists at all (the user has
  // chosen non-default values at least once). `budgets` is the value the
  // *pipeline* would actually use — i.e. the clamped runtime view — so
  // the UI never displays a number the orchestrator wouldn't honor.
  const stored = await getUserBudgetsRowOrNull(req.user.id);
  const effective = await getEffectiveBudgets(req.user.id);
  res.json({
    budgets: effective,
    defaults: DEFAULT_BUDGETS,
    has_override: stored !== null,
    limits: budgetLimitsPayload(),
  });
});

router.put("/budgets", async (req, res) => {
  if (!req.user?.id) {
    res.status(401).json({ error: "Authentication required", code: "UNAUTHENTICATED" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const validated = validateBudgets({
    canon: body.canon,
    continuity: body.continuity,
    patches: body.patches,
    scratchpad: body.scratchpad,
  });
  if (!validated.ok) {
    res.status(400).json({
      error: "Invalid budget values",
      code: "INPUT_ERROR",
      detail: validated.error,
      limits: budgetLimitsPayload(),
    });
    return;
  }
  const saved = await setUserBudgets(req.user.id, validated.values);
  res.json({
    budgets: saved,
    defaults: DEFAULT_BUDGETS,
    has_override: true,
    limits: budgetLimitsPayload(),
  });
});

router.delete("/budgets", async (req, res) => {
  if (!req.user?.id) {
    res.status(401).json({ error: "Authentication required", code: "UNAUTHENTICATED" });
    return;
  }
  await resetUserBudgets(req.user.id);
  // Echo back the engine defaults so the UI can update without a follow-up
  // GET. The shape matches GET /budgets so the same query cache key works.
  const effective = await getEffectiveBudgets(req.user.id);
  res.json({
    budgets: effective,
    defaults: DEFAULT_BUDGETS,
    has_override: false,
    limits: budgetLimitsPayload(),
  });
});

// Memory visibility mirrors task visibility: super_admin sees the whole
// memory store; non-super users see their own items plus legacy untagged
// rows from before user_id existed.
function memoryVisibility(req: { user?: { id: string; role: string } }) {
  if (req.user?.role === "super_admin") return undefined;
  const uid = req.user?.id ?? "";
  return or(eq(memoryItemsTable.user_id, uid), isNull(memoryItemsTable.user_id));
}

router.get("/", async (req, res) => {
  const where = memoryVisibility(req);
  const items = where
    ? await db.select().from(memoryItemsTable).where(where).orderBy(desc(memoryItemsTable.updated_at))
    : await db.select().from(memoryItemsTable).orderBy(desc(memoryItemsTable.updated_at));
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
    user_id: req.user?.id ?? null,
  }).returning();

  res.status(201).json(item);
});

// Authorization helper for object-by-id mutations on memory items.
// Returns null + 404 (treat unauthorized as not-found to avoid leaking
// existence) when the requesting user can't see the item.
async function loadOwnedMemory(req: { user?: { id: string; role: string } }, id: string) {
  const [row] = await db.select().from(memoryItemsTable).where(eq(memoryItemsTable.id, id)).limit(1);
  if (!row) return null;
  if (req.user?.role === "super_admin") return row;
  const uid = req.user?.id ?? "";
  if (row.user_id === uid || row.user_id === null) return row;
  return null;
}

router.patch("/:id", async (req, res) => {
  const { id } = req.params;
  if (!id) { res.status(400).json({ error: "Missing id" }); return; }

  const parsed = UpdateMemoryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", code: "INPUT_ERROR" });
    return;
  }

  const owned = await loadOwnedMemory(req, id);
  if (!owned) { res.status(404).json({ error: "Memory item not found" }); return; }

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

  const owned = await loadOwnedMemory(req, id);
  if (!owned) { res.status(404).json({ error: "Memory item not found" }); return; }

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
