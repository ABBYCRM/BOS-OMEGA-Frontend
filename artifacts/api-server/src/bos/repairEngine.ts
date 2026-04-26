import type { BosOutput, ValidationReport } from "./types.js";
import { logger } from "../lib/logger.js";

export function repairOutput(raw: string, validation: ValidationReport): {
  repaired: string;
  success: boolean;
} {
  if (validation.passed) return { repaired: raw, success: true };

  let repaired = raw;

  if (!validation.schema_pass) {
    repaired = attemptSchemaRepair(raw);
  }

  if (!validation.completeness_pass) {
    repaired = attemptCompletenessRepair(repaired);
  }

  repaired = removeDrift(repaired);

  // v1.1 hardening: don't claim success unless the repaired blob actually
  // round-trips as valid JSON with the expected shape. A "successful" repair
  // that still produces malformed JSON is the exact failure mode the spec calls
  // out — downstream code must treat that as a HOLD-worthy failure, not a GO.
  let success = false;
  try {
    const parsed = JSON.parse(repaired) as Partial<BosOutput>;
    success = ["GO", "HOLD", "ABORT"].includes(parsed.state as string)
      && typeof parsed.answer === "string"
      && parsed.answer.length > 0;
  } catch {
    success = false;
  }

  logger.info({ success }, "Repair engine applied patches");

  return { repaired, success };
}

/**
 * v1.1 hardening: malformed model output NEVER defaults to GO.
 * Any synthesised BosOutput from a structurally broken response collapses to HOLD
 * and carries the `repair_applied` marker so downstream layers can react.
 */
function attemptSchemaRepair(raw: string): string {
  const REPAIR_NEXT_ACTION = "Retry with stricter structured-output enforcement.";
  const REPAIR_UNCERTAINTY = "Output required structural repair.";
  const REPAIR_FAILURE_MODE = "malformed_model_output";

  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      const answer = raw.trim().slice(0, 2000) || "Model output was malformed.";
      const fixed: BosOutput = {
        state: "HOLD",
        task_type: "general",
        answer,
        assumptions: [],
        uncertainties: [REPAIR_UNCERTAINTY],
        missing_inputs: [],
        failure_modes: [REPAIR_FAILURE_MODE],
        recommended_next_action: REPAIR_NEXT_ACTION,
        repair_applied: true,
      };
      return JSON.stringify(fixed);
    }

    const parsed = JSON.parse(jsonMatch[0]) as Partial<BosOutput>;
    // Only trust the model's own state if every required field is present.
    // Otherwise the structurally-incomplete output collapses to HOLD.
    const has_complete_envelope =
      ["GO", "HOLD", "ABORT"].includes(parsed.state as string) &&
      typeof parsed.answer === "string" &&
      parsed.answer.trim().length >= 10 &&
      typeof parsed.recommended_next_action === "string" &&
      parsed.recommended_next_action.length > 0;

    const safe_state: BosOutput["state"] = has_complete_envelope
      ? (parsed.state as BosOutput["state"])
      : "HOLD";

    const fixed: BosOutput = {
      state: safe_state,
      task_type: parsed.task_type || "general",
      answer:
        parsed.answer ||
        raw.replace(/\{[\s\S]*\}/, "").trim().slice(0, 2000) ||
        "Model output was malformed.",
      assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions : [],
      uncertainties: Array.isArray(parsed.uncertainties)
        ? has_complete_envelope
          ? parsed.uncertainties
          : [...parsed.uncertainties, REPAIR_UNCERTAINTY]
        : [REPAIR_UNCERTAINTY],
      missing_inputs: Array.isArray(parsed.missing_inputs) ? parsed.missing_inputs : [],
      failure_modes: Array.isArray(parsed.failure_modes)
        ? has_complete_envelope
          ? parsed.failure_modes
          : [...parsed.failure_modes, REPAIR_FAILURE_MODE]
        : [REPAIR_FAILURE_MODE],
      recommended_next_action: parsed.recommended_next_action || REPAIR_NEXT_ACTION,
      repair_applied: !has_complete_envelope,
    };
    return JSON.stringify(fixed);
  } catch {
    const fixed: BosOutput = {
      state: "HOLD",
      task_type: "general",
      answer: raw.trim().slice(0, 2000) || "Model output was malformed.",
      assumptions: [],
      uncertainties: [REPAIR_UNCERTAINTY],
      missing_inputs: [],
      failure_modes: [REPAIR_FAILURE_MODE],
      recommended_next_action: REPAIR_NEXT_ACTION,
      repair_applied: true,
    };
    return JSON.stringify(fixed);
  }
}

function attemptCompletenessRepair(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Partial<BosOutput>;
    if (!parsed.recommended_next_action) {
      parsed.recommended_next_action = "No further action required";
    }
    if (!parsed.answer || parsed.answer.trim().length < 10) {
      parsed.answer = "The model returned an incomplete response. Please retry with more context.";
    }
    return JSON.stringify(parsed);
  } catch {
    return raw;
  }
}

function removeDrift(raw: string): string {
  return raw.replace(/I'm Claude|I'm GPT|As an AI assistant|As a helpful assistant/gi, "BOS-OMEGA");
}
