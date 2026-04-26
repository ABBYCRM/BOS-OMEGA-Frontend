import type { TaskType } from "./types.js";

export type AdvancedMode = "normal" | "series_pass" | "boil_the_ocean" | "auto";

const BOIL_THE_OCEAN_KEYWORDS = [
  "boil the ocean", "exhaustive", "granular", "final version", "no ambiguity",
  "10/10", "comprehensive", "complete", "thorough", "definitive", "authoritative",
  "production ready", "ship it", "enterprise", "bulletproof",
];

const SERIES_PASS_KEYWORDS = [
  "error check", "improve", "refine", "pass through", "series", "make perfect",
  "double check", "review", "critique", "validate", "polish", "iterate",
  "check my work", "find mistakes", "perfect this",
];

const HIGH_STAKES_TYPES: (TaskType | string)[] = [
  "legal", "research", "planning", "code",
];

const COMPLEX_TYPES: (TaskType | string)[] = [
  "legal", "research", "planning", "code", "math",
];

export interface ModeSelectorResult {
  // Must mirror the full ExecutionMode union — narrowing it here was the root
  // cause of the audit's C-3 finding (parallel/consensus silently degrading
  // to single-shot because pipeline.ts:361 couldn't see them).
  mode: "single" | "normal" | "parallel" | "consensus" | "series_pass" | "boil_the_ocean";
  reason: string;
  confidence: number;
}

export function selectExecutionMode(
  requested_mode: AdvancedMode | string,
  input: string,
  task_type: TaskType | string,
  input_length: number,
): ModeSelectorResult {
  const lc = input.toLowerCase();

  // Explicit user override — honor every concrete ExecutionMode the caller
  // can ask for. "auto" is the only value that falls through to heuristics.
  if (requested_mode === "boil_the_ocean") {
    return { mode: "boil_the_ocean", reason: "Explicitly requested by user", confidence: 1.0 };
  }
  if (requested_mode === "series_pass") {
    return { mode: "series_pass", reason: "Explicitly requested by user", confidence: 1.0 };
  }
  if (requested_mode === "consensus") {
    return { mode: "consensus", reason: "Explicitly requested by user", confidence: 1.0 };
  }
  if (requested_mode === "parallel") {
    return { mode: "parallel", reason: "Explicitly requested by user", confidence: 1.0 };
  }
  if (requested_mode === "single") {
    return { mode: "single", reason: "Explicitly requested by user", confidence: 1.0 };
  }
  if (requested_mode === "normal") {
    return { mode: "normal", reason: "Explicitly requested by user", confidence: 1.0 };
  }

  // Auto selection logic
  // Check for boil the ocean keywords
  const bto_match = BOIL_THE_OCEAN_KEYWORDS.some((kw) => lc.includes(kw));
  if (bto_match) {
    return {
      mode: "boil_the_ocean",
      reason: `Input contains exhaustive-intent keywords`,
      confidence: 0.95,
    };
  }

  // Check for series pass keywords
  const sp_match = SERIES_PASS_KEYWORDS.some((kw) => lc.includes(kw));
  if (sp_match) {
    return {
      mode: "series_pass",
      reason: `Input contains refinement-intent keywords`,
      confidence: 0.9,
    };
  }

  // High-stakes task types → boil the ocean
  if (HIGH_STAKES_TYPES.includes(task_type) && input_length > 200) {
    return {
      mode: "boil_the_ocean",
      reason: `High-stakes task type "${task_type}" with complex input`,
      confidence: 0.8,
    };
  }

  // Complex task types with medium input → series pass
  if (COMPLEX_TYPES.includes(task_type) && input_length > 100) {
    return {
      mode: "series_pass",
      reason: `Complex task type "${task_type}" benefits from sequential refinement`,
      confidence: 0.75,
    };
  }

  // Long inputs → series pass
  if (input_length > 500) {
    return {
      mode: "series_pass",
      reason: "Long input benefits from sequential refinement",
      confidence: 0.7,
    };
  }

  // Default: normal
  return {
    mode: "normal",
    reason: "Simple task — normal single-model execution",
    confidence: 0.9,
  };
}
