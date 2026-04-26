/**
 * BOS-OMEGA v1.1 — Budget Governor and Loop Guards.
 *
 * Cost / model-call / retry ceilings per execution mode. Any handler that
 * crosses a budget asks the governor for a HOLD verdict and stops spending.
 */

import type { ExecutionMode } from "./types.js";

export interface ModeBudget {
  /** Maximum number of distinct LLM calls (primary + fallbacks + parallel). */
  max_models: number;
  /** Maximum number of fallback hops per attempt. */
  max_fallbacks: number;
  /** Maximum number of structural-repair attempts on a single response. */
  max_repair_attempts: number;
  /** Maximum cumulative cost in USD across the whole task. */
  max_cost_usd: number;
  /** Maximum parallel agents (boil_the_ocean only). */
  max_parallel_agents?: number;
  /** Maximum synthesis retries (boil_the_ocean only). */
  max_synthesis_retries?: number;
  /** Maximum series_pass depth. */
  max_series_depth?: number;
  /** Maximum validation retries before giving up. */
  max_validation_retries?: number;
}

const NORMAL: ModeBudget = {
  max_models: 1,
  max_fallbacks: 2,
  max_repair_attempts: 2,
  max_cost_usd: 0.10,
  max_validation_retries: 2,
};

const PARALLEL: ModeBudget = {
  max_models: 4,
  max_fallbacks: 2,
  max_repair_attempts: 2,
  max_cost_usd: 0.40,
  max_validation_retries: 2,
};

const CONSENSUS: ModeBudget = {
  max_models: 5,
  max_fallbacks: 2,
  max_repair_attempts: 2,
  max_cost_usd: 0.50,
  max_validation_retries: 2,
};

const SERIES_PASS: ModeBudget = {
  max_models: 7,
  max_fallbacks: 3,
  max_repair_attempts: 2,
  max_cost_usd: 0.50,
  max_series_depth: 7,
  max_validation_retries: 2,
};

const BOIL_THE_OCEAN: ModeBudget = {
  max_models: 10,
  max_fallbacks: 3,
  max_repair_attempts: 2,
  max_cost_usd: 2.00,
  max_parallel_agents: 10,
  max_synthesis_retries: 2,
  max_validation_retries: 2,
};

export function budgetForMode(mode: ExecutionMode): ModeBudget {
  switch (mode) {
    case "parallel":       return PARALLEL;
    case "consensus":      return CONSENSUS;
    case "series_pass":    return SERIES_PASS;
    case "boil_the_ocean": return BOIL_THE_OCEAN;
    case "single":
    case "auto":
    default:               return NORMAL;
  }
}

export interface BudgetUsage {
  models_used: number;
  fallbacks_used: number;
  repair_attempts_used: number;
  cost_usd_used: number;
  parallel_agents_used?: number;
  synthesis_retries_used?: number;
  series_depth_used?: number;
  validation_retries_used?: number;
}

export interface BudgetVerdict {
  ok: boolean;
  /** Set when ok=false; identifies which budget was exceeded. */
  exceeded?: keyof BudgetUsage;
  /** Plain-English explanation suitable for surfacing in BosOutput.recommended_next_action. */
  reason?: string;
}

export function checkBudget(
  budget: ModeBudget,
  usage: BudgetUsage,
): BudgetVerdict {
  if (usage.models_used > budget.max_models) {
    return { ok: false, exceeded: "models_used", reason: `Model-call ceiling exceeded (${usage.models_used}/${budget.max_models}).` };
  }
  if (usage.fallbacks_used > budget.max_fallbacks) {
    return { ok: false, exceeded: "fallbacks_used", reason: `Fallback ceiling exceeded (${usage.fallbacks_used}/${budget.max_fallbacks}).` };
  }
  if (usage.repair_attempts_used > budget.max_repair_attempts) {
    return { ok: false, exceeded: "repair_attempts_used", reason: `Repair-attempt ceiling exceeded (${usage.repair_attempts_used}/${budget.max_repair_attempts}).` };
  }
  if (usage.cost_usd_used > budget.max_cost_usd) {
    return { ok: false, exceeded: "cost_usd_used", reason: `Execution cost ceiling exceeded ($${usage.cost_usd_used.toFixed(4)}/$${budget.max_cost_usd.toFixed(2)}).` };
  }
  if (budget.max_parallel_agents !== undefined && (usage.parallel_agents_used ?? 0) > budget.max_parallel_agents) {
    return { ok: false, exceeded: "parallel_agents_used", reason: `Parallel-agent ceiling exceeded (${usage.parallel_agents_used}/${budget.max_parallel_agents}).` };
  }
  if (budget.max_synthesis_retries !== undefined && (usage.synthesis_retries_used ?? 0) > budget.max_synthesis_retries) {
    return { ok: false, exceeded: "synthesis_retries_used", reason: `Synthesis-retry ceiling exceeded (${usage.synthesis_retries_used}/${budget.max_synthesis_retries}).` };
  }
  if (budget.max_series_depth !== undefined && (usage.series_depth_used ?? 0) > budget.max_series_depth) {
    return { ok: false, exceeded: "series_depth_used", reason: `Series-pass depth exceeded (${usage.series_depth_used}/${budget.max_series_depth}).` };
  }
  if (budget.max_validation_retries !== undefined && (usage.validation_retries_used ?? 0) > budget.max_validation_retries) {
    return { ok: false, exceeded: "validation_retries_used", reason: `Validation-retry ceiling exceeded (${usage.validation_retries_used}/${budget.max_validation_retries}).` };
  }
  return { ok: true };
}
