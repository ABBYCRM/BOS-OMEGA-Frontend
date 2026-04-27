import { db } from "@workspace/db";
import { memoryItemsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import {
  approxTokenCount,
  buildContextFromMemory as buildContextFromMemoryHelper,
  relevanceScore,
  selectWithinBudget,
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
  id: string;
  title: string;
  rendered: string;
  tokens: number;
}

/**
 * Task #50: per-item provenance for an injected memory row. The panel on
 * the task detail page renders one entry per `InjectedItemRef` so the user
 * can click each title and jump back to the source row in the Memory
 * Manager. `id` is the memory_items.id at the moment of injection — the UI
 * cross-references it against the live list to mark deleted/edited rows
 * as "no longer available" rather than silently producing a broken link.
 */
export interface InjectedItemRef {
  id: string;
  layer: MemoryLayer;
  title: string;
}

export interface LayerSelection {
  /** Items that fit the per-layer token budget, in selected order. */
  items: string[];
  /** Items that ranked but were dropped because they did not fit the budget. */
  dropped: number;
  /** Per-item provenance for each rendered string in `items`, same order. */
  injected: InjectedItemRef[];
}

async function selectLayer(
  layer: MemoryLayer,
  task_input: string,
  budget_tokens: number,
  prefix: string,
  initial_pull: number,
): Promise<{ items: RankedItem[]; dropped: number }> {
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

  // Greedy token fit against the per-layer budget. The dropped count tells
  // the audit log (and ultimately the user) how many ranked items the
  // budget cutoff hid from the model — answering "why didn't the AI use
  // my note?" with "it ranked below the budget cutoff" instead of silence.
  const { items, dropped } = selectWithinBudget(annotated, budget_tokens);
  return {
    items: items.map((i) => ({
      id: i.r.id,
      title: i.r.title,
      rendered: i.rendered,
      tokens: i.tokens,
    })),
    dropped,
  };
}

function toSelection(
  layer: MemoryLayer,
  picked: { items: RankedItem[]; dropped: number },
): LayerSelection {
  return {
    items: picked.items.map((i) => i.rendered),
    dropped: picked.dropped,
    injected: picked.items.map((i) => ({ id: i.id, layer, title: i.title })),
  };
}

export async function getCanonMemory(task_input = ""): Promise<LayerSelection> {
  const picked = await selectLayer("canon", task_input, MEMORY_TOKEN_BUDGETS.canon, "CANON", 50);
  return toSelection("canon", picked);
}

export async function getContinuityMemory(task_input = ""): Promise<LayerSelection> {
  const picked = await selectLayer("continuity", task_input, MEMORY_TOKEN_BUDGETS.continuity, "CONTINUITY", 50);
  return toSelection("continuity", picked);
}

export async function getPatchesMemory(task_input = ""): Promise<LayerSelection> {
  const picked = await selectLayer("patches", task_input, MEMORY_TOKEN_BUDGETS.patches, "PATCHES", 50);
  return toSelection("patches", picked);
}

export async function getScratchpad(task_input = ""): Promise<LayerSelection> {
  const picked = await selectLayer("scratchpad", task_input, MEMORY_TOKEN_BUDGETS.scratchpad, "SCRATCHPAD", 25);
  return toSelection("scratchpad", picked);
}
