/**
 * BOP.PERSONA_SLOTS.v1 — read + edit the three persona overlay slots A/B/C.
 *
 * These rows live in `memory_items` with layer="persona" and deterministic
 * ids `persona_slot_a/b/c`. The endpoint exposes a small, slot-centric API
 * over the underlying memory table so the frontend doesn't need to know
 * the internal id convention.
 *
 *  GET  /api/personas         → [{slot, id, title, content, ...}, ...] in slot order
 *  PATCH /api/personas/:slot  → updates title and/or content of that slot
 */

import { Router } from "express";
import { db, memoryItemsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { PERSONA_SLOTS, personaSlotId, type PersonaSlot } from "../bos/personaCanonSeed.js";
import { requireRole } from "../lib/security/auth.js";

const router = Router();

// PATCH-protection: any authenticated user may READ the slot list (so the
// persona buttons render their current labels for everyone), but only an
// admin or super_admin may rewrite a slot — these rows are system-owned
// (user_id=null) and apply to every task across the tenant. We mount the
// role gate at the per-route level rather than router-wide so that GET
// stays open. Mirrors the pattern used by /api/users → requireRole.

const PatchBody = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  content: z.string().trim().min(1).max(20_000).optional(),
}).refine((v) => v.title !== undefined || v.content !== undefined, {
  message: "At least one of title or content must be provided",
});

const slotParam = (raw: unknown): PersonaSlot | null => {
  if (typeof raw !== "string") return null;
  const upper = raw.toUpperCase() as PersonaSlot;
  return (PERSONA_SLOTS as readonly string[]).includes(upper) ? upper : null;
};

router.get("/", async (_req, res) => {
  const ids = PERSONA_SLOTS.map(personaSlotId);
  const rows = await db
    .select()
    .from(memoryItemsTable)
    .where(eq(memoryItemsTable.layer, "persona"));

  const byId = new Map(rows.map((r) => [r.id, r]));
  const result = PERSONA_SLOTS.map((slot) => {
    const row = byId.get(personaSlotId(slot));
    if (!row) return { slot, id: null, title: null, content: null, authority_level: null, updated_at: null };
    return {
      slot,
      id: row.id,
      title: row.title,
      content: row.content,
      authority_level: row.authority_level,
      updated_at: row.updated_at,
    };
  });
  void ids;
  res.json(result);
});

router.patch("/:slot", requireRole("admin", "super_admin"), async (req, res) => {
  const slot = slotParam(req.params.slot);
  if (!slot) {
    res.status(400).json({ error: "Slot must be A, B, or C", code: "INPUT_ERROR" });
    return;
  }
  const parsed = PatchBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", code: "INPUT_ERROR", issues: parsed.error.issues });
    return;
  }

  const id = personaSlotId(slot);
  const updates: Record<string, unknown> = { updated_at: new Date() };
  if (parsed.data.title !== undefined) updates["title"] = parsed.data.title;
  if (parsed.data.content !== undefined) updates["content"] = parsed.data.content;

  const [updated] = await db
    .update(memoryItemsTable)
    .set(updates)
    .where(eq(memoryItemsTable.id, id))
    .returning();

  if (!updated) {
    res.status(404).json({ error: `Persona slot ${slot} not found (was the seed run?)`, code: "NOT_FOUND" });
    return;
  }

  req.log?.info({ event: "PERSONA_SLOT_UPDATED", slot, id }, `Persona slot ${slot} updated`);
  res.json({
    slot,
    id: updated.id,
    title: updated.title,
    content: updated.content,
    authority_level: updated.authority_level,
    updated_at: updated.updated_at,
  });
});

export default router;
