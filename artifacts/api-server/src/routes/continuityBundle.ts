/**
 * Task #64 — Cross-AI continuity bundle endpoints.
 *
 *   GET  /api/continuity-bundle?task_id=<uuid>
 *        Build a continuity bundle scoped to a single task. Pulls
 *        canon hash, the persona slot used for that task (from the
 *        TASK_RECEIVED audit row), the user's effective layer
 *        budgets, the user's scratchpad rows (most recent first),
 *        the relevance-ranked continuity items vs the task's input,
 *        and the ONE turn (user input + bos_output.answer).
 *
 *   GET  /api/continuity-bundle?conversation_id=<uuid>
 *        Build a bundle scoped to a whole conversation. Same shape
 *        as task-scoped but `turns` carries the last N tasks from
 *        the conversation (chronological, oldest-first), and the
 *        persona slot is taken from the most recent task that has
 *        one. `?max_turns` (default 10) bounds the turn list.
 *
 *   POST /api/continuity-bundle/preview
 *        Body: { bundle: <text> }. Parses the bundle, recomputes
 *        the hash, diffs against the importer's existing scratchpad
 *        and continuity rows, returns the preview shape from
 *        previewContinuityBundle. Never writes.
 *
 *   POST /api/continuity-bundle/import
 *        Body: { bundle: <text>, mode: "merge" | "replace_thread" }.
 *        Verifies hash (refuses 400 BUNDLE_HASH_MISMATCH on fail),
 *        runs ONE db.transaction that:
 *          - upserts scratchpad rows by id, ALWAYS scoped to
 *            user_id=importer (cross-user ids become inserts under
 *            the new owner, never overwrite the original owner's row).
 *          - upserts continuity rows by id under the importer's
 *            user_id (canon is intentionally NOT touched — canon is
 *            global and authored via the Memory Manager UI).
 *          - creates a "Imported continuity from <source>" conversation
 *            owned by the importer, then inserts the rehydrated turns
 *            as new tasks under that conversation (NEW ids; we never
 *            re-use source ids).
 *        Returns { imported: {...}, conversation_id }.
 *        Audit: CONTINUITY_BUNDLE_IMPORTED with {verified, counts}.
 *
 * All endpoints require auth. Anonymous → 401.
 *
 * Cross-tenant safety:
 *   - The export reads only the calling user's scratchpad / continuity
 *     and only tasks the calling user can see (visibility check on the
 *     parent task / conversation).
 *   - The import never writes user_id=null and never overwrites another
 *     owner's rows (upserts include `WHERE user_id = importer`).
 */

import { Router } from "express";
import { db } from "@workspace/db";
import {
  memoryItemsTable,
  conversationsTable,
  tasksTable,
  auditLogsTable,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { z } from "zod";
import { auditLog } from "../bos/auditEngine.js";
import { getEffectiveBudgets } from "../bos/userBudgets.js";
import {
  getCanonMemory,
  getContinuityMemory,
} from "../bos/memoryEngine.js";
import {
  buildContinuityBundle,
  parseContinuityBundle,
  previewContinuityBundle,
  computeCanonHash,
  summarizeCanon,
  BundleParseError,
  CONTINUITY_BUNDLE_VERSION,
  MAX_BUNDLE_BYTES,
  type BundlePersonaSlot,
  type BundleBudgets,
  type BundleScratchpadItem,
  type BundleContinuityItem,
  type BundleTurn,
  type ContinuityBundlePayload,
  type BundleCanon,
} from "../bos/continuityBundle.js";

const router = Router();

const DEFAULT_MAX_TURNS = 10;
const HARD_MAX_TURNS = 20;

// ---------- helpers ----------

interface CanonContext {
  hash: string;
  summary: string;
  items_count: number;
}

/**
 * Pulls every canon row from memory_items, computes a deterministic
 * hash + a short summary. Reads the full canon list (not the
 * budget-trimmed view) so the hash is stable across requests
 * regardless of the user's per-layer budget overrides — two users on
 * different budgets exporting bundles for the same canon get the same
 * canon hash, which is the whole point of using it as a continuity
 * checkpoint.
 */
async function loadCanonContext(): Promise<CanonContext> {
  const rows = await db
    .select({
      id: memoryItemsTable.id,
      title: memoryItemsTable.title,
      content: memoryItemsTable.content,
    })
    .from(memoryItemsTable)
    .where(eq(memoryItemsTable.layer, "canon"));
  return {
    hash: computeCanonHash(rows),
    summary: summarizeCanon(rows),
    items_count: rows.length,
  };
}

async function loadScratchpadForUser(user_id: string): Promise<BundleScratchpadItem[]> {
  const rows = await db
    .select()
    .from(memoryItemsTable)
    .where(
      and(
        eq(memoryItemsTable.user_id, user_id),
        eq(memoryItemsTable.layer, "scratchpad"),
      ),
    )
    .orderBy(desc(memoryItemsTable.authority_level), desc(memoryItemsTable.updated_at))
    .limit(60);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    content: r.content,
    authority_level: r.authority_level ?? 5,
    source: r.source ?? "manual",
    source_task_id: r.source_task_id ?? null,
    created_at: (r.created_at instanceof Date ? r.created_at : new Date(r.created_at as unknown as string))
      .toISOString(),
  }));
}

async function loadContinuityForUser(
  user_id: string,
  task_input: string,
  budget: number,
): Promise<BundleContinuityItem[]> {
  // Use the same engine the live pipeline uses so the bundle reflects
  // what the model would actually see — relevance-ranked + budget-fit.
  const sel = await getContinuityMemory(task_input, budget, user_id);
  // The engine returns rendered prefixed strings; map back via injected[]
  // which carries id+title. Content is recovered from `rendered` by
  // stripping the `[CONTINUITY:title]` prefix the engine adds.
  const out: BundleContinuityItem[] = [];
  for (let i = 0; i < sel.injected.length; i++) {
    const ref = sel.injected[i];
    const rendered = sel.items[i] ?? "";
    if (!ref) continue;
    // Engine renders as `[CONTINUITY:<title>] <content>`. Strip prefix
    // defensively so a future format change doesn't crash the export.
    const stripped = rendered.replace(/^\[CONTINUITY:[^\]]*]\s*/, "");
    out.push({
      id: ref.id,
      title: ref.title,
      content: stripped,
      authority_level: 5,   // engine doesn't expose per-row authority on the selection
    });
  }
  return out;
}

function bestAssistantAnswer(final_output: string | null): string {
  if (!final_output) return "";
  try {
    const parsed = JSON.parse(final_output);
    if (parsed && typeof parsed === "object" && typeof parsed.answer === "string") {
      return parsed.answer;
    }
  } catch {
    // not JSON — return raw
  }
  return final_output;
}

interface TaskRow {
  id: string;
  input_text: string;
  task_type: string;
  tri_state: string;
  final_status: string;
  final_output: string | null;
  mode: string | null;
  created_at: Date;
  conversation_id: string | null;
  user_id: string | null;
}

function turnFromTask(t: TaskRow): BundleTurn {
  return {
    task_id: t.id,
    created_at: (t.created_at instanceof Date ? t.created_at : new Date(t.created_at as unknown as string))
      .toISOString(),
    user_input: t.input_text,
    assistant_output: bestAssistantAnswer(t.final_output),
    tri_state: t.tri_state,
    task_type: t.task_type,
    mode: t.mode ?? "single",
  };
}

/**
 * Look up the persona slot used for a task by reading the
 * TASK_RECEIVED audit row (the pipeline always writes persona_slot +
 * persona_title there). Resolves the current slot's content from
 * memory_items so the bundle ships the live overlay text — if the
 * user has edited slot A since the task ran, the bundle carries the
 * EDITED content. That's intentional: a continuity bundle is meant to
 * encode "the persona that will run the next turn", not "the exact
 * bytes that ran the prior turn". For "exact bytes" provenance, the
 * Active Persona panel on TaskDetail already provides the audit view.
 */
async function loadPersonaSlotForTask(task_id: string): Promise<BundlePersonaSlot | null> {
  const [row] = await db
    .select()
    .from(auditLogsTable)
    .where(
      and(
        eq(auditLogsTable.task_id, task_id),
        eq(auditLogsTable.event_type, "TASK_RECEIVED"),
      ),
    )
    .limit(1);
  const meta = (row?.metadata && typeof row.metadata === "object")
    ? (row.metadata as Record<string, unknown>)
    : null;
  const slot = meta?.persona_slot;
  if (slot !== "A" && slot !== "B" && slot !== "C") return null;
  // Resolve current slot content
  const slotIdMap: Record<"A"|"B"|"C", string> = {
    A: "persona-slot-a",
    B: "persona-slot-b",
    C: "persona-slot-c",
  };
  const [r] = await db
    .select()
    .from(memoryItemsTable)
    .where(eq(memoryItemsTable.id, slotIdMap[slot]))
    .limit(1);
  if (!r) {
    // Fallback to title from audit metadata if slot row was deleted.
    const title = typeof meta?.persona_title === "string" ? meta.persona_title : `Slot ${slot}`;
    return { slot, title, content: "(persona slot row no longer available)" };
  }
  return { slot, title: r.title, content: r.content };
}

async function loadPersonaSlotForConversation(conversation_id: string, user_id: string): Promise<BundlePersonaSlot | null> {
  const tasks = await db
    .select({ id: tasksTable.id })
    .from(tasksTable)
    .where(and(eq(tasksTable.conversation_id, conversation_id), eq(tasksTable.user_id, user_id)))
    .orderBy(desc(tasksTable.created_at))
    .limit(20);
  for (const t of tasks) {
    const persona = await loadPersonaSlotForTask(t.id);
    if (persona) return persona;
  }
  return null;
}

// ---------- GET /export ----------

const ExportQ = z.object({
  task_id: z.string().uuid().optional(),
  conversation_id: z.string().uuid().optional(),
  max_turns: z.coerce.number().int().positive().max(HARD_MAX_TURNS).optional(),
});

router.get("/", async (req, res) => {
  if (!req.user?.id) {
    res.status(401).json({ error: "Authentication required", code: "UNAUTHENTICATED" });
    return;
  }
  const parsed = ExportQ.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", code: "INPUT_ERROR", detail: parsed.error.issues });
    return;
  }
  if (!parsed.data.task_id && !parsed.data.conversation_id) {
    res.status(400).json({
      error: "Provide ?task_id=<uuid> OR ?conversation_id=<uuid>",
      code: "INPUT_ERROR",
    });
    return;
  }

  const isSuper = req.user.role === "super_admin";
  const userId = req.user.id;
  const max_turns = parsed.data.max_turns ?? DEFAULT_MAX_TURNS;

  let scope: "task" | "conversation";
  let task_id: string | null = null;
  let conversation_id: string | null = null;
  let conversation_title: string | null = null;
  let turns: BundleTurn[] = [];
  let persona_slot: BundlePersonaSlot | null = null;
  let primary_input = "";

  if (parsed.data.task_id) {
    scope = "task";
    task_id = parsed.data.task_id;
    const [t] = await db
      .select()
      .from(tasksTable)
      .where(
        isSuper
          ? eq(tasksTable.id, task_id)
          : and(eq(tasksTable.id, task_id), eq(tasksTable.user_id, userId)),
      )
      .limit(1);
    if (!t) { res.status(404).json({ error: "Task not found", code: "NOT_FOUND" }); return; }
    conversation_id = t.conversation_id ?? null;
    primary_input = t.input_text;
    persona_slot = await loadPersonaSlotForTask(task_id);
    if (conversation_id) {
      // Cross-AI continuation needs surrounding context so the
      // receiving AI sees the recent thread, not a single naked turn.
      // Pull the last `max_turns` tasks from the same conversation in
      // chronological order; the seed task is part of that window by
      // definition. If the seed task is older than the budget allows,
      // we explicitly include it at the end so it cannot be elided.
      const [c] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, conversation_id)).limit(1);
      conversation_title = c?.title ?? null;
      const recentRows = await db
        .select()
        .from(tasksTable)
        .where(eq(tasksTable.conversation_id, conversation_id))
        .orderBy(desc(tasksTable.created_at))
        .limit(max_turns);
      const ordered = recentRows.slice().reverse();
      const haveSeed = ordered.some((r) => r.id === task_id);
      if (!haveSeed) {
        // Seed task fell off the recency window — append it so the
        // receiving AI always sees the turn the user actually clicked
        // Resume on, even if older than the rest of the window.
        ordered.push(t);
      }
      turns = ordered.map((r) => turnFromTask(r as TaskRow));
    } else {
      // Orphan task (no conversation_id). Single-turn export is the
      // best we can do — there is no surrounding thread to include.
      turns = [turnFromTask(t as TaskRow)];
    }
  } else {
    scope = "conversation";
    conversation_id = parsed.data.conversation_id!;
    const [c] = await db
      .select()
      .from(conversationsTable)
      .where(
        isSuper
          ? eq(conversationsTable.id, conversation_id)
          : and(eq(conversationsTable.id, conversation_id), eq(conversationsTable.user_id, userId)),
      )
      .limit(1);
    if (!c) { res.status(404).json({ error: "Conversation not found", code: "NOT_FOUND" }); return; }
    conversation_title = c.title;
    const taskRows = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.conversation_id, conversation_id))
      .orderBy(desc(tasksTable.created_at))
      .limit(max_turns);
    // Reverse so chronological (oldest first) for the receiving AI to read top-to-bottom.
    const ordered = taskRows.slice().reverse();
    turns = ordered.map((t) => turnFromTask(t as TaskRow));
    primary_input = ordered[ordered.length - 1]?.input_text ?? c.title ?? "";
    persona_slot = await loadPersonaSlotForConversation(conversation_id, userId);
  }

  const [canonCtx, budgets, scratchpad] = await Promise.all([
    loadCanonContext(),
    getEffectiveBudgets(userId),
    loadScratchpadForUser(userId),
  ]);
  const continuity = await loadContinuityForUser(userId, primary_input, budgets.continuity);

  const canon: BundleCanon = {
    hash: canonCtx.hash,
    summary: canonCtx.summary,
    items_count: canonCtx.items_count,
  };

  const built = buildContinuityBundle({
    exported_at: new Date().toISOString(),
    source_session_id: randomUUID(),
    scope,
    task_id,
    conversation_id,
    conversation_title,
    canon,
    persona_slot,
    budgets,
    scratchpad,
    continuity,
    turns,
  });

  await auditLog(task_id ?? undefined, "CONTINUITY_BUNDLE_EXPORTED", `Continuity bundle exported (${scope})`, {
    user_id: userId,
    scope,
    task_id,
    conversation_id,
    bytes: built.byte_size,
    scratchpad_count: built.stats.scratchpad_count,
    continuity_count: built.stats.continuity_count,
    turns_count: built.stats.turns_count,
    fidelity_hash: built.hash,
    canon_hash: canon.hash,
  });

  res.json({
    blob: built.blob,
    hash: built.hash,
    byte_size: built.byte_size,
    format_version: CONTINUITY_BUNDLE_VERSION,
    stats: built.stats,
    scope,
    task_id,
    conversation_id,
    conversation_title,
    canon_hash: canon.hash,
  });
});

// ---------- POST /preview ----------

const PreviewBody = z.object({
  bundle: z.string().min(1).max(MAX_BUNDLE_BYTES),
});

router.post("/preview", async (req, res) => {
  if (!req.user?.id) {
    res.status(401).json({ error: "Authentication required", code: "UNAUTHENTICATED" });
    return;
  }
  const parsed = PreviewBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", code: "INPUT_ERROR", detail: parsed.error.issues });
    return;
  }
  let result;
  try {
    result = parseContinuityBundle(parsed.data.bundle);
  } catch (err) {
    if (err instanceof BundleParseError) {
      res.status(400).json({ error: err.message, code: err.code });
      return;
    }
    throw err;
  }

  // Diff against the user's existing memory rows so the UI can show
  // "X items would be overwritten". We restrict the existence check
  // to the importer's own ids — cross-user collisions are impossible
  // because the importer cannot see other users' rows.
  const userId = req.user.id;
  const ownIds = await db
    .select({ id: memoryItemsTable.id, layer: memoryItemsTable.layer })
    .from(memoryItemsTable)
    .where(eq(memoryItemsTable.user_id, userId));
  const existingS = new Set(ownIds.filter((r) => r.layer === "scratchpad").map((r) => r.id));
  const existingC = new Set(ownIds.filter((r) => r.layer === "continuity").map((r) => r.id));

  const localCanon = await loadCanonContext();

  const preview = previewContinuityBundle(result, Buffer.byteLength(parsed.data.bundle, "utf8"), {
    local_canon_hash: localCanon.hash,
    existing_scratchpad_ids: existingS,
    existing_continuity_ids: existingC,
  });
  res.json(preview);
});

// ---------- POST /import ----------

const ImportBody = z.object({
  bundle: z.string().min(1).max(MAX_BUNDLE_BYTES),
  // "merge" is the only mode wired today. A future "replace_thread"
  // mode could wipe-and-rewrite the importer's scratchpad for the
  // bundle's source thread — not implemented because the Memory
  // Manager already exposes per-row delete and the user can do the
  // surgical version manually if needed.
  mode: z.enum(["merge"]).optional(),
  /** When false, allow import of a tampered bundle (audit logs
   *  verified=false). Useful for dev/test only — defaults to true so
   *  the production path always refuses bad hashes. */
  require_hash_ok: z.boolean().optional(),
});

router.post("/import", async (req, res) => {
  if (!req.user?.id) {
    res.status(401).json({ error: "Authentication required", code: "UNAUTHENTICATED" });
    return;
  }
  const parsed = ImportBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", code: "INPUT_ERROR", detail: parsed.error.issues });
    return;
  }
  let result;
  try {
    result = parseContinuityBundle(parsed.data.bundle);
  } catch (err) {
    if (err instanceof BundleParseError) {
      res.status(400).json({ error: err.message, code: err.code });
      return;
    }
    throw err;
  }

  const require_hash_ok = parsed.data.require_hash_ok ?? true;
  if (require_hash_ok && !result.hash_ok) {
    await auditLog(undefined, "CONTINUITY_BUNDLE_IMPORTED", "Continuity bundle import rejected (hash mismatch)", {
      user_id: req.user.id,
      verified: false,
      declared_hash: result.payload.fidelity_hash,
      recomputed_hash: result.recomputed_hash,
    });
    res.status(400).json({
      error: "Continuity bundle hash mismatch — refusing to import.",
      code: "BUNDLE_HASH_MISMATCH",
      declared_hash: result.payload.fidelity_hash,
      recomputed_hash: result.recomputed_hash,
    });
    return;
  }

  // Per-item structural validation. The serializer/parser only verifies
  // top-level shape + fidelity hash; nothing prevents a hash-valid but
  // hand-crafted bundle from carrying nulls or wrong types in the
  // memory/turn rows. Without this guard, the transactional inserts
  // below would surface as 500s on `.slice(...)` calls. Reject early
  // with a structured 400 so the importer can see exactly what failed.
  const itemIssues: string[] = [];
  const isStr = (v: unknown): v is string => typeof v === "string";
  const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  for (let i = 0; i < result.payload.scratchpad.length; i++) {
    const it = result.payload.scratchpad[i] as unknown;
    if (!isObj(it) || !isStr(it.id) || !isStr(it.title) || !isStr(it.content) ||
        typeof it.authority_level !== "number") {
      itemIssues.push(`scratchpad[${i}]: missing/invalid id|title|content|authority_level`);
    }
  }
  for (let i = 0; i < result.payload.continuity.length; i++) {
    const it = result.payload.continuity[i] as unknown;
    if (!isObj(it) || !isStr(it.id) || !isStr(it.title) || !isStr(it.content) ||
        typeof it.authority_level !== "number") {
      itemIssues.push(`continuity[${i}]: missing/invalid id|title|content|authority_level`);
    }
  }
  for (let i = 0; i < result.payload.turns.length; i++) {
    const t = result.payload.turns[i] as unknown;
    // BundleTurn requires task_id + user_input as strings; the rest
    // are stringly-typed in the format and tolerant of empty values
    // ("" assistant_output for HOLD, etc.).
    if (!isObj(t) || !isStr(t.task_id) || !isStr(t.user_input)) {
      itemIssues.push(`turns[${i}]: missing/invalid task_id|user_input`);
    }
  }
  if (itemIssues.length > 0) {
    res.status(400).json({
      error: "Continuity bundle has malformed item rows.",
      code: "BUNDLE_BAD_ITEM_SHAPE",
      issues: itemIssues.slice(0, 20),
    });
    return;
  }

  const userId = req.user.id;
  const payload: ContinuityBundlePayload = result.payload;
  const new_conv_id = randomUUID();
  const new_task_ids: string[] = [];
  // Per-turn audit metadata, accumulated inside the transaction so
  // we can emit one CONTINUITY_BUNDLE_IMPORTED row per rehydrated
  // task AFTER the transaction commits — avoids holding the audit
  // writer inside a long transaction and means a stalled audit
  // queue can't block the user's import.
  const auditRows: Array<{
    new_task_id: string;
    source_task_id: string;
    persona_slot: BundlePersonaSlot | null;
    budgets: BundleBudgets;
    canon_hash: string;
  }> = [];

  // Pre-allocate the new task ids for every turn so we can build a
  // source→fresh map BEFORE we upsert scratchpad rows. Without this
  // remap, imported scratchpad would keep `source_task_id` values
  // pointing at task ids that don't exist in this importer's account
  // (they belong to the source workspace), so the per-task scratchpad
  // panel for the imported thread would render empty even though the
  // pinned/auto-summary rows are present in memory_items. Mapping
  // source_task_id → new task id makes the imported thread show the
  // same scratchpad context the source AI saw. Turns whose
  // source_task_id has no corresponding entry in the bundle's `turns`
  // (e.g. a pin from an older turn that fell off the recency window)
  // are remapped to null so the row still imports but isn't tied to a
  // task that doesn't exist locally.
  const turn_id_map = new Map<string, string>();
  for (const t of payload.turns) {
    const fresh = randomUUID();
    new_task_ids.push(fresh);
    turn_id_map.set(t.task_id, fresh);
  }

  // Run as one transaction so a partial failure never leaves a half-
  // imported thread visible to the user. Memory upserts are idempotent
  // (re-importing the same bundle is a no-op for memory rows) but
  // turns always create a fresh conversation + tasks so the user can
  // see when each rehydration happened.
  await db.transaction(async (tx) => {
    // --- Memory upserts (scratchpad + continuity), scoped to importer.
    for (const it of payload.scratchpad) {
      const remapped_source_task_id = it.source_task_id
        ? (turn_id_map.get(it.source_task_id) ?? null)
        : null;
      await tx
        .insert(memoryItemsTable)
        .values({
          id: it.id,
          user_id: userId,
          layer: "scratchpad",
          title: it.title.slice(0, 200),
          content: it.content.slice(0, 16_000),
          authority_level: Math.min(Math.max(0, it.authority_level | 0), 10),
          source: it.source === "manual_pin" || it.source === "auto_summary" ? it.source : "manual",
          source_task_id: remapped_source_task_id,
        })
        .onConflictDoUpdate({
          target: memoryItemsTable.id,
          // Only overwrite our own rows. If the same id happens to
          // belong to another user (extremely unlikely with uuids but
          // defended), the WHERE clause makes the UPDATE a no-op.
          set: {
            title: it.title.slice(0, 200),
            content: it.content.slice(0, 16_000),
            authority_level: Math.min(Math.max(0, it.authority_level | 0), 10),
            source: it.source === "manual_pin" || it.source === "auto_summary" ? it.source : "manual",
            // Keep the remap on overwrite too — re-importing the same
            // bundle into the same account should converge the row's
            // source_task_id to the latest fresh task id, otherwise a
            // re-import would leave the row pointing at a stale id
            // from the previous import attempt.
            source_task_id: remapped_source_task_id,
            updated_at: new Date(),
          },
          where: eq(memoryItemsTable.user_id, userId),
        });
    }
    for (const it of payload.continuity) {
      await tx
        .insert(memoryItemsTable)
        .values({
          id: it.id,
          user_id: userId,
          layer: "continuity",
          title: it.title.slice(0, 200),
          content: it.content.slice(0, 16_000),
          authority_level: Math.min(Math.max(0, it.authority_level | 0), 10),
          source: "manual",
          source_task_id: null,
        })
        .onConflictDoUpdate({
          target: memoryItemsTable.id,
          set: {
            title: it.title.slice(0, 200),
            content: it.content.slice(0, 16_000),
            authority_level: Math.min(Math.max(0, it.authority_level | 0), 10),
            updated_at: new Date(),
          },
          where: eq(memoryItemsTable.user_id, userId),
        });
    }

    // --- Conversation row — always created fresh. Title preserves the
    //     original thread title when present so the user can find it.
    const baseTitle = payload.conversation_title || (payload.scope === "task" ? "Imported task" : "Imported conversation");
    await tx.insert(conversationsTable).values({
      id: new_conv_id,
      user_id: userId,
      title: `Imported: ${baseTitle}`.slice(0, 200),
      topic_keywords: [],
      archived: false,
    });

    // --- Turns become new tasks. We pre-allocated the new ids above
    //     (so the scratchpad upsert could remap source_task_id), so
    //     here we just look them up from turn_id_map.
    for (const t of payload.turns) {
      const new_id = turn_id_map.get(t.task_id)!;
      // Reconstruct a final_output JSON envelope mimicking the
      // pipeline's bos_output shape so TaskDetail / chat rehydration
      // sees the same field shape it expects.
      const final_output = JSON.stringify({
        state: t.tri_state || "GO",
        task_type: t.task_type || "general",
        answer: t.assistant_output,
        assumptions: [],
        uncertainties: [],
        missing_inputs: [],
        failure_modes: [],
        recommended_next_action: "Continue from rehydrated turn.",
      });
      await tx.insert(tasksTable).values({
        id: new_id,
        user_id: userId,
        conversation_id: new_conv_id,
        input_text: t.user_input,
        task_type: t.task_type || "general",
        tri_state: (t.tri_state === "GO" || t.tri_state === "HOLD" || t.tri_state === "ABORT") ? t.tri_state : "GO",
        mode: t.mode || "single",
        final_status: "COMPLETED",
        final_output,
      });
      // Per-turn audit row so a forensic reviewer can prove WHICH bundle
      // produced WHICH rehydrated task, and reconstruct the persona /
      // budget governance the source bundle declared (the runtime did
      // not actually execute these turns — they were imported — so this
      // is an audit-parity event, not a real TASK_RECEIVED). The
      // metadata mirrors the fields the auditor expects from a normal
      // TASK_RECEIVED so dashboards rendering "what governed this run"
      // do not blow up on null persona / budget fields.
      auditRows.push({
        new_task_id: new_id,
        source_task_id: t.task_id,
        persona_slot: payload.persona_slot,
        budgets: payload.budgets,
        canon_hash: payload.canon.hash,
      });
    }
  });

  // Emit the per-turn audit rows OUTSIDE the transaction so an audit
  // backlog (durable queue) cannot stall the user-visible import. If
  // the audit writer is down the import still succeeds; the backlog
  // catches up later.
  for (const row of auditRows) {
    await auditLog(row.new_task_id, "CONTINUITY_BUNDLE_IMPORTED", `Rehydrated turn from source task ${row.source_task_id}`, {
      user_id: userId,
      verified: result.hash_ok,
      source_session_id: payload.source_session_id,
      source_task_id: row.source_task_id,
      persona_slot: row.persona_slot,
      budgets: row.budgets,
      canon_hash: row.canon_hash,
      kind: "per_turn",
    });
  }

  await auditLog(undefined, "CONTINUITY_BUNDLE_IMPORTED", `Continuity bundle imported into conversation ${new_conv_id}`, {
    user_id: userId,
    verified: result.hash_ok,
    declared_hash: payload.fidelity_hash,
    recomputed_hash: result.recomputed_hash,
    canon_hash: payload.canon.hash,
    counts: {
      scratchpad: payload.scratchpad.length,
      continuity: payload.continuity.length,
      turns: payload.turns.length,
    },
    conversation_id: new_conv_id,
  });

  res.json({
    imported: {
      scratchpad: payload.scratchpad.length,
      continuity: payload.continuity.length,
      turns: payload.turns.length,
    },
    conversation_id: new_conv_id,
    new_task_ids,
    verified: result.hash_ok,
    canon_hash_match: null, // UI compares vs local canon hash itself
  });
});

export default router;
