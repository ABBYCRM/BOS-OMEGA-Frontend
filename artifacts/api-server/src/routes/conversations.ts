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
 *   POST   /api/conversations         → manual create with { title }. Creates
 *                                       an empty conversation row owned by
 *                                       the current user. Subsequent task
 *                                       submissions can target it explicitly
 *                                       via { conversation_id: <id> }.
 *   PATCH  /api/conversations/:id     → rename / archive / unarchive.
 *
 * Auto-clustering note: the assignConversation path (POST /api/tasks
 * without an explicit conversation_id) goes through
 * planConversationAssignment + commitConversationDecision so the
 * conversation row is created TRANSACTIONALLY with the first task —
 * a pipeline failure cannot strand an auto-created empty row. Manual
 * POST below intentionally creates an empty row because the user
 * explicitly asked for one (matches the "New chat" UX of ChatGPT/etc.).
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
import { reserveConversation } from "../bos/conversationClusterer.js";

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

  // Task #64 — include `final_output` so the console can rehydrate
  // the assistant's prior answer when the user resumes this thread.
  // Without this field MessageList shows blank assistant bubbles for
  // every restored turn, which breaks "resumable old conversations
  // with full-fidelity prior turns".
  const tasks = await db
    .select({
      id: tasksTable.id,
      input_text: tasksTable.input_text,
      tri_state: tasksTable.tri_state,
      task_type: tasksTable.task_type,
      final_status: tasksTable.final_status,
      final_output: tasksTable.final_output,
      created_at: tasksTable.created_at,
    })
    .from(tasksTable)
    .where(eq(tasksTable.conversation_id, id))
    .orderBy(tasksTable.created_at);

  res.json({ conversation: conv, tasks });
});

const CreateBody = z.object({
  title: z.string().min(1).max(200),
});

/**
 * POST /api/conversations — manual "New chat" reservation.
 *
 * Returns a freshly-allocated conversation id + title shape so the
 * client can immediately render the new thread, BUT does NOT persist
 * the row to the DB. The reservation is materialized atomically with
 * the FIRST task that targets it (the user submits a message with
 * `conversation_id = <reserved-id>`). This preserves the
 * "no empty conversations" invariant — no orphan rows accumulate
 * from users clicking "+ New chat" without sending a message.
 *
 * The reservation has a 30-minute TTL. After expiry, a task that
 * still targets the reserved id will 404. The response is shaped
 * like a real conversation row (with an extra `pending: true` flag)
 * so the optimistic UI doesn't have to special-case it.
 */
router.post("/", async (req, res) => {
  if (!req.user?.id) {
    res.status(401).json({ error: "Authentication required", code: "UNAUTHENTICATED" });
    return;
  }
  const parsed = CreateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", code: "INPUT_ERROR", detail: parsed.error.issues });
    return;
  }
  const reserved = reserveConversation(req.user.id, parsed.data.title);
  res.status(201).json(reserved);
});

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
