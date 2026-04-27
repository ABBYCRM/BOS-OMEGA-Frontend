/**
 * Fidelity Lattice Continuity Protocol — Task #68 conversation clusterer.
 *
 * Decides which `conversations.id` a freshly-submitted task should attach
 * to. Three precedence levels:
 *
 *   1. `explicitId` — caller supplied a conversation_id (the sidebar
 *      passes the currently-open thread). Verified for ownership; throws
 *      CONVERSATION_NOT_FOUND on mismatch.
 *   2. `forceNew`   — caller explicitly chose "+ New conversation". A new
 *      row is created with title derived from the first message.
 *   3. Heuristic    — default path. Scores recent (<24h, !archived) open
 *      threads against the new input using Jaccard overlap on tokenized
 *      content + the conversation's stored topic_keywords. The best-
 *      scoring thread above SIMILARITY_THRESHOLD wins; otherwise a new
 *      conversation is created.
 *
 * Architectural constraints from the task spec:
 *   - **No empty conversations**: a conversations row never exists in
 *     the DB without an associated task. To enforce this, planning is
 *     split from committing:
 *       - `planConversationAssignment()` is read-only — it ownership-
 *         checks an explicit id, scores candidates, and returns a
 *         `ConvDecision` (either "existing" with the id to reuse, or
 *         "new" with a pre-generated id + title + keywords).
 *       - `commitConversationDecision()` performs the actual writes,
 *         and is called by `pipeline.saveTask()` *inside the same
 *         transaction* as the task INSERT. If the task insert fails,
 *         the conversation insert rolls back too, so we cannot strand
 *         empty rows even across a downstream pipeline crash.
 *   - User-scoped: candidate threads are filtered by user_id BEFORE any
 *     scoring, so cross-user leakage is impossible.
 *   - Audit emits CONVERSATION_ASSIGNED or CONVERSATION_CREATED so the
 *     audit log explains why a task ended up in a given thread.
 *
 * Embedding-based clustering is explicitly out of scope (the spec calls
 * out keyword v1 only; a future task can swap in embeddings behind the
 * same `planConversationAssignment` interface).
 */

import { db } from "@workspace/db";
import { conversationsTable, tasksTable } from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { auditLog } from "./auditEngine.js";
import {
  RECENT_TASKS_PER_CONV,
  MAX_CONVS_TO_CONSIDER,
  SIMILARITY_THRESHOLD,
  RECENT_WINDOW_MS,
  deriveTitle,
  deriveKeywords,
  scoreCandidates,
} from "./conversationClustererPure.js";

// Pure helpers (tokenize, jaccard, deriveTitle, deriveKeywords, the
// scoring function, and the v1 thresholds) live in
// `conversationClustererPure.ts` so unit tests can import them without
// dragging `@workspace/db` into the bare ESM resolver. Re-exported here
// so existing callers don't have to know about the split.
export {
  tokenize,
  jaccard,
  deriveTitle,
  deriveKeywords,
  scoreCandidates,
  SIMILARITY_THRESHOLD,
  RECENT_WINDOW_MS,
} from "./conversationClustererPure.js";

export interface AssignParams {
  userId: string;
  inputText: string;
  forceNew?: boolean;
  explicitId?: string | null;
  /** Test override for the similarity threshold (default 0.18). */
  similarityThreshold?: number;
  /** Test override for "now" so unit tests can deterministically place
   *  candidates inside / outside the recent window. */
  now?: Date;
}

/**
 * The outcome of {@link planConversationAssignment}. Only describes the
 * intended write — no DB rows have been created yet. `commitConversationDecision`
 * is what actually persists it (atomically with the task INSERT).
 */
export type ConvDecision =
  | {
      kind: "existing";
      conversation_id: string;
      method: "explicit" | "auto_match";
      matched_score?: number;
    }
  | {
      kind: "new";
      conversation_id: string;
      title: string;
      topic_keywords: string[];
      method: "force_new" | "auto_new";
      matched_score?: number;
    };

export class ConversationNotFoundError extends Error {
  readonly code = "CONVERSATION_NOT_FOUND";
  constructor(message = "Conversation not found or not owned by user") {
    super(message);
    this.name = "ConversationNotFoundError";
  }
}

/**
 * In-memory reservation store for `POST /api/conversations` ("manual
 * new chat" UX). The endpoint allocates an id + user-supplied title and
 * stashes them here; nothing is written to the DB until the first
 * task arrives with `conversation_id = <reserved>`. At that point the
 * reservation is consumed, converted to a `ConvDecision { kind: "new",
 *  method: "manual_create" }`, and committed transactionally with the
 * task INSERT. This preserves the "no empty conversations" invariant
 * even on the manual-create path.
 *
 * TTL is 30 minutes. The store is process-local; in a multi-replica
 * deployment a follower could reject a reservation made on the leader.
 * Acceptable for v1 — a clean upgrade path is to back this with Redis.
 */
const RESERVATION_TTL_MS = 30 * 60 * 1000;
interface Reservation {
  id: string;
  userId: string;
  title: string;
  expiresAt: number;
}
const reservations = new Map<string, Reservation>();

function reservationKey(userId: string, id: string): string {
  return `${userId}:${id}`;
}

function sweepExpiredReservations(now: number = Date.now()): void {
  for (const [key, r] of reservations) {
    if (r.expiresAt <= now) reservations.delete(key);
  }
}

/** Reserve a conversation id + title for the user. Returns the row
 *  shape the client expects so the UI can optimistically render the
 *  thread; the row is not persisted until the first task lands. */
export function reserveConversation(userId: string, title: string): {
  id: string;
  user_id: string;
  title: string;
  topic_keywords: string[];
  archived: boolean;
  created_at: Date;
  last_active_at: Date;
  pending: true;
} {
  sweepExpiredReservations();
  const id = randomUUID();
  const now = new Date();
  reservations.set(reservationKey(userId, id), {
    id,
    userId,
    title,
    expiresAt: now.getTime() + RESERVATION_TTL_MS,
  });
  return {
    id,
    user_id: userId,
    title,
    topic_keywords: [],
    archived: false,
    created_at: now,
    last_active_at: now,
    pending: true,
  };
}

/** Look up (and consume) a pending reservation. Returns null if no
 *  matching live reservation exists for this user. Once consumed the
 *  reservation cannot be reused. */
export function consumeReservation(userId: string, id: string): Reservation | null {
  sweepExpiredReservations();
  const key = reservationKey(userId, id);
  const r = reservations.get(key);
  if (!r) return null;
  reservations.delete(key);
  return r;
}

/** Test-only escape hatch: drain the reservation cache between tests. */
export function _clearReservationsForTest(): void {
  reservations.clear();
}

/** Drizzle's `db` and the transaction handle share the same query API
 *  but their types differ (the transaction has no `$client`). Accept
 *  either by widening to the structural intersection of "things that
 *  expose insert/update". */
type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Plan (but do NOT commit) a conversation assignment. Returns a decision
 * the caller can hand to {@link commitConversationDecision} inside its
 * task-insert transaction. The only write this function performs is the
 * ownership check on `explicitId`, which is read-only. New conversation
 * rows are NOT created here — that happens atomically with the task in
 * `commitConversationDecision`, so we never strand empty rows.
 */
export async function planConversationAssignment(p: AssignParams): Promise<ConvDecision> {
  // 1) Explicit id wins. Ownership-check first so a malicious caller
  //    can't pin to someone else's thread by guessing an id.
  if (p.explicitId) {
    const [row] = await db
      .select({ id: conversationsTable.id })
      .from(conversationsTable)
      .where(and(eq(conversationsTable.id, p.explicitId), eq(conversationsTable.user_id, p.userId)))
      .limit(1);
    if (!row) throw new ConversationNotFoundError();
    return { kind: "existing", conversation_id: p.explicitId, method: "explicit" };
  }

  // 2) Force new — the user clicked "+ New conversation".
  if (p.forceNew) {
    return {
      kind: "new",
      conversation_id: randomUUID(),
      title: deriveTitle(p.inputText),
      topic_keywords: deriveKeywords(p.inputText),
      method: "force_new",
    };
  }

  // 3) Heuristic — score recent open threads.
  const cutoff = new Date((p.now ?? new Date()).getTime() - RECENT_WINDOW_MS);
  const candidates = await db
    .select({
      id: conversationsTable.id,
      topic_keywords: conversationsTable.topic_keywords,
    })
    .from(conversationsTable)
    .where(and(
      eq(conversationsTable.user_id, p.userId),
      eq(conversationsTable.archived, false),
      sql`${conversationsTable.last_active_at} >= ${cutoff}`,
    ))
    .orderBy(desc(conversationsTable.last_active_at))
    .limit(MAX_CONVS_TO_CONSIDER);

  // For each candidate, fetch the last N task inputs in one bounded
  // batch. Now that conversation creation is transactional with task
  // insertion, every candidate is guaranteed to have ≥1 task — but we
  // tolerate zero-task rows defensively for robustness against legacy
  // data and concurrent archive flips.
  const enriched = await Promise.all(candidates.map(async (c) => {
    const recents = await db
      .select({ input_text: tasksTable.input_text })
      .from(tasksTable)
      .where(eq(tasksTable.conversation_id, c.id))
      .orderBy(desc(tasksTable.created_at))
      .limit(RECENT_TASKS_PER_CONV);
    return {
      id: c.id,
      topic_keywords: c.topic_keywords ?? [],
      recent_inputs: recents.map((r) => r.input_text),
    };
  }));

  const threshold = p.similarityThreshold ?? SIMILARITY_THRESHOLD;
  const { conversation_id: bestId, score } = scoreCandidates(p.inputText, enriched);

  if (bestId && score >= threshold) {
    return {
      kind: "existing",
      conversation_id: bestId,
      method: "auto_match",
      matched_score: score,
    };
  }

  // No good match — plan a brand new thread.
  return {
    kind: "new",
    conversation_id: randomUUID(),
    title: deriveTitle(p.inputText),
    topic_keywords: deriveKeywords(p.inputText),
    method: "auto_new",
    matched_score: score,
  };
}

/**
 * Commit a planned assignment. MUST be called inside the same DB
 * transaction as the task INSERT so that a failure to persist the task
 * rolls back the conversation row creation too. This is the mechanism
 * that enforces the "no empty conversations" architectural invariant.
 *
 * Side effects (in order):
 *   - For `kind: "new"`: INSERT conversations row.
 *   - For `kind: "existing"`: UPDATE conversations.last_active_at.
 *   - Audit log emit (CONVERSATION_CREATED or CONVERSATION_ASSIGNED).
 *     Audit emit happens inside the same transaction so that, if the
 *     transaction rolls back, the audit row goes with it.
 */
export async function commitConversationDecision(
  decision: ConvDecision,
  userId: string,
  task_id: string,
  now: Date,
  tx: DbOrTx,
): Promise<void> {
  if (decision.kind === "new") {
    await tx.insert(conversationsTable).values({
      id: decision.conversation_id,
      user_id: userId,
      title: decision.title,
      topic_keywords: decision.topic_keywords,
      created_at: now,
      last_active_at: now,
      archived: false,
    });
    await auditLog(
      task_id,
      "CONVERSATION_CREATED",
      `Created conversation ${decision.conversation_id} (${decision.method})`,
      {
        conversation_id: decision.conversation_id,
        user_id: userId,
        method: decision.method,
        ...(decision.matched_score !== undefined ? { best_score: decision.matched_score } : {}),
      },
      // Tx-scoped: if the surrounding task INSERT rolls back, the
      // conversation insert AND its audit row roll back together.
      tx as Parameters<Parameters<typeof db.transaction>[0]>[0],
    );
  } else {
    await tx
      .update(conversationsTable)
      .set({ last_active_at: now })
      .where(eq(conversationsTable.id, decision.conversation_id));
    await auditLog(
      task_id,
      "CONVERSATION_ASSIGNED",
      `Assigned to conversation ${decision.conversation_id} (${decision.method})`,
      {
        conversation_id: decision.conversation_id,
        user_id: userId,
        method: decision.method,
        ...(decision.matched_score !== undefined ? { score: decision.matched_score } : {}),
      },
      tx as Parameters<Parameters<typeof db.transaction>[0]>[0],
    );
  }
}
