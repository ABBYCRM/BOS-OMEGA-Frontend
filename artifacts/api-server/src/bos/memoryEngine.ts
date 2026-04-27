import { db } from "@workspace/db";
import { memoryItemsTable } from "@workspace/db";
import { and, eq, desc, isNull, or } from "drizzle-orm";
import {
  approxTokenCount,
  buildContextFromMemory as buildContextFromMemoryHelper,
  DROPPED_TITLES_CAP,
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

// Task #52: DROPPED_TITLES_CAP is owned by memoryHelpers.ts (so the no-DB
// unit-test harness can import it without dragging @workspace/db) and
// re-exported here so existing call sites that pull engine constants from
// memoryEngine.ts keep working.
export { DROPPED_TITLES_CAP };

export interface LayerSelection {
  /** Items that fit the per-layer token budget, in selected order. */
  items: string[];
  /** Items that ranked but were dropped because they did not fit the budget. */
  dropped: number;
  /**
   * Titles of the items that ranked but did not fit the budget, in the
   * same iteration order as the greedy fit skipped them. Bounded to
   * `DROPPED_TITLES_CAP` so the audit metadata stays cheap to render.
   * Task #52: the count alone could not tell the user *which* notes were
   * hidden — these titles close that loop.
   */
  dropped_titles: string[];
  /** Per-item provenance for each rendered string in `items`, same order. */
  injected: InjectedItemRef[];
}

async function selectLayer(
  layer: MemoryLayer,
  task_input: string,
  budget_tokens: number,
  prefix: string,
  initial_pull: number,
  user_id?: string | null,
): Promise<{ items: RankedItem[]; dropped: number; dropped_titles: string[] }> {
  // Task #67 — per-user scoping for non-canon layers. When `user_id` is
  // provided we restrict the pull to that user's rows plus any legacy
  // (user_id IS NULL) rows from before per-user tagging existed; this
  // closes the cross-user leakage where one user's pinned scratchpad row
  // could be injected into another user's prompt context. Canon does NOT
  // pass user_id (canon rows are intentionally global) so the legacy
  // layer-only filter is preserved for it.
  const where_clause =
    user_id !== undefined
      ? and(
          eq(memoryItemsTable.layer, layer),
          or(eq(memoryItemsTable.user_id, user_id ?? ""), isNull(memoryItemsTable.user_id)),
        )
      : eq(memoryItemsTable.layer, layer);

  const rows = await db
    .select()
    .from(memoryItemsTable)
    .where(where_clause)
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
  // Task #52: also surface the *titles* of the dropped items so the user
  // can identify exactly which notes were hidden and act on them. Bounded
  // to DROPPED_TITLES_CAP so the audit blob stays cheap to render.
  const { items, dropped, dropped_items } = selectWithinBudget(annotated, budget_tokens);
  return {
    items: items.map((i) => ({
      id: i.r.id,
      title: i.r.title,
      rendered: i.rendered,
      tokens: i.tokens,
    })),
    dropped,
    dropped_titles: dropped_items.slice(0, DROPPED_TITLES_CAP).map((i) => i.r.title),
  };
}

function toSelection(
  layer: MemoryLayer,
  picked: { items: RankedItem[]; dropped: number; dropped_titles: string[] },
): LayerSelection {
  return {
    items: picked.items.map((i) => i.rendered),
    dropped: picked.dropped,
    dropped_titles: picked.dropped_titles,
    injected: picked.items.map((i) => ({ id: i.id, layer, title: i.title })),
  };
}

// Task #59: per-call budget override. Pipeline passes the user's effective
// per-layer budget (resolved by `getEffectiveBudgets`) so a user who has
// dialed canon up to 6 000 actually gets a 6 000-token canon block. When no
// budget is supplied (callers other than the pipeline, e.g. ad-hoc helpers
// or tests) we fall back to the engine defaults so legacy call sites keep
// working unchanged.
export async function getCanonMemory(task_input = "", budget?: number): Promise<LayerSelection> {
  const picked = await selectLayer("canon", task_input, budget ?? MEMORY_TOKEN_BUDGETS.canon, "CANON", 50);
  return toSelection("canon", picked);
}

export async function getContinuityMemory(task_input = "", budget?: number, user_id?: string | null): Promise<LayerSelection> {
  const picked = await selectLayer("continuity", task_input, budget ?? MEMORY_TOKEN_BUDGETS.continuity, "CONTINUITY", 50, user_id);
  return toSelection("continuity", picked);
}

export async function getPatchesMemory(task_input = "", budget?: number, user_id?: string | null): Promise<LayerSelection> {
  const picked = await selectLayer("patches", task_input, budget ?? MEMORY_TOKEN_BUDGETS.patches, "PATCHES", 50, user_id);
  return toSelection("patches", picked);
}

export async function getScratchpad(task_input = "", budget?: number, user_id?: string | null): Promise<LayerSelection> {
  const picked = await selectLayer("scratchpad", task_input, budget ?? MEMORY_TOKEN_BUDGETS.scratchpad, "SCRATCHPAD", 25, user_id);
  return toSelection("scratchpad", picked);
}
