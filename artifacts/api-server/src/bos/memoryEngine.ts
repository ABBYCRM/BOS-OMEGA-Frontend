import { db } from "@workspace/db";
import { memoryItemsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";

/**
 * v1.1 hardened memory layer — per-layer token budgets and explicit
 * relevance ordering so canon never blindly floods the model context.
 *
 * Selection order applied within each layer:
 *   1. layer authority (caller decides which layers to mix)
 *   2. authority_level   (desc)
 *   3. relevance to task (desc, keyword overlap with the task input)
 *   4. recency           (desc, updated_at)
 *   5. token fit         (greedy fill until layer budget exhausted)
 */

export const MEMORY_TOKEN_BUDGETS = {
  canon: 3000,
  patches: 1000,
  continuity: 1500,
  scratchpad: 750,
} as const;

export type MemoryLayer = keyof typeof MEMORY_TOKEN_BUDGETS;

const APPROX_CHARS_PER_TOKEN = 4;
const STOPWORDS = new Set([
  "the","a","an","and","or","but","of","to","in","on","at","for","with","by",
  "is","are","was","were","be","been","being","do","does","did","have","has",
  "had","i","you","he","she","it","we","they","this","that","these","those",
  "as","if","then","than","so","not","no","yes","what","why","how","when","where",
]);

function tokensFromText(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
  );
}

function relevanceScore(item_text: string, task_tokens: Set<string>): number {
  if (task_tokens.size === 0) return 0;
  const item_tokens = tokensFromText(item_text);
  if (item_tokens.size === 0) return 0;
  let overlap = 0;
  for (const t of task_tokens) if (item_tokens.has(t)) overlap += 1;
  return overlap / task_tokens.size;
}

function approxTokenCount(text: string): number {
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);
}

interface RankedItem {
  rendered: string;
  tokens: number;
}

async function selectLayer(
  layer: MemoryLayer,
  task_input: string,
  budget_tokens: number,
  prefix: string,
  initial_pull: number,
): Promise<RankedItem[]> {
  const rows = await db
    .select()
    .from(memoryItemsTable)
    .where(eq(memoryItemsTable.layer, layer))
    .orderBy(desc(memoryItemsTable.authority_level), desc(memoryItemsTable.updated_at))
    .limit(initial_pull);

  const task_tokens = tokensFromText(task_input);
  const annotated = rows.map((r) => {
    const rendered = `[${prefix}:${r.title}] ${r.content}`;
    return {
      r,
      rendered,
      relevance: relevanceScore(`${r.title} ${r.content}`, task_tokens),
      authority: r.authority_level ?? 0,
      updated_at: r.updated_at?.getTime?.() ?? 0,
      tokens: approxTokenCount(rendered),
    };
  });

  // Stable, deterministic ordering: authority → relevance → recency.
  annotated.sort((a, b) => {
    if (b.authority !== a.authority) return b.authority - a.authority;
    if (b.relevance !== a.relevance) return b.relevance - a.relevance;
    return b.updated_at - a.updated_at;
  });

  // Greedy token fit against the per-layer budget.
  const out: RankedItem[] = [];
  let used = 0;
  for (const item of annotated) {
    if (used + item.tokens > budget_tokens) continue;
    out.push({ rendered: item.rendered, tokens: item.tokens });
    used += item.tokens;
  }
  return out;
}

export async function getCanonMemory(task_input = ""): Promise<string[]> {
  const items = await selectLayer("canon", task_input, MEMORY_TOKEN_BUDGETS.canon, "CANON", 50);
  return items.map((i) => i.rendered);
}

export async function getScratchpad(task_input = ""): Promise<string[]> {
  const items = await selectLayer("scratchpad", task_input, MEMORY_TOKEN_BUDGETS.scratchpad, "SCRATCHPAD", 25);
  return items.map((i) => i.rendered);
}

export function buildContextFromMemory(canon: string[], scratchpad: string[]): string {
  if (canon.length === 0 && scratchpad.length === 0) return "";
  const parts: string[] = [];
  if (canon.length > 0) parts.push("=== CANON CONTEXT ===\n" + canon.join("\n"));
  if (scratchpad.length > 0) parts.push("=== SCRATCHPAD ===\n" + scratchpad.join("\n"));
  return parts.join("\n\n");
}
