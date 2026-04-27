/**
 * BOP.TRI_STATE.v2 — Display-only metadata parser.
 *
 * The previous "Qubit-inspired" runtime collapse engine has been removed.
 * Tri-State (GO / HOLD / ABORT) is now CANON-driven: the model decides the
 * label as part of its structured output, governed by the BOS Canon prompt.
 * This module exists ONLY to:
 *
 *   1. Provide the TriState type to the rest of the codebase.
 *   2. Parse a model's BosOutput into a {state, confidence, reason}
 *      record that the audit trail and the frontend display layer can
 *      render. The parser MUST NOT influence routing, fallback, or
 *      execution decisions.
 *
 * If you find yourself re-introducing thresholds, vector math, or
 * "collapse to HOLD if X" logic here, stop — that belongs in Canon, not
 * in runtime code.
 */

import type { BosOutput, TriState } from "./types.js";

/**
 * Output of the metadata parser. Shape matches the columns of
 * tri_state_decisions so the route layer can persist and serve it
 * unchanged for the existing /api/tri-state endpoints.
 */
export interface TriStateDisplayMetadata {
  /** GO/HOLD/ABORT verbatim from the model output. */
  state: TriState;
  /** 0..1 — derived from validation confidence; display only. */
  confidence_score: number;
  /** Plain-English label for the audit chain. */
  reason: string;
  /** Audit-only mirror of the state — keep neutral 0.34/0.33/0.33. */
  vector: { go: number; hold: number; abort: number };
  /** Empty list — kept for backwards-compatible response shape. */
  evidence_signals: never[];
  /** Same as `reason`, kept for backwards-compatible response shape. */
  collapse_reason: string;
}

/**
 * Build display metadata from a model's parsed output. Pure, no side effects,
 * no decisions. The state field is a verbatim echo of model_output.state.
 */
export function buildTriStateMetadata(
  model_output: Pick<BosOutput, "state" | "answer">,
  validation_confidence: number,
): TriStateDisplayMetadata {
  const state: TriState = model_output.state;
  const confidence = clamp01(validation_confidence);
  const reason = `Model labelled ${state} with validation confidence ${(confidence * 100).toFixed(0)}%`;

  // Render a "vector" that points at the model's chosen state so the
  // existing UI can keep showing a tri-state pie without the runtime
  // doing any actual amplitude math.
  const vector = { go: 0.34, hold: 0.33, abort: 0.33 };
  if (state === "GO") vector.go = 1;
  else if (state === "HOLD") vector.hold = 1;
  else vector.abort = 1;

  return {
    state,
    confidence_score: confidence,
    reason,
    vector,
    evidence_signals: [],
    collapse_reason: reason,
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// Backwards-compat type aliases. These remain so existing route/test code that
// imports them continues to compile without forcing a wide rename. NEW code
// should import TriStateDisplayMetadata directly.
export type TriStateResult = TriStateDisplayMetadata;
export type TriStateInput = Record<string, unknown>;
