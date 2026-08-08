import { Router, type Request, type Response } from "express";
import { randomUUID } from "crypto";
import { eq, and, desc, like, gte, sql, inArray } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  memoryItemsTable,
  auditLogsTable,
  conversationsTable,
  tasksTable,
} from "@workspace/db";
import { requireApiToken, requireScope, type ApiTokenRequest } from "../middlewares/apiTokenAuth.js";
import { logger } from "../lib/logger.js";
import {
  buildContinuityBundle,
  parseContinuityBundle,
  BundleParseError,
  CONTINUITY_BUNDLE_VERSION,
  computeCanonHash as computeCanonHashLocal,
} from "../bos/continuityBundle.js";
import { auditLog } from "../bos/auditEngine.js";
import { getEffectiveBudgets } from "../bos/userBudgets.js";

const router = Router();

/** All external endpoints are token-auth only. */
router.use(requireApiToken);

// ---------- Memory items ----------

const memoryListQuerySchema = z.object({
  layer: z.enum(["canon", "patch", "continuity", "scratchpad", "logs"]).optional(),
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

/** GET /api/external/memory — list memory items. */
router.get("/memory", requireScope("memory:read"), async (req: Request, res: Response) => {
  const parsed = memoryListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_query", issues: parsed.error.issues });
    return;
  }
  const { layer, q, limit, offset } = parsed.data;
  const r = req as ApiTokenRequest;
  // Super-admins see every row; regular users see their own rows plus
  // any global (user_id IS NULL) rows that predate the user-scoping
  // migration.
  const isSuper = r.apiTokenUser.role === "super_admin";
  const conditions = isSuper
    ? []
    : [sql`(${memoryItemsTable.user_id} = ${r.apiTokenUser.id} OR ${memoryItemsTable.user_id} IS NULL)`];
  if (layer) conditions.push(eq(memoryItemsTable.layer, layer));
  if (q) conditions.push(like(memoryItemsTable.title, `%${q}%`));
  try {
    const rows = await db
      .select()
      .from(memoryItemsTable)
      .where(conditions.length > 0 ? and(...conditions) : sql`TRUE`)
      .orderBy(desc(memoryItemsTable.updated_at))
      .limit(limit)
      .offset(offset);
    res.json({ items: rows, limit, offset });
  } catch (err) {
    logger.error({ err }, "external memory list failed");
    res.status(500).json({ error: "list_failed" });
  }
});

const memoryCreateSchema = z.object({
  layer: z.enum(["canon", "patch", "continuity", "scratchpad", "logs"]),
  title: z.string().min(1).max(500),
  content: z.string().min(1),
  authority_level: z.number().int().min(0).max(10).optional().default(5),
  source: z.enum(["manual", "manual_pin", "auto_summary"]).optional().default("manual"),
  source_task_id: z.string().optional(),
});

/** POST /api/external/memory — create a memory item. */
router.post(
  "/memory",
  requireScope("memory:write", "memory:canon:write", "memory:scratchpad:write", "memory:continuity:write"),
  async (req: Request, res: Response) => {
    const parsed = memoryCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
      return;
    }
    const r = req as ApiTokenRequest;
    // Per-layer scope check
    const layer = parsed.data.layer;
    const requiredScope =
      layer === "canon"
        ? "memory:canon:write"
        : layer === "scratchpad"
          ? "memory:scratchpad:write"
          : layer === "continuity"
            ? "memory:continuity:write"
            : "memory:write";
    if (!r.apiTokenScopes.has(requiredScope as never)) {
      res.status(403).json({ error: "scope_denied", required: [requiredScope] });
      return;
    }
    const id = randomUUID();
    try {
      await db.insert(memoryItemsTable).values({
        id,
        user_id: r.apiTokenUser.id,
        layer,
        title: parsed.data.title,
        content: parsed.data.content,
        authority_level: parsed.data.authority_level,
        source: parsed.data.source,
        source_task_id: parsed.data.source_task_id ?? null,
      });
      const [row] = await db.select().from(memoryItemsTable).where(eq(memoryItemsTable.id, id));
      res.status(201).json(row);
    } catch (err) {
      logger.error({ err }, "external memory create failed");
      res.status(500).json({ error: "create_failed" });
    }
  },
);

const memoryUpdateSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  content: z.string().min(1).optional(),
  authority_level: z.number().int().min(0).max(10).optional(),
});

/** PATCH /api/external/memory/:id — update a memory item. */
router.patch(
  "/memory/:id",
  requireScope("memory:write", "memory:canon:write", "memory:scratchpad:write", "memory:continuity:write"),
  async (req: Request, res: Response) => {
    const parsed = memoryUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
      return;
    }
    const r = req as ApiTokenRequest;
    const id = req.params.id!;
    const [existing] = await db
      .select()
      .from(memoryItemsTable)
      .where(and(eq(memoryItemsTable.id, id), eq(memoryItemsTable.user_id, r.apiTokenUser.id)));
    if (!existing) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const requiredScope =
      existing.layer === "canon"
        ? "memory:canon:write"
        : existing.layer === "scratchpad"
          ? "memory:scratchpad:write"
          : existing.layer === "continuity"
            ? "memory:continuity:write"
            : "memory:write";
    if (!r.apiTokenScopes.has(requiredScope as never)) {
      res.status(403).json({ error: "scope_denied", required: [requiredScope] });
      return;
    }
    try {
      const updates: Partial<typeof memoryItemsTable.$inferInsert> = { updated_at: new Date() };
      if (parsed.data.title !== undefined) updates.title = parsed.data.title;
      if (parsed.data.content !== undefined) updates.content = parsed.data.content;
      if (parsed.data.authority_level !== undefined) updates.authority_level = parsed.data.authority_level;
      await db.update(memoryItemsTable).set(updates).where(eq(memoryItemsTable.id, id));
      const [row] = await db.select().from(memoryItemsTable).where(eq(memoryItemsTable.id, id));
      res.json(row);
    } catch (err) {
      logger.error({ err }, "external memory update failed");
      res.status(500).json({ error: "update_failed" });
    }
  },
);

/** DELETE /api/external/memory/:id — delete a memory item. */
router.delete(
  "/memory/:id",
  requireScope("memory:write", "memory:canon:write", "memory:scratchpad:write", "memory:continuity:write"),
  async (req: Request, res: Response) => {
    const r = req as ApiTokenRequest;
    const id = req.params.id!;
    const [existing] = await db
      .select()
      .from(memoryItemsTable)
      .where(and(eq(memoryItemsTable.id, id), eq(memoryItemsTable.user_id, r.apiTokenUser.id)));
    if (!existing) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const requiredScope =
      existing.layer === "canon"
        ? "memory:canon:write"
        : existing.layer === "scratchpad"
          ? "memory:scratchpad:write"
          : existing.layer === "continuity"
            ? "memory:continuity:write"
            : "memory:write";
    if (!r.apiTokenScopes.has(requiredScope as never)) {
      res.status(403).json({ error: "scope_denied", required: [requiredScope] });
      return;
    }
    try {
      await db.delete(memoryItemsTable).where(eq(memoryItemsTable.id, id));
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, "external memory delete failed");
      res.status(500).json({ error: "delete_failed" });
    }
  },
);

// ---------- Conversations ----------

const convListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

/** GET /api/external/conversations — list the caller's conversations. */
router.get(
  "/conversations",
  requireScope("conversations:read"),
  async (req: Request, res: Response) => {
    const parsed = convListQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const r = req as ApiTokenRequest;
    try {
      const isSuper = r.apiTokenUser.role === "super_admin";
      const where = isSuper
        ? sql`TRUE`
        : sql`(${conversationsTable.user_id} = ${r.apiTokenUser.id} OR ${conversationsTable.user_id} IS NULL)`;
      const rows = await db
        .select()
        .from(conversationsTable)
        .where(where)
        .orderBy(desc(conversationsTable.last_active_at))
        .limit(parsed.data.limit)
        .offset(parsed.data.offset);
      res.json({ conversations: rows, limit: parsed.data.limit, offset: parsed.data.offset });
    } catch (err) {
      logger.error({ err }, "external conversations list failed");
      res.status(500).json({ error: "list_failed" });
    }
  },
);

/** GET /api/external/conversations/:id — get one conversation with messages. */
router.get(
  "/conversations/:id",
  requireScope("conversations:read"),
  async (req: Request, res: Response) => {
    const r = req as ApiTokenRequest;
    const [row] = await db
      .select()
      .from(conversationsTable)
      .where(and(eq(conversationsTable.id, req.params.id!), eq(conversationsTable.user_id, r.apiTokenUser.id)));
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(row);
  },
);

// ---------- Tasks ----------

const tasksListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
  tri_state: z.enum(["GO", "HOLD", "ABORT"]).optional(),
});

/** GET /api/external/tasks — list the caller's tasks. */
router.get("/tasks", requireScope("tasks:read"), async (req: Request, res: Response) => {
  const parsed = tasksListQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_query" });
    return;
  }
  const r = req as ApiTokenRequest;
  const isSuper = r.apiTokenUser.role === "super_admin";
  const conditions = isSuper
    ? []
    : [sql`(${tasksTable.user_id} = ${r.apiTokenUser.id} OR ${tasksTable.user_id} IS NULL)`];
  if (parsed.data.tri_state) conditions.push(eq(tasksTable.tri_state, parsed.data.tri_state));
  try {
    const rows = await db
      .select()
      .from(tasksTable)
      .where(conditions.length > 0 ? and(...conditions) : sql`TRUE`)
      .orderBy(desc(tasksTable.created_at))
      .limit(parsed.data.limit)
      .offset(parsed.data.offset);
    res.json({ tasks: rows, limit: parsed.data.limit, offset: parsed.data.offset });
  } catch (err) {
    logger.error({ err }, "external tasks list failed");
    res.status(500).json({ error: "list_failed" });
  }
});

/** GET /api/external/tasks/:id — get one task with full output. */
router.get("/tasks/:id", requireScope("tasks:read"), async (req: Request, res: Response) => {
  const r = req as ApiTokenRequest;
  const [row] = await db
    .select()
    .from(tasksTable)
    .where(and(eq(tasksTable.id, req.params.id!), eq(tasksTable.user_id, r.apiTokenUser.id)));
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(row);
});

// ---------- Audit log ----------

const auditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
  event_type: z.string().optional(),
  task_id: z.string().optional(),
  since: z.string().optional(),
});

/** GET /api/external/audit — read the caller's audit log. */
router.get("/audit", requireScope("audit:read"), async (req: Request, res: Response) => {
  const parsed = auditQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_query" });
    return;
  }
  const r = req as ApiTokenRequest;
  // The audit_logs table is global (no user_id column on the canonical
  // task audit events — the auth audit is a separate route). Super-
  // admins see every row; regular users see rows for tasks they own
  // (via task_id membership in their tasks) plus rows with no task
  // (e.g. AUTH_LOGIN_SUCCESS).
  try {
    const isSuper = r.apiTokenUser.role === "super_admin";
    let conds = [];
    if (!isSuper) {
      // Find tasks owned by this user (or unscoped) and join audit
      // rows to that set OR audit rows with no task_id (login events).
      const ownedTasks = await db
        .select({ id: tasksTable.id })
        .from(tasksTable)
        .where(
          sql`(${tasksTable.user_id} = ${r.apiTokenUser.id} OR ${tasksTable.user_id} IS NULL)`,
        );
      const ids = ownedTasks.map((t) => t.id);
      if (ids.length === 0) {
        // No owned tasks — fall through to no-task-id rows only.
        conds.push(sql`${auditLogsTable.task_id} IS NULL`);
      } else {
        conds.push(
          sql`(${auditLogsTable.task_id} IN ${ids} OR ${auditLogsTable.task_id} IS NULL)`,
        );
      }
    }
    if (parsed.data.event_type) conds.push(eq(auditLogsTable.event_type, parsed.data.event_type));
    if (parsed.data.task_id) conds.push(eq(auditLogsTable.task_id, parsed.data.task_id));
    if (parsed.data.since) conds.push(gte(auditLogsTable.created_at, new Date(parsed.data.since)));
    const rows = await db
      .select()
      .from(auditLogsTable)
      .where(conds.length > 0 ? and(...conds) : sql`TRUE`)
      .orderBy(desc(auditLogsTable.created_at))
      .limit(parsed.data.limit)
      .offset(parsed.data.offset);
    res.json({ events: rows, limit: parsed.data.limit, offset: parsed.data.offset });
  } catch (err) {
    logger.error({ err }, "external audit list failed");
    res.status(500).json({ error: "list_failed" });
  }
});

// ---------- Continuity bundle ----------

/** GET /api/external/continuity/:scope/:id — export a bundle
 *  (scope = "task" | "conversation"). We reuse the in-app build path
 *  by calling the same logic with the URL params as the query args. */
router.get(
  "/continuity/:scope/:id",
  requireScope("continuity:export"),
  async (req: Request, res: Response) => {
    const r = req as ApiTokenRequest;
    const { scope, id } = req.params;
    if (scope !== "task" && scope !== "conversation") {
      res.status(400).json({ error: "invalid_scope", allowed: ["task", "conversation"] });
      return;
    }
    try {
      let inputPayload: Omit<import("../bos/continuityBundle.js").ContinuityBundlePayload, "fidelity_hash" | "format_version">;
      let scopeTaskId: string | null = null;
      let scopeConversationId: string | null = null;
      let scopeConversationTitle: string | null = null;
      if (scope === "task") {
        const [t] = await db
          .select()
          .from(tasksTable)
          .where(
            r.apiTokenUser.role === "super_admin"
              ? eq(tasksTable.id, id!)
              : and(eq(tasksTable.id, id!), eq(tasksTable.user_id, r.apiTokenUser.id)),
          )
          .limit(1);
        if (!t) {
          res.status(404).json({ error: "not_found" });
          return;
        }
        scopeTaskId = t.id;
        scopeConversationId = t.conversation_id ?? null;
        const { scratchpad } = await loadScratchpadForUser(r.apiTokenUser.id);
        const continuity = await loadContinuityForUser(r.apiTokenUser.id, t.input_text);
        const canon = await loadCanonContext();
        inputPayload = {
          exported_at: new Date().toISOString(),
          source_session_id: r.apiTokenUser.id,
          scope: "task",
          task_id: scopeTaskId,
          conversation_id: scopeConversationId,
          conversation_title: null,
          canon,
          persona_slot: null,
          budgets: await loadBudgetsForUser(r.apiTokenUser.id),
          scratchpad,
          continuity,
          turns: [
            {
              task_id: t.id,
              created_at: t.created_at.toISOString(),
              user_input: t.input_text,
              assistant_output: t.final_output ?? "",
              tri_state: t.tri_state ?? "GO",
              task_type: t.task_type ?? "general",
              mode: t.mode ?? "single",
            },
          ],
        };
      } else {
        const [c] = await db
          .select()
          .from(conversationsTable)
          .where(
            r.apiTokenUser.role === "super_admin"
              ? eq(conversationsTable.id, id!)
              : and(eq(conversationsTable.id, id!), eq(conversationsTable.user_id, r.apiTokenUser.id)),
          )
          .limit(1);
        if (!c) {
          res.status(404).json({ error: "not_found" });
          return;
        }
        scopeConversationId = c.id;
        scopeConversationTitle = c.title;
        const recentRows = await db
          .select()
          .from(tasksTable)
          .where(eq(tasksTable.conversation_id, id!))
          .orderBy(desc(tasksTable.created_at))
          .limit(10);
        const ordered = recentRows.slice().reverse();
        const { scratchpad } = await loadScratchpadForUser(r.apiTokenUser.id);
        const seedInput = ordered[0]?.input_text ?? "";
        const continuity = await loadContinuityForUser(r.apiTokenUser.id, seedInput);
        const canon = await loadCanonContext();
        inputPayload = {
          exported_at: new Date().toISOString(),
          source_session_id: r.apiTokenUser.id,
          scope: "conversation",
          task_id: null,
          conversation_id: scopeConversationId,
          conversation_title: scopeConversationTitle,
          canon,
          persona_slot: null,
          budgets: await loadBudgetsForUser(r.apiTokenUser.id),
          scratchpad,
          continuity,
          turns: ordered.map((r2) => ({
            task_id: r2.id,
            created_at: r2.created_at.toISOString(),
            user_input: r2.input_text,
            assistant_output: r2.final_output ?? "",
            tri_state: r2.tri_state ?? "GO",
            task_type: r2.task_type ?? "general",
            mode: r2.mode ?? "single",
          })),
        };
      }
      const result = buildContinuityBundle(inputPayload);
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.send(result.blob);
    } catch (err) {
      logger.error({ err }, "external continuity export failed");
      res.status(500).json({ error: "export_failed" });
    }
  },
);

const continuityImportBody = z.object({
  bundle: z.string().min(10),
  mode: z.enum(["merge", "replace_thread"]).optional().default("merge"),
});

/** POST /api/external/continuity/import — rehydrate from a bundle. */
router.post(
  "/continuity/import",
  requireScope("continuity:import"),
  async (req: Request, res: Response) => {
    const parsed = continuityImportBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
      return;
    }
    const r = req as ApiTokenRequest;
    try {
      const parsed_bundle = parseContinuityBundle(parsed.data.bundle);
      const result = await performBundleImport(
        parsed_bundle.payload,
        r.apiTokenUser.id,
        parsed.data.mode,
      );
      await auditLog({
        event_type: "CONTINUITY_BUNDLE_IMPORTED",
        task_id: null,
        message: "Imported via /api/external/continuity/import",
        metadata: {
          verified: true,
          source_format: CONTINUITY_BUNDLE_VERSION,
          mode: parsed.data.mode,
          counts: result.counts,
          via: "api_token",
        },
      });
      res.status(201).json({ ...result, conversation_id: result.conversationId });
    } catch (err) {
      if (err instanceof BundleParseError) {
        res.status(400).json({ error: "bundle_parse_failed", reason: err.message });
        return;
      }
      logger.error({ err }, "external continuity import failed");
      res.status(500).json({ error: "import_failed" });
    }
  },
);

// ---------- helpers ----------

async function performBundleImport(
  payload: import("../bos/continuityBundle.js").ContinuityBundlePayload,
  userId: string,
  mode: "merge" | "replace_thread",
): Promise<{
  counts: { canon_referenced: number; scratchpad: number; continuity: number; turns: number };
  conversationId: string;
}> {
  let scratchpadImported = 0;
  for (const sp of payload.scratchpad ?? []) {
    const id = sp.id ?? randomUUID();
    await db
      .insert(memoryItemsTable)
      .values({
        id,
        user_id: userId,
        layer: "scratchpad",
        title: sp.title,
        content: sp.content,
        authority_level: sp.authority_level ?? 5,
        source: (sp.source as "manual" | "manual_pin" | "auto_summary") ?? "manual",
        source_task_id: sp.source_task_id ?? null,
      })
      .onConflictDoUpdate({
        target: memoryItemsTable.id,
        set: { content: sp.content, title: sp.title, updated_at: new Date() },
      });
    scratchpadImported++;
  }
  let continuityImported = 0;
  for (const c of payload.continuity ?? []) {
    const id = c.id ?? randomUUID();
    await db
      .insert(memoryItemsTable)
      .values({
        id,
        user_id: userId,
        layer: "continuity",
        title: c.title,
        content: c.content,
        authority_level: c.authority_level ?? 5,
        source: (c.source as "manual" | "manual_pin" | "auto_summary") ?? "manual",
      })
      .onConflictDoUpdate({
        target: memoryItemsTable.id,
        set: { content: c.content, title: c.title, updated_at: new Date() },
      });
    continuityImported++;
  }
  const conversationId = randomUUID();
  await db.insert(conversationsTable).values({
    id: conversationId,
    user_id: userId,
    title: `Imported continuity (${new Date().toISOString()})`,
    mode: "single",
    last_active_at: new Date(),
  });
  let turnsImported = 0;
  for (const turn of payload.turns ?? []) {
    const taskId = randomUUID();
    await db.insert(tasksTable).values({
      id: taskId,
      user_id: userId,
      input_text: turn.user_input,
      task_type: "general",
      tri_state: "GO",
      final_status: "completed",
      final_output: turn.assistant_answer,
      mode: "single",
      conversation_id: conversationId,
    });
    turnsImported++;
  }
  void mode;
  return {
    counts: {
      canon_referenced: payload.canon ? 1 : 0,
      scratchpad: scratchpadImported,
      continuity: continuityImported,
      turns: turnsImported,
    },
    conversationId,
  };
}

// Reuse the loaders from bos/memoryEngine + bos/userBudgets. We
// redeclare thin wrappers here so we can re-use them from the route
// without poking into private internals.
async function loadScratchpadForUser(user_id: string) {
  const rows = await db
    .select()
    .from(memoryItemsTable)
    .where(and(eq(memoryItemsTable.user_id, user_id), eq(memoryItemsTable.layer, "scratchpad")))
    .orderBy(desc(memoryItemsTable.updated_at))
    .limit(50);
  return {
    scratchpad: rows.map((r) => ({
      id: r.id,
      title: r.title,
      content: r.content,
      authority_level: r.authority_level ?? 5,
      source: (r.source ?? "manual") as "manual" | "manual_pin" | "auto_summary",
      source_task_id: r.source_task_id ?? null,
    })),
  };
}
async function loadContinuityForUser(user_id: string, _query: string) {
  // Pull all the user's continuity rows. The relevance ranking lives
  // in the in-app flow; for the API export we just ship the lot — the
  // receiving AI does its own re-ranking from the bundle contents.
  const rows = await db
    .select()
    .from(memoryItemsTable)
    .where(and(eq(memoryItemsTable.user_id, user_id), eq(memoryItemsTable.layer, "continuity")))
    .orderBy(desc(memoryItemsTable.updated_at))
    .limit(50);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    content: r.content,
    authority_level: r.authority_level ?? 5,
    source: (r.source ?? "manual") as "manual" | "manual_pin" | "auto_summary",
  }));
}
async function loadCanonContext() {
  const rows = await db
    .select()
    .from(memoryItemsTable)
    .where(eq(memoryItemsTable.layer, "canon"))
    .orderBy(desc(memoryItemsTable.authority_level), desc(memoryItemsTable.updated_at))
    .limit(100);
  return {
    hash: computeCanonHashLocal(
      rows.map((r) => ({ id: r.id, title: r.title, content: r.content })),
    ),
    items: rows.map((r) => ({ id: r.id, title: r.title, content: r.content })),
  };
}
async function loadBudgetsForUser(user_id: string) {
  const b = await getEffectiveBudgets(user_id);
  return {
    canon_tokens: b.canon_tokens,
    persona_tokens: b.persona_tokens,
    scratchpad_tokens: b.scratchpad_tokens,
    continuity_tokens: b.continuity_tokens,
    recent_turns: b.recent_turns,
  };
}

// ---------- Meta ----------

/** GET /api/external/me — info about the caller's token + user. */
router.get("/me", (req: Request, res: Response) => {
  const r = req as ApiTokenRequest;
  res.json({
    user: {
      id: r.apiTokenUser.id,
      email: r.apiTokenUser.email,
      role: r.apiTokenUser.role,
    },
    token: {
      id: r.apiToken.id,
      name: r.apiToken.name,
      mask: `bos_${r.apiToken.token_prefix}…`,
      scopes: r.apiToken.scopes,
      expires_at: r.apiToken.expires_at,
      power_shell_only: r.apiToken.power_shell_only,
      last_used_at: r.apiToken.last_used_at,
    },
  });
});

/** GET /api/external/health — token-auth liveness check. */
router.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

export default router;
