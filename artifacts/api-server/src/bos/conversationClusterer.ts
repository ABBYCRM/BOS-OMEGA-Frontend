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
 *   - Pure function over tokens + recent thread state — no random
 *     sampling, deterministic given the same DB snapshot.
 *   - User-scoped: candidate threads are filtered by user_id BEFORE any
 *     scoring, so cross-user leakage is impossible.
 *   - Empty conversations are never created proactively; a conversation
 *     only exists once a task is assigned. The manual "+ New
 *     conversation" UI also goes through here on the first task
 *     submission inside the new thread (the dedicated POST
 *     /api/conversations endpoint exists for power users / scripts but
 *     the sidebar uses `force_new_conversation` so empty rows don't
 *     accumulate when a user clicks "New" then navigates away).
 *   - Audit emits CONVERSATION_ASSIGNED or CONVERSATION_CREATED so the
 *     audit log explains why a task ended up in a given thread.
 *
 * Embedding-based clustering is explicitly out of scope (the spec calls
 * out keyword v1 only; a future task can swap in embeddings behind the
 * same `assignConversation` interface).
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
  /** task_id of the new task (for audit attribution). Optional because
   *  unit tests construct AssignParams without a real task row. */
  task_id?: string;
  /** Test override for the similarity threshold (default 0.18). */
  similarityThreshold?: number;
  /** Test override for "now" so unit tests can deterministically place
   *  candidates inside / outside the recent window. */
  now?: Date;
}

export interface AssignResult {
  conversation_id: string;
  created: boolean;
  matched_score?: number;
  method: "explicit" | "force_new" | "auto_match" | "auto_new";
}

export class ConversationNotFoundError extends Error {
  readonly code = "CONVERSATION_NOT_FOUND";
  constructor(message = "Conversation not found or not owned by user") {
    super(message);
    this.name = "ConversationNotFoundError";
  }
}

/**
 * Assign a task to a conversation. Returns `{conversation_id, created,
 * method}` so callers can audit which branch fired. Throws
 * `ConversationNotFoundError` when an explicitId is given that doesn't
 * resolve to a row owned by `userId`.
 */
export async function assignConversation(p: AssignParams): Promise<AssignResult> {
  // 1) Explicit id wins. Ownership-check first so a malicious caller
  //    can't pin to someone else's thread by guessing an id.
  if (p.explicitId) {
    const [row] = await db
      .select({ id: conversationsTable.id })
      .from(conversationsTable)
      .where(and(eq(conversationsTable.id, p.explicitId), eq(conversationsTable.user_id, p.userId)))
      .limit(1);
    if (!row) throw new ConversationNotFoundError();
    const now = p.now ?? new Date();
    await db.update(conversationsTable)
      .set({ last_active_at: now })
      .where(eq(conversationsTable.id, p.explicitId));
    // Audit log even when task_id is unknown — assignConversation runs
    // BEFORE the task row is created in the request handler, so task_id
    // is intentionally undefined. auditLog stores task_id||null, so the
    // CONVERSATION_* events are still queryable for debugging and tests.
    await auditLog(p.task_id, "CONVERSATION_ASSIGNED",
      `Assigned to conversation ${p.explicitId} (explicit)`,
      { conversation_id: p.explicitId, user_id: p.userId, method: "explicit" },
    );
    return { conversation_id: p.explicitId, created: false, method: "explicit" };
  }

  // 2) Force new — the user clicked "+ New conversation".
  if (p.forceNew) {
    const id = await createConversationRow(p.userId, p.inputText, p.now);
    await auditLog(p.task_id, "CONVERSATION_CREATED",
      `Created conversation ${id} (force_new)`,
      { conversation_id: id, user_id: p.userId, method: "force_new" },
    );
    return { conversation_id: id, created: true, method: "force_new" };
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
  // batch. We deliberately don't JOIN — a candidate can legitimately
  // have zero tasks if a prior task assignment failed mid-write (the
  // INSERT of the conversations row commits before the task row in
  // some race orderings). Such empty rows still get scored against
  // their topic_keywords seed.
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
    const now = p.now ?? new Date();
    await db.update(conversationsTable)
      .set({ last_active_at: now })
      .where(eq(conversationsTable.id, bestId));
    await auditLog(p.task_id, "CONVERSATION_ASSIGNED",
      `Assigned to conversation ${bestId} (auto, jaccard=${score.toFixed(3)})`,
      { conversation_id: bestId, user_id: p.userId, method: "auto_match", score, threshold },
    );
    return { conversation_id: bestId, created: false, matched_score: score, method: "auto_match" };
  }

  // 4) No good match — open a new thread.
  const id = await createConversationRow(p.userId, p.inputText, p.now);
  await auditLog(p.task_id, "CONVERSATION_CREATED",
    `Created conversation ${id} (no match above threshold)`,
    { conversation_id: id, user_id: p.userId, method: "auto_new", best_score: score, threshold },
  );
  return { conversation_id: id, created: true, matched_score: score, method: "auto_new" };
}

async function createConversationRow(userId: string, firstInput: string, now?: Date): Promise<string> {
  const id = randomUUID();
  const ts = now ?? new Date();
  await db.insert(conversationsTable).values({
    id,
    user_id: userId,
    title: deriveTitle(firstInput),
    topic_keywords: deriveKeywords(firstInput),
    created_at: ts,
    last_active_at: ts,
    archived: false,
  });
  return id;
}
