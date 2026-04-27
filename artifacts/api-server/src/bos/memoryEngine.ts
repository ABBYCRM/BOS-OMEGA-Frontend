import { db } from "@workspace/db";
import { memoryItemsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import {
  approxTokenCount,
  buildContextFromMemory as buildContextFromMemoryHelper,
  relevanceScore,
  tokensFromText,
} from "./memoryHelpers.js";

// Re-export the pure helpers so existing call sites that import from
// memoryEngine keep working, and so unit tests that need to stay no-DB
// can import them from memoryHelpers.ts directly.
export { buildContextFromMemoryHelper as buildContextFromMemory };
export { relevanceScore, tokensFromText, approxTokenCount } from "./memoryHelpers.js";

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

  const annotated = rows.map((r) => {
    const rendered = `[${prefix}:${r.title}] ${r.content}`;
    return {
      r,
      rendered,
      relevance: relevanceScore(`${r.title} ${r.content}`, task_input),
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

export async function getContinuityMemory(task_input = ""): Promise<string[]> {
  const items = await selectLayer("continuity", task_input, MEMORY_TOKEN_BUDGETS.continuity, "CONTINUITY", 50);
  return items.map((i) => i.rendered);
}

export async function getPatchesMemory(task_input = ""): Promise<string[]> {
  const items = await selectLayer("patches", task_input, MEMORY_TOKEN_BUDGETS.patches, "PATCHES", 50);
  return items.map((i) => i.rendered);
}

export async function getScratchpad(task_input = ""): Promise<string[]> {
  const items = await selectLayer("scratchpad", task_input, MEMORY_TOKEN_BUDGETS.scratchpad, "SCRATCHPAD", 25);
  return items.map((i) => i.rendered);
}
