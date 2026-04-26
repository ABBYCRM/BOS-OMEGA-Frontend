/**
 * R-1: Role-differentiated parallel/consensus execution.
 *
 * In single-model mode each call uses the same kernel + persona system
 * prompt. In parallel/consensus mode that produces near-identical answers
 * because each model gets the exact same instructions — defeating the
 * point of running multiple models. This module assigns a different
 * **role overlay** to each model in a parallel batch so each one
 * approaches the task from a deliberately different perspective. The
 * overlay is appended to the system prompt between the persona block
 * and the memory block (kernel → persona → role_overlay → memory).
 *
 * Roles are deterministic w.r.t. the input model order so a given task
 * always assigns the same role to the same model slot (the alphabetical
 * sort on `provider/model` in `selectTopModels` keeps it stable across
 * runs of the same workspace state). This makes audit replay easier.
 */

export const PARALLEL_ROLES = [
  "ARCHITECT",
  "CRITIC",
  "RESEARCHER",
  "BUILDER",
  "VALIDATOR",
] as const;

export type ParallelRole = (typeof PARALLEL_ROLES)[number];

export const PARALLEL_ROLE_INSTRUCTIONS: Record<ParallelRole, string> = {
  ARCHITECT:
    "ROLE: ARCHITECT. Approach this task as a systems architect. Frame the answer in terms of structure, components, interfaces, trade-offs between designs, and how the pieces fit together. Prefer explicit design rationale over surface-level summaries. Call out the strongest one or two architectural choices and why they win.",
  CRITIC:
    "ROLE: CRITIC. Approach this task as an adversarial reviewer. Your job is to find the weak points in the obvious answer: hidden assumptions, edge cases, failure modes, missing context, and risks the naive solution ignores. Populate `errors_found` and `failure_modes` aggressively. Do not refuse to answer — give the best answer you can but lead with what would make it wrong.",
  RESEARCHER:
    "ROLE: RESEARCHER. Approach this task as a domain researcher. Cite the relevant facts, prior art, standards, formulas, or precedents that govern the answer. Distinguish what is established from what is conjecture. If sources or context are insufficient, say so explicitly in `missing_inputs` rather than guessing.",
  BUILDER:
    "ROLE: BUILDER. Approach this task as a hands-on implementer. Give a concrete, actionable answer: steps, code, configurations, commands, or worked examples. Avoid abstract framing — favor a runnable or directly-applicable answer over a discussion of one.",
  VALIDATOR:
    "ROLE: VALIDATOR. Approach this task as a verifier. State the answer, then state the test or check that proves it. Include acceptance criteria, what success looks like, and how the user would know if the answer is wrong. Populate `recommended_next_action` with a concrete verification step.",
};

/**
 * Assign a role to each model in the parallel batch. Cycles through
 * PARALLEL_ROLES in order so:
 *   N=2 → ARCHITECT, CRITIC
 *   N=3 → ARCHITECT, CRITIC, RESEARCHER
 *   N=4 → ARCHITECT, CRITIC, RESEARCHER, BUILDER
 *   N=5 → all five
 *   N=6+ → ARCHITECT, CRITIC, RESEARCHER, BUILDER, VALIDATOR, ARCHITECT, ...
 *
 * Caller is expected to have already gated N=1 (single-model parallel
 * makes no sense; pipeline.ts emits MODE_DOWNGRADED in that case).
 */
export function assignRoles(model_count: number): ParallelRole[] {
  if (model_count <= 0) return [];
  const roles: ParallelRole[] = [];
  for (let i = 0; i < model_count; i++) {
    roles.push(PARALLEL_ROLES[i % PARALLEL_ROLES.length]!);
  }
  return roles;
}

export function buildRoleOverlay(role: ParallelRole): string {
  return PARALLEL_ROLE_INSTRUCTIONS[role];
}
