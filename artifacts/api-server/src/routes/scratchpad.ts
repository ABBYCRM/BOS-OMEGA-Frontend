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
 *                                    source="manual_pin". Body shape per
 *                                    Task #67 contract:
 *                                      { content, source_task_id?, title? }
 *                                    `title` is optional — when absent we
 *                                    derive one from the first line of
 *                                    the content (truncated to 80 chars).
 *   DELETE /api/scratchpad/:id     → owner OR super_admin. The audit row
 *                                    records the bypass when an admin
 *                                    deletes another user's row so the
 *                                    privileged action stays traceable.
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

const PIN_TITLE_MAX = 200;
const PIN_CONTENT_MAX = 8000;
const TITLE_HEAD_MAX = 80;

const PinBody = z.object({
  source_task_id: z.string().min(1).max(200).optional(),
  title: z.string().min(1).max(PIN_TITLE_MAX).optional(),
  content: z.string().min(1).max(PIN_CONTENT_MAX),
});

/**
 * Derive a sensible title when the caller omitted one — first non-empty
 * line of the content, truncated. Mirrors what PinButton used to send
 * client-side; centralising it here lets non-UI clients (curl, scripts,
 * future MCP/agent integrations) call /pin without computing a title.
 */
function deriveTitle(content: string, source_task_id?: string): string {
  const head = (content.split("\n")[0] ?? "").trim();
  if (head) {
    const slim = head.length > TITLE_HEAD_MAX ? head.slice(0, TITLE_HEAD_MAX - 1) + "…" : head;
    return `Pin: ${slim}`;
  }
  return `Pin: task ${(source_task_id ?? "manual").slice(0, 8)}`;
}

router.get("/", async (req, res) => {
  if (!req.user?.id) {
    res.status(401).json({ error: "Authentication required", code: "UNAUTHENTICATED" });
    return;
  }
  // Order by created_at desc so the most recent pin/auto-summary lines up
  // at the top of the Settings card. We expose created_at in the response
  // (it's part of the row) so the UI can show "when did this enter the
  // scratchpad" rather than a possibly-misleading updated_at.
  const items = await db
    .select()
    .from(memoryItemsTable)
    .where(
      and(
        eq(memoryItemsTable.user_id, req.user.id),
        eq(memoryItemsTable.layer, "scratchpad"),
      ),
    )
    .orderBy(desc(memoryItemsTable.created_at));
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

  const title = parsed.data.title ?? deriveTitle(parsed.data.content, parsed.data.source_task_id);
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
      title,
      content: parsed.data.content,
      source: "manual_pin",
      source_task_id: parsed.data.source_task_id ?? null,
    })
    .returning();

  await auditLog(
    parsed.data.source_task_id ?? undefined,
    "SCRATCHPAD_PINNED",
    `User pinned scratchpad entry ${id}`,
    {
      memory_id: id,
      user_id: req.user.id,
      source_task_id: parsed.data.source_task_id ?? null,
      source: "manual_pin",
      title_provided: parsed.data.title !== undefined,
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
  // Owner OR super_admin (per Task #67 contract). We deliberately
  // surface the privileged path explicitly in the audit metadata so a
  // cross-user delete is auditable rather than indistinguishable from a
  // self-delete.
  const is_owner = row.user_id === req.user.id;
  const is_admin_bypass = !is_owner && req.user.role === "super_admin";
  if (!is_owner && !is_admin_bypass) {
    res.status(404).json({ error: "Scratchpad entry not found" });
    return;
  }

  await db.delete(memoryItemsTable).where(eq(memoryItemsTable.id, id));
  await auditLog(
    row.source_task_id ?? undefined,
    "SCRATCHPAD_DELETED",
    `User deleted scratchpad entry ${id}`,
    {
      memory_id: id,
      deleter_user_id: req.user.id,
      owner_user_id: row.user_id,
      title: row.title,
      source: row.source,
      source_task_id: row.source_task_id ?? null,
      admin_bypass: is_admin_bypass,
    },
  );
  res.status(204).end();
});

export default router;
