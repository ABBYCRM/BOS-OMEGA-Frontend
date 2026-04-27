/**
 * Task #67 — Lattice continuity scratchpad CRUD endpoints.
 *
 *   GET  /api/scratchpad           → list the caller's scratchpad rows.
 *                                    super_admin sees nothing extra here:
 *                                    scratchpad is per-user by design and
 *                                    leaking another user's pinned text
 *                                    would be a privacy regression.
 *   POST /api/scratchpad/pin       → manually pin an assistant message
 *                                    into the scratchpad layer with
 *                                    source="manual_pin".
 *   DELETE /api/scratchpad/:id     → remove a scratchpad row owned by
 *                                    the caller.
 *
 * The list/create endpoints intentionally don't go through the wider
 * /api/memory router (which already handles ALL layers) because:
 *   - The Settings panel only needs a layer-filtered, user-scoped view.
 *   - The Pin button writes a specific source value the generic memory
 *     POST doesn't accept.
 *   - Audit events differ (SCRATCHPAD_PINNED vs MEMORY_*).
 */

import { Router } from "express";
import { db, memoryItemsTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { z } from "zod";
import { auditLog } from "../bos/auditEngine.js";

const router = Router();

const PinBody = z.object({
  task_id: z.string().min(1).max(200).optional(),
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(8000),
});

router.get("/", async (req, res) => {
  if (!req.user?.id) {
    res.status(401).json({ error: "Authentication required", code: "UNAUTHENTICATED" });
    return;
  }
  const items = await db
    .select()
    .from(memoryItemsTable)
    .where(
      and(
        eq(memoryItemsTable.user_id, req.user.id),
        eq(memoryItemsTable.layer, "scratchpad"),
      ),
    )
    .orderBy(desc(memoryItemsTable.updated_at));
  res.json(items);
});

router.post("/pin", async (req, res) => {
  if (!req.user?.id) {
    res.status(401).json({ error: "Authentication required", code: "UNAUTHENTICATED" });
    return;
  }
  const parsed = PinBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid pin request",
      code: "INPUT_ERROR",
      detail: parsed.error.issues,
    });
    return;
  }

  const id = randomUUID();
  const [row] = await db
    .insert(memoryItemsTable)
    .values({
      id,
      user_id: req.user.id,
      layer: "scratchpad",
      // authority_level=5 by convention: pins are user-asserted facts so
      // they sit above the auto_summary writer (3) and at the same tier
      // as freeform manual notes created via /api/memory.
      authority_level: 5,
      title: parsed.data.title,
      content: parsed.data.content,
      source: "manual_pin",
    })
    .returning();

  await auditLog(
    parsed.data.task_id ?? undefined,
    "SCRATCHPAD_PINNED",
    `User pinned scratchpad entry ${id}`,
    {
      memory_id: id,
      user_id: req.user.id,
      task_id: parsed.data.task_id ?? null,
      source: "manual_pin",
    },
  );

  res.status(201).json(row);
});

router.delete("/:id", async (req, res) => {
  if (!req.user?.id) {
    res.status(401).json({ error: "Authentication required", code: "UNAUTHENTICATED" });
    return;
  }
  const { id } = req.params;
  if (!id) {
    res.status(400).json({ error: "Missing id" });
    return;
  }

  const [row] = await db
    .select()
    .from(memoryItemsTable)
    .where(eq(memoryItemsTable.id, id))
    .limit(1);

  // 404 (not 403) for cross-user / wrong-layer access so we don't leak
  // the existence of another user's row.
  if (!row || row.layer !== "scratchpad") {
    res.status(404).json({ error: "Scratchpad entry not found" });
    return;
  }
  // Strict owner-only: scratchpad is a personal continuity surface, not a
  // shared admin resource. We deliberately do NOT grant super_admin a
  // bypass here (mirrors the per-user privacy posture documented at the
  // top of this module). If an operational break-glass is ever needed it
  // should be a separate, explicitly-audited admin endpoint.
  if (row.user_id !== req.user.id) {
    res.status(404).json({ error: "Scratchpad entry not found" });
    return;
  }

  await db.delete(memoryItemsTable).where(eq(memoryItemsTable.id, id));
  await auditLog(
    undefined,
    "SCRATCHPAD_DELETED",
    `User deleted scratchpad entry ${id}`,
    {
      memory_id: id,
      user_id: req.user.id,
      title: row.title,
      source: row.source,
    },
  );
  res.status(204).end();
});

export default router;
