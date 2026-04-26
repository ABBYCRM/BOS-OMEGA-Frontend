import type { TriState } from "./types.js";

/**
 * Qubit-inspired probabilistic Tri-State Engine.
 *
 * NOTE: This is NOT literal quantum computing. It is a quantum-inspired control
 * model where GO/HOLD/ABORT exist as weighted decision amplitudes before
 * collapsing into a single runtime state.
 *
 * Each task starts with a neutral vector:
 *   GO=0.33, HOLD=0.34, ABORT=0.33
 * Evidence signals push the amplitudes; the vector is normalized after each
 * update. Then collapse rules pick the final executable state.
 *
 * The vector is advisory until collapsed.
 * Only the collapsed state controls execution.
 */

export type SignalImpact = {
  go: number;
  hold: number;
  abort: number;
};

export type EvidenceSignal = {
  name: string;
  category: "safety" | "completeness" | "confidence" | "source_quality" | "tool_availability" | "intent_clarity" | "risk";
  description: string;
  impact: SignalImpact;
};

export type TriStateVector = {
  go: number;
  hold: number;
  abort: number;
};

export interface TriStateInput {
  input_safe: boolean;
  has_required_info: boolean;
  provider_available: boolean;
  has_fallback: boolean;
  risk_level: "none" | "low" | "medium" | "high";
  missing_info: string[];
  reason?: string;

  // Optional richer signals (added by qubit upgrade)
  intent_clarity?: number;        // 0..1
  source_quality?: number;        // 0..1
  confidence_score?: number;      // 0..1
  validation_passed?: boolean;
  high_stakes_domain?: boolean;   // legal, medical, financial, etc.
  unsupported_factual_claim?: boolean;
  unauthorized_action?: boolean;
  illegal_instruction?: boolean;
  ambiguity_detected?: boolean;
  task_type?: string;

  // v1.1 hardening signals
  /** When true, collapse() returns ABORT immediately regardless of vector math. */
  hard_safety_abort?: boolean;
}

/**
 * Required confidence floor for a task to be allowed to collapse to GO.
 * High-stakes domains require materially higher confidence than general tasks.
 */
export function requiredConfidenceForTaskType(task_type?: string): number {
  const HIGH_STAKES = new Set(["legal", "medical", "financial", "code", "security"]);
  return HIGH_STAKES.has((task_type ?? "").toLowerCase()) ? 0.85 : 0.70;
}

export interface TriStateResult {
  state: TriState;
  reason: string;
  vector: TriStateVector;
  pre_collapse_vector: TriStateVector;
  evidence_signals: EvidenceSignal[];
  confidence_score: number;
  collapse_reason: string;
}

const NEUTRAL_VECTOR: TriStateVector = { go: 0.33, hold: 0.34, abort: 0.33 };

function normalize(v: TriStateVector): TriStateVector {
  // Clamp negatives to 0 (signals can subtract)
  const go = Math.max(0, v.go);
  const hold = Math.max(0, v.hold);
  const abort = Math.max(0, v.abort);
  const sum = go + hold + abort;
  if (sum === 0) return { ...NEUTRAL_VECTOR };
  return { go: go / sum, hold: hold / sum, abort: abort / sum };
}

function applySignal(v: TriStateVector, impact: SignalImpact): TriStateVector {
  return normalize({
    go: v.go + impact.go,
    hold: v.hold + impact.hold,
    abort: v.abort + impact.abort,
  });
}

/**
 * Build the list of evidence signals from the structured input.
 * Each signal carries an explicit impact on the GO/HOLD/ABORT amplitudes.
 */
function gatherSignals(input: TriStateInput): EvidenceSignal[] {
  const signals: EvidenceSignal[] = [];

  // SAFETY signals
  if (input.illegal_instruction) {
    signals.push({
      name: "illegal_instruction",
      category: "safety",
      description: "Request contains illegal instructions",
      impact: { go: -0.30, hold: 0, abort: 0.80 },
    });
  }
  if (input.unauthorized_action) {
    signals.push({
      name: "unauthorized_action",
      category: "safety",
      description: "Request requires unauthorized action",
      impact: { go: -0.20, hold: 0.10, abort: 0.60 },
    });
  }
  if (!input.input_safe || input.risk_level === "high") {
    signals.push({
      name: "unsafe_request",
      category: "safety",
      description: "Input gate flagged unsafe content or high-risk intent",
      impact: { go: -0.20, hold: 0.10, abort: 0.55 },
    });
  } else {
    signals.push({
      name: "safe_request",
      category: "safety",
      description: "Input gate passed safety screening",
      impact: { go: 0.20, hold: 0, abort: -0.05 },
    });
  }

  // RISK level
  if (input.risk_level === "medium") {
    signals.push({
      name: "medium_risk_intent",
      category: "risk",
      description: "Risk level: medium — requires extra scrutiny",
      impact: { go: -0.05, hold: 0.18, abort: 0.05 },
    });
  } else if (input.risk_level === "low") {
    signals.push({
      name: "low_risk_intent",
      category: "risk",
      description: "Risk level: low",
      impact: { go: 0.05, hold: 0.02, abort: 0 },
    });
  }

  // COMPLETENESS signals
  if (input.missing_info.length > 0) {
    signals.push({
      name: "missing_required_inputs",
      category: "completeness",
      description: `Missing required inputs: ${input.missing_info.join(", ")}`,
      impact: { go: -0.15, hold: 0.45, abort: 0 },
    });
  } else if (input.has_required_info) {
    signals.push({
      name: "required_inputs_present",
      category: "completeness",
      description: "All required inputs are present",
      impact: { go: 0.20, hold: -0.05, abort: 0 },
    });
  }

  // INTENT CLARITY signal
  if (typeof input.intent_clarity === "number") {
    if (input.intent_clarity >= 0.75) {
      signals.push({
        name: "clear_user_intent",
        category: "intent_clarity",
        description: `Intent clarity high (${input.intent_clarity.toFixed(2)})`,
        impact: { go: 0.20, hold: -0.05, abort: 0 },
      });
    } else if (input.intent_clarity <= 0.4) {
      signals.push({
        name: "ambiguous_user_intent",
        category: "intent_clarity",
        description: `Intent clarity low (${input.intent_clarity.toFixed(2)})`,
        impact: { go: -0.05, hold: 0.25, abort: 0 },
      });
    }
  }
  if (input.ambiguity_detected) {
    signals.push({
      name: "ambiguity_detected",
      category: "intent_clarity",
      description: "Ambiguous task framing detected",
      impact: { go: -0.05, hold: 0.18, abort: 0 },
    });
  }

  // CONFIDENCE signal
  if (typeof input.confidence_score === "number") {
    if (input.confidence_score >= 0.75) {
      signals.push({
        name: "high_confidence",
        category: "confidence",
        description: `Confidence high (${input.confidence_score.toFixed(2)})`,
        impact: { go: 0.18, hold: -0.05, abort: 0 },
      });
    } else if (input.confidence_score <= 0.4) {
      signals.push({
        name: "low_confidence",
        category: "confidence",
        description: `Confidence low (${input.confidence_score.toFixed(2)})`,
        impact: { go: -0.05, hold: 0.20, abort: 0 },
      });
    }
  }

  // SOURCE QUALITY signal
  if (typeof input.source_quality === "number") {
    if (input.source_quality >= 0.75) {
      signals.push({
        name: "strong_source_quality",
        category: "source_quality",
        description: `Source quality high (${input.source_quality.toFixed(2)})`,
        impact: { go: 0.10, hold: -0.02, abort: 0 },
      });
    } else if (input.source_quality <= 0.4) {
      signals.push({
        name: "weak_source_quality",
        category: "source_quality",
        description: `Source quality weak (${input.source_quality.toFixed(2)})`,
        impact: { go: -0.05, hold: 0.15, abort: 0 },
      });
    }
  }

  if (input.unsupported_factual_claim) {
    signals.push({
      name: "unsupported_factual_claim",
      category: "source_quality",
      description: "Detected unsupported factual claim",
      impact: { go: -0.10, hold: 0.25, abort: 0 },
    });
  }

  // TOOL/PROVIDER AVAILABILITY signal
  if (!input.provider_available && !input.has_fallback) {
    signals.push({
      name: "no_provider_available",
      category: "tool_availability",
      description: "No LLM provider available and no fallback configured",
      impact: { go: -0.20, hold: 0.40, abort: 0 },
    });
  } else if (input.provider_available && input.has_fallback) {
    signals.push({
      name: "providers_available_with_fallback",
      category: "tool_availability",
      description: "Primary provider available + fallback configured",
      impact: { go: 0.18, hold: -0.05, abort: 0 },
    });
  } else if (input.provider_available) {
    signals.push({
      name: "primary_provider_available",
      category: "tool_availability",
      description: "Primary provider available (no fallback)",
      impact: { go: 0.10, hold: 0.02, abort: 0 },
    });
  }

  // HIGH-STAKES DOMAIN signal
  if (input.high_stakes_domain) {
    signals.push({
      name: "high_stakes_domain",
      category: "risk",
      description: `High-stakes domain (${input.task_type || "domain"}) — apply extra caution`,
      impact: { go: -0.05, hold: 0.20, abort: 0 },
    });
  }

  // VALIDATION signal
  if (input.validation_passed === true) {
    signals.push({
      name: "validation_passed",
      category: "completeness",
      description: "Output validation passed",
      impact: { go: 0.15, hold: -0.05, abort: 0 },
    });
  } else if (input.validation_passed === false) {
    signals.push({
      name: "validation_failed",
      category: "completeness",
      description: "Output validation failed",
      impact: { go: -0.10, hold: 0.30, abort: 0 },
    });
  }

  return signals;
}

/**
 * Apply collapse rules — converts the probabilistic vector into a single
 * runtime state. The vector is advisory until this collapse happens.
 *
 * v1.1 hardened collapse rules (in evaluation order):
 *   1. hard_safety_abort  → ABORT (hard veto, bypasses vector math)
 *   2. abort ≥ 0.65       → ABORT
 *   3. missing inputs     → HOLD
 *   4. no provider        → HOLD
 *   5. (go ≥ 0.75 ∧ validation_passed ∧ confidence ≥ requiredConfidence) → GO
 *   6. otherwise          → HOLD (safe default)
 */
function collapse(
  vector: TriStateVector,
  input: TriStateInput,
  validationPassed: boolean,
  computed_confidence: number,
): { state: TriState; reason: string } {
  if (input.hard_safety_abort) {
    return {
      state: "ABORT",
      reason: "Hard safety veto — request matched a non-negotiable safety rule",
    };
  }
  if (vector.abort >= 0.65) {
    return {
      state: "ABORT",
      reason: `ABORT amplitude ${(vector.abort * 100).toFixed(0)}% ≥ hardened threshold 65%`,
    };
  }
  if (input.missing_info.length > 0) {
    return {
      state: "HOLD",
      reason: `Missing required inputs: ${input.missing_info.join(", ")}`,
    };
  }
  if (!input.provider_available) {
    return {
      state: "HOLD",
      reason: "No LLM provider available to handle this task",
    };
  }
  const required_confidence = requiredConfidenceForTaskType(input.task_type);
  if (vector.go >= 0.75 && validationPassed && computed_confidence >= required_confidence) {
    return {
      state: "GO",
      reason: `GO amplitude ${(vector.go * 100).toFixed(0)}% ≥ 75%, validation passed, confidence ${(computed_confidence * 100).toFixed(0)}% ≥ required ${(required_confidence * 100).toFixed(0)}%`,
    };
  }
  return {
    state: "HOLD",
    reason: `Hardened default: GO=${(vector.go * 100).toFixed(0)}%, HOLD=${(vector.hold * 100).toFixed(0)}%, ABORT=${(vector.abort * 100).toFixed(0)}%, confidence=${(computed_confidence * 100).toFixed(0)}%, required=${(required_confidence * 100).toFixed(0)}% — collapsing to HOLD`,
  };
}

export function evaluateTriState(input: TriStateInput): TriStateResult {
  const pre_collapse_vector: TriStateVector = { ...NEUTRAL_VECTOR };

  const signals = gatherSignals(input);

  let vector = { ...NEUTRAL_VECTOR };
  for (const signal of signals) {
    vector = applySignal(vector, signal.impact);
  }

  const final_pre_collapse = { ...vector };

  const validation_passed = input.validation_passed !== false;

  // Confidence in the collapse: how dominant the chosen amplitude is.
  // Computed before collapse() so the threshold rule can use it.
  const max_amplitude = Math.max(final_pre_collapse.go, final_pre_collapse.hold, final_pre_collapse.abort);
  const second = [final_pre_collapse.go, final_pre_collapse.hold, final_pre_collapse.abort]
    .sort((a, b) => b - a)[1] ?? 0;
  const confidence_score = Math.max(0, Math.min(1, max_amplitude - second + max_amplitude * 0.5));

  const { state, reason } = collapse(final_pre_collapse, input, validation_passed, confidence_score);

  return {
    state,
    reason,
    vector: final_pre_collapse,
    pre_collapse_vector,
    evidence_signals: signals,
    confidence_score,
    collapse_reason: reason,
  };
}
