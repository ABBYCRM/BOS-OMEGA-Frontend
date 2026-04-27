/**
 * Fidelity Lattice Continuity Protocol — Task #68 conversations CRUD.
 *
 *   GET    /api/conversations         → list current user's conversations
 *                                       (super_admin can pass ?owner=* to
 *                                       see every user's threads).
 *                                       Filters: ?archived=true|false (default false),
 *                                       ?q=<text> (matches title or topic_keywords),
 *                                       ?limit, ?offset.
 *   GET    /api/conversations/:id     → conversation row + ordered task list
 *                                       (id, input snippet, tri_state,
 *                                       task_type, final_status, created_at).
 *   PATCH  /api/conversations/:id     → rename / archive / unarchive.
 *
 * Notably **there is no POST /api/conversations**. Conversations are
 * created lazily, transactionally with the first task that lands in
 * them — see `commitConversationDecision` in conversationClusterer.ts.
 * This enforces the architectural invariant that a conversation row
 * never exists in the DB without an associated task. Clients that want
 * to start a fresh thread submit a task with
 * `force_new_conversation: true` instead.
 *
 * All endpoints are user-scoped (super_admin opt-in via ?owner=* on list,
 * unconditional on read/patch — owners and super_admin only). Cross-user
 * 404s are deliberately 404 not 403 so we don't leak that another user's
 * conversation exists.
 */

import { Router } from "express";
import { db } from "@workspace/db";
import { conversationsTable, tasksTable } from "@workspace/db";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { z } from "zod";

const router = Router();

const ListQ = z.object({
  archived: z.enum(["true", "false"]).optional(),
  q: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  /** Super-admin only: ?owner=* returns every user's conversations. */
  owner: z.string().optional(),
});

router.get("/", async (req, res) => {
  if (!req.user?.id) {
    res.status(401).json({ error: "Authentication required", code: "UNAUTHENTICATED" });
    return;
  }
  const parsed = ListQ.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", code: "INPUT_ERROR", detail: parsed.error.issues });
    return;
  }
  const limit = parsed.data.limit ?? 50;
  const offset = parsed.data.offset ?? 0;
  const showAll = parsed.data.owner === "*" && req.user.role === "super_admin";

  const conds = [];
  if (!showAll) conds.push(eq(conversationsTable.user_id, req.user.id));
  // Default archived filter: hide archived rows unless explicitly requested.
  if (parsed.data.archived === "true") {
    conds.push(eq(conversationsTable.archived, true));
  } else {
    conds.push(eq(conversationsTable.archived, false));
  }
  if (parsed.data.q) {
    const pattern = `%${parsed.data.q}%`;
    // Match either the title or any topic_keyword (case-insensitive). The
    // EXISTS subquery on the unnested array keeps the planner happy and
    // avoids ANY()-on-text[] portability gotchas.
    conds.push(
      or(
        ilike(conversationsTable.title, pattern),
        sql`EXISTS (SELECT 1 FROM unnest(${conversationsTable.topic_keywords}) kw WHERE kw ILIKE ${pattern})`,
      )!,
    );
  }
  const where = and(...conds);
  const rows = await db
    .select()
    .from(conversationsTable)
    .where(where)
    .orderBy(desc(conversationsTable.last_active_at))
    .limit(limit)
    .offset(offset);

  res.json({ conversations: rows, limit, offset });
});

router.get("/:id", async (req, res) => {
  if (!req.user?.id) {
    res.status(401).json({ error: "Authentication required", code: "UNAUTHENTICATED" });
    return;
  }
  const { id } = req.params;
  if (!id) { res.status(400).json({ error: "Missing id" }); return; }

  const isSuper = req.user.role === "super_admin";
  const where = isSuper
    ? eq(conversationsTable.id, id)
    : and(eq(conversationsTable.id, id), eq(conversationsTable.user_id, req.user.id));
  const [conv] = await db.select().from(conversationsTable).where(where).limit(1);
  if (!conv) {
    res.status(404).json({ error: "Conversation not found", code: "NOT_FOUND" });
    return;
  }

  const tasks = await db
    .select({
      id: tasksTable.id,
      input_text: tasksTable.input_text,
      tri_state: tasksTable.tri_state,
      task_type: tasksTable.task_type,
      final_status: tasksTable.final_status,
      created_at: tasksTable.created_at,
    })
    .from(tasksTable)
    .where(eq(tasksTable.conversation_id, id))
    .orderBy(tasksTable.created_at);

  res.json({ conversation: conv, tasks });
});

// POST /api/conversations is intentionally NOT exposed — see file
// header for the rationale ("no empty conversations" invariant).
// Clients open a fresh thread by submitting a task with
// `force_new_conversation: true`.

const PatchBody = z
  .object({
    title: z.string().min(1).max(200).optional(),
    archived: z.boolean().optional(),
  })
  .refine((b) => b.title !== undefined || b.archived !== undefined, {
    message: "Provide title or archived",
  });

router.patch("/:id", async (req, res) => {
  if (!req.user?.id) {
    res.status(401).json({ error: "Authentication required", code: "UNAUTHENTICATED" });
    return;
  }
  const { id } = req.params;
  if (!id) { res.status(400).json({ error: "Missing id" }); return; }
  const parsed = PatchBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", code: "INPUT_ERROR", detail: parsed.error.issues });
    return;
  }

  const isSuper = req.user.role === "super_admin";
  const where = isSuper
    ? eq(conversationsTable.id, id)
    : and(eq(conversationsTable.id, id), eq(conversationsTable.user_id, req.user.id));
  const [existing] = await db.select().from(conversationsTable).where(where).limit(1);
  if (!existing) {
    res.status(404).json({ error: "Conversation not found", code: "NOT_FOUND" });
    return;
  }

  const update: Record<string, unknown> = {};
  if (parsed.data.title !== undefined) update.title = parsed.data.title;
  if (parsed.data.archived !== undefined) update.archived = parsed.data.archived;

  const [row] = await db
    .update(conversationsTable)
    .set(update)
    .where(eq(conversationsTable.id, id))
    .returning();
  res.json(row);
});

export default router;
