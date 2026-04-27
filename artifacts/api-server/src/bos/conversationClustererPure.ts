/**
 * Fidelity Lattice Continuity Protocol — Task #68 pure clustering helpers.
 *
 * The DB-free portion of the conversation clusterer: tokenisation,
 * Jaccard, title/keywords derivation, and the `scoreCandidates` scoring
 * function. Lifted out of `conversationClusterer.ts` so the unit test
 * suite can import them via Node's bare `--experimental-strip-types`
 * runner without dragging in `@workspace/db` (which uses a directory
 * import that the bare ESM resolver rejects).
 *
 * `conversationClusterer.ts` re-exports everything here so existing
 * callers don't have to know about the split.
 */

// English stopwords + a few BOS-OMEGA-specific filler tokens. Kept small
// on purpose — the goal is to remove noise that would inflate Jaccard
// without removing genuinely topical words. We do NOT lemmatise / stem
// because:
//   - tasks here are short prompts where stem collisions
//     ("review/reviews/reviewing") are valuable signal,
//   - lemmatisation would add a JS dependency for marginal gain.
const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "any",
  "with", "this", "that", "from", "have", "has", "had", "was", "were",
  "what", "when", "where", "why", "how", "who", "your", "into", "out",
  "off", "about", "would", "could", "should", "shall", "will", "may",
  "might", "must", "been", "being", "they", "them", "their", "there",
  "then", "than", "such", "some", "more", "most", "much", "many", "few",
  "very", "also", "just", "like", "make", "made", "use", "used", "using",
  "get", "got", "still", "yet", "now", "ago", "again", "really", "okay",
  "ok", "yeah", "yes", "please", "thanks", "thank", "hello", "hi", "hey",
  "give", "tell", "show", "let", "let's", "lets", "want", "need",
  "going", "goes", "doing", "does", "did", "done", "say", "said", "saw",
  "see", "seen", "look", "looking", "feel", "feels", "feeling",
  "should",
]);

export const SIMILARITY_THRESHOLD = 0.18;
export const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const RECENT_TASKS_PER_CONV = 3;
export const MAX_CONVS_TO_CONSIDER = 10;
export const TITLE_MAX = 60;
export const KEYWORDS_MAX = 10;

/** Lowercase, split on non-alphanumerics, drop short / stopword tokens. */
export function tokenize(input: string): Set<string> {
  if (!input) return new Set();
  const out = new Set<string>();
  for (const t of input.toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length >= 3 && !STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

/** Jaccard similarity over two token sets. 0 when either side is empty. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** First 60 chars of the first non-blank line, ellipsised when truncated. */
export function deriveTitle(text: string): string {
  const trimmed = (text ?? "").trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) return "Untitled conversation";
  if (trimmed.length <= TITLE_MAX) return trimmed;
  return trimmed.slice(0, TITLE_MAX - 1) + "…";
}

/** Up-to-10 significant tokens from the first message — used as the
 *  conversation's seed `topic_keywords`. The clustering writer will
 *  augment these naturally over time as more tasks join and `last_active_at`
 *  bumps; for v1 we keep the keywords frozen at the conversation's first
 *  message so behaviour stays predictable. */
export function deriveKeywords(text: string, max = KEYWORDS_MAX): string[] {
  return Array.from(tokenize(text)).slice(0, max);
}

/**
 * Pure scoring function exposed for tests. Given the new input + a list of
 * candidate conversations (each with their last-N task texts), returns the
 * best `{conversation_id, score}` pair. No DB calls. Ties broken by
 * candidate order (first wins) so the clusterer is fully deterministic
 * given the same DB snapshot.
 */
export function scoreCandidates(
  inputText: string,
  candidates: Array<{ id: string; topic_keywords: string[]; recent_inputs: string[] }>,
): { conversation_id: string | null; score: number } {
  const inputTokens = tokenize(inputText);
  let bestId: string | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    let s = 0;
    for (const t of c.recent_inputs) {
      const j = jaccard(inputTokens, tokenize(t));
      if (j > s) s = j;
    }
    if (c.topic_keywords?.length) {
      const j = jaccard(inputTokens, new Set(c.topic_keywords));
      if (j > s) s = j;
    }
    if (s > bestScore) {
      bestScore = s;
      bestId = c.id;
    }
  }
  return { conversation_id: bestId, score: bestScore };
}
