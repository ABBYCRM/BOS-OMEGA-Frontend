/**
 * Pure, no-DB helpers for the memory engine. Separated so the unit-test
 * harness can import them without dragging @workspace/db (mirrors the
 * existing finalStateHelpers.ts / consensusMerge.ts pattern).
 *
 * Owns:
 *   - tokensFromText        — same tokenizer used by selectLayer ranking
 *   - relevanceScore        — singular/plural-aware overlap + substring fallback
 *   - approxTokenCount      — ~4-chars-per-token heuristic for budget fit
 *   - buildContextFromMemory — emits all four memory section headers
 */

const APPROX_CHARS_PER_TOKEN = 4;
const STOPWORDS = new Set([
  "the","a","an","and","or","but","of","to","in","on","at","for","with","by",
  "is","are","was","were","be","been","being","do","does","did","have","has",
  "had","i","you","he","she","it","we","they","this","that","these","those",
  "as","if","then","than","so","not","no","yes","what","why","how","when","where",
]);

export function tokensFromText(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
  );
}

/**
 * Expand a token set so trailing-`s` plurals match their singular form
 * (and singulars match their plural) when computing overlap. Done by
 * adding the +s and -s variants to the set itself; the consumer only
 * has to do set membership checks.
 */
function withPluralVariants(tokens: Set<string>): Set<string> {
  const out = new Set(tokens);
  for (const t of tokens) {
    if (t.length >= 4 && t.endsWith("s")) {
      out.add(t.slice(0, -1));
    } else if (t.length >= 3) {
      out.add(t + "s");
    }
  }
  return out;
}

/**
 * Relevance of a memory item to the task input.
 *
 *   1. Token-overlap scoring with singular/plural equivalence in both
 *      directions ("elephant" ↔ "elephants").
 *   2. If overlap is zero, a case-insensitive substring fallback awards
 *      a small positive score so an item whose phrase appears verbatim
 *      inside the query (or vice-versa) becomes eligible for selection.
 *
 * Returns a non-negative score; 0 means "ineligible" to the budget filler.
 */
export function relevanceScore(item_text: string, task_input: string): number {
  const task_tokens = tokensFromText(task_input);
  const item_tokens = tokensFromText(item_text);
  if (task_tokens.size > 0 && item_tokens.size > 0) {
    const item_with_plurals = withPluralVariants(item_tokens);
    let overlap = 0;
    for (const t of withPluralVariants(task_tokens)) {
      if (item_with_plurals.has(t)) overlap += 1;
    }
    if (overlap > 0) return overlap / task_tokens.size;
  }

  // Substring fallback: case-insensitive, single lowercase pass each.
  const task_lc = task_input.toLowerCase();
  const item_lc = item_text.toLowerCase();
  if (task_lc && item_lc) {
    if (item_lc.includes(task_lc) || task_lc.includes(item_lc)) {
      return 0.05;
    }
  }
  return 0;
}

export function approxTokenCount(text: string): number {
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);
}

/**
 * Render the four memory layers into the model-facing context block.
 * Empty arrays are omitted entirely so a sparse memory store does not
 * inject empty section headers. All four parameters are required to
 * prevent silent partial-call regressions.
 */
export function buildContextFromMemory(
  canon: string[],
  continuity: string[],
  patches: string[],
  scratchpad: string[],
): string {
  const parts: string[] = [];
  if (canon.length > 0) parts.push("=== CANON CONTEXT ===\n" + canon.join("\n"));
  if (continuity.length > 0) parts.push("=== CONTINUITY ===\n" + continuity.join("\n"));
  if (patches.length > 0) parts.push("=== PATCHES ===\n" + patches.join("\n"));
  if (scratchpad.length > 0) parts.push("=== SCRATCHPAD ===\n" + scratchpad.join("\n"));
  return parts.join("\n\n");
}
