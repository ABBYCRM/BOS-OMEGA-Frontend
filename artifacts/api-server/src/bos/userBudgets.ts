import { db } from "@workspace/db";
import { userMemoryBudgetsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { MEMORY_TOKEN_BUDGETS, type MemoryLayer } from "./memoryEngine.js";

/**
 * Task #59: per-user memory budget overrides.
 *
 * Each user may raise or lower the per-layer token budget the orchestrator
 * uses when ranking memory items into the model prompt. When no row exists
 * for the user, the engine defaults (MEMORY_TOKEN_BUDGETS) apply.
 *
 * The API surface validates against MIN/MAX_PER_LAYER and MAX_TOTAL so a
 * user can't accidentally blow the model's context window or starve the
 * pipeline by setting everything to zero. Validation is intentionally
 * server-side only — the UI may show client hints, but the server is the
 * source of truth.
 */

export interface MemoryBudgets {
  canon: number;
  continuity: number;
  patches: number;
  scratchpad: number;
}

export const DEFAULT_BUDGETS: MemoryBudgets = {
  canon: MEMORY_TOKEN_BUDGETS.canon,
  continuity: MEMORY_TOKEN_BUDGETS.continuity,
  patches: MEMORY_TOKEN_BUDGETS.patches,
  scratchpad: MEMORY_TOKEN_BUDGETS.scratchpad,
};

// Per-layer floor / ceiling. Floor at 0 lets a user disable a layer
// entirely; ceiling at 10 000 keeps a single layer from monopolizing the
// model's context window. Total cap of 20 000 is a safety net so the
// combined memory block stays under typical model context budgets even
// after persona + canon overlay overhead.
export const MIN_PER_LAYER = 0;
export const MAX_PER_LAYER = 10_000;
export const MAX_TOTAL = 20_000;

// Canon is special: the pipeline (artifacts/api-server/src/bos/pipeline.ts)
// throws CANON_LOAD_ERROR when no canon items survive the budget cut. A
// 0-token canon budget would therefore brick *every* task for the user as
// soon as they save the override. Enforce a per-task floor that fits at
// least one realistic canon row (governance entries are typically a few
// hundred tokens once headers are accounted for).
export const MIN_CANON_BUDGET = 500;

export type LayerKey = keyof MemoryBudgets;
const LAYER_KEYS: readonly LayerKey[] = ["canon", "continuity", "patches", "scratchpad"];

// Per-layer minimum override. Layers absent from this map fall back to
// MIN_PER_LAYER (0 — i.e. the user may disable them).
const PER_LAYER_MIN: Partial<Record<LayerKey, number>> = {
  canon: MIN_CANON_BUDGET,
};

function layerMin(layer: LayerKey): number {
  return PER_LAYER_MIN[layer] ?? MIN_PER_LAYER;
}

export type BudgetValidationError =
  | { code: "OUT_OF_RANGE"; layer: LayerKey; value: number; min: number; max: number }
  | { code: "TOTAL_EXCEEDED"; total: number; max_total: number }
  | { code: "NOT_FINITE"; layer: LayerKey; value: unknown };

export function validateBudgets(input: Partial<Record<LayerKey, unknown>>): {
  ok: true;
  values: MemoryBudgets;
} | {
  ok: false;
  error: BudgetValidationError;
} {
  const merged: MemoryBudgets = { ...DEFAULT_BUDGETS };
  for (const layer of LAYER_KEYS) {
    const raw = input[layer];
    if (raw === undefined) continue;
    if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw)) {
      return { ok: false, error: { code: "NOT_FINITE", layer, value: raw } };
    }
    const min = layerMin(layer);
    if (raw < min || raw > MAX_PER_LAYER) {
      return {
        ok: false,
        error: { code: "OUT_OF_RANGE", layer, value: raw, min, max: MAX_PER_LAYER },
      };
    }
    merged[layer] = raw;
  }
  // Defence in depth: also re-check the merged values against per-layer
  // mins, so a future caller that mutates DEFAULT_BUDGETS or skips a
  // field can never drop below the floor (e.g. canon < MIN_CANON_BUDGET).
  for (const layer of LAYER_KEYS) {
    const value = merged[layer];
    const min = layerMin(layer);
    if (value < min) {
      return {
        ok: false,
        error: { code: "OUT_OF_RANGE", layer, value, min, max: MAX_PER_LAYER },
      };
    }
  }
  const total = merged.canon + merged.continuity + merged.patches + merged.scratchpad;
  if (total > MAX_TOTAL) {
    return { ok: false, error: { code: "TOTAL_EXCEEDED", total, max_total: MAX_TOTAL } };
  }
  return { ok: true, values: merged };
}

function rowToBudgets(row: typeof userMemoryBudgetsTable.$inferSelect): MemoryBudgets {
  return {
    canon: row.canon_budget,
    continuity: row.continuity_budget,
    patches: row.patches_budget,
    scratchpad: row.scratchpad_budget,
  };
}

/**
 * Defence-in-depth normalization for budgets read from the DB.
 *
 * `validateBudgets` only runs at write time. If a row reaches the DB
 * through any other path (manual SQL fix, migration backfill, future
 * non-API writer, or a row written before MIN_CANON_BUDGET was added),
 * the pipeline could still consume an unsafe value and brick the user
 * (canon=0 → CANON_LOAD_ERROR on every task). Clamp every layer to the
 * same bounds the API enforces so the runtime is robust to bad data at
 * rest.
 */
function clampBudgetsForRuntime(b: MemoryBudgets): MemoryBudgets {
  const clampLayer = (layer: LayerKey, value: number): number => {
    const min = layerMin(layer);
    if (!Number.isFinite(value) || !Number.isInteger(value)) return DEFAULT_BUDGETS[layer];
    if (value < min) return min;
    if (value > MAX_PER_LAYER) return MAX_PER_LAYER;
    return value;
  };
  return {
    canon: clampLayer("canon", b.canon),
    continuity: clampLayer("continuity", b.continuity),
    patches: clampLayer("patches", b.patches),
    scratchpad: clampLayer("scratchpad", b.scratchpad),
  };
}

/**
 * Resolve the effective per-layer budgets for a task.
 *
 * - Anonymous (legacy / pre-user-id) tasks always get the defaults; nothing
 *   to look up since user_id is null.
 * - Logged-in users with no row in user_memory_budgets get the defaults.
 * - Logged-in users with a row get their stored values verbatim (already
 *   validated at write time).
 */
export async function getEffectiveBudgets(user_id: string | null | undefined): Promise<MemoryBudgets> {
  if (!user_id) return { ...DEFAULT_BUDGETS };
  const [row] = await db
    .select()
    .from(userMemoryBudgetsTable)
    .where(eq(userMemoryBudgetsTable.user_id, user_id))
    .limit(1);
  if (!row) return { ...DEFAULT_BUDGETS };
  // Clamp at read time so a row that bypassed validateBudgets (e.g.
  // manual SQL fix, future migration backfill) cannot brick the pipeline.
  return clampBudgetsForRuntime(rowToBudgets(row));
}

/**
 * Read a user's stored overrides, or null if no row exists. Used by the
 * GET endpoint so the UI can distinguish "stored override" from "running
 * on defaults".
 */
export async function getUserBudgetsRowOrNull(user_id: string): Promise<MemoryBudgets | null> {
  const [row] = await db
    .select()
    .from(userMemoryBudgetsTable)
    .where(eq(userMemoryBudgetsTable.user_id, user_id))
    .limit(1);
  return row ? rowToBudgets(row) : null;
}

/**
 * Upsert a user's overrides. Caller must have validated `budgets` first
 * via validateBudgets — this function trusts its input. Returns the merged
 * row so callers can reflect it back in the response.
 */
export async function setUserBudgets(user_id: string, budgets: MemoryBudgets): Promise<MemoryBudgets> {
  await db
    .insert(userMemoryBudgetsTable)
    .values({
      user_id,
      canon_budget: budgets.canon,
      continuity_budget: budgets.continuity,
      patches_budget: budgets.patches,
      scratchpad_budget: budgets.scratchpad,
      updated_at: new Date(),
    })
    .onConflictDoUpdate({
      target: userMemoryBudgetsTable.user_id,
      set: {
        canon_budget: budgets.canon,
        continuity_budget: budgets.continuity,
        patches_budget: budgets.patches,
        scratchpad_budget: budgets.scratchpad,
        updated_at: new Date(),
      },
    });
  return budgets;
}

/**
 * Reset a user's overrides back to defaults by deleting the row. Used by
 * the "Reset to defaults" button so the row stays out of the table when
 * the user is happy with the engine defaults.
 */
export async function resetUserBudgets(user_id: string): Promise<void> {
  await db.delete(userMemoryBudgetsTable).where(eq(userMemoryBudgetsTable.user_id, user_id));
}

// Re-export the layer key list so callers iterating layers don't have to
// duplicate the order.
export { LAYER_KEYS };
export type { MemoryLayer };
