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

  logger.info("Repair engine applied patches");

  return { repaired, success: true };
}

function attemptSchemaRepair(raw: string): string {
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      const answer = raw.trim().slice(0, 2000);
      const fixed: BosOutput = {
        state: "GO",
        task_type: "general",
        answer,
        assumptions: [],
        uncertainties: [],
        missing_inputs: [],
        failure_modes: [],
        recommended_next_action: "Review the answer above",
      };
      return JSON.stringify(fixed);
    }

    const parsed = JSON.parse(jsonMatch[0]) as Partial<BosOutput>;
    const fixed: BosOutput = {
      state: (["GO", "HOLD", "ABORT"].includes(parsed.state as string) ? parsed.state : "GO") as BosOutput["state"],
      task_type: parsed.task_type || "general",
      answer: parsed.answer || raw.replace(/\{[\s\S]*\}/, "").trim().slice(0, 2000) || "Response generated",
      assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions : [],
      uncertainties: Array.isArray(parsed.uncertainties) ? parsed.uncertainties : [],
      missing_inputs: Array.isArray(parsed.missing_inputs) ? parsed.missing_inputs : [],
      failure_modes: Array.isArray(parsed.failure_modes) ? parsed.failure_modes : [],
      recommended_next_action: parsed.recommended_next_action || "Review the answer above",
    };
    return JSON.stringify(fixed);
  } catch {
    const fixed: BosOutput = {
      state: "GO",
      task_type: "general",
      answer: raw.trim().slice(0, 2000),
      assumptions: [],
      uncertainties: ["Response could not be fully parsed"],
      missing_inputs: [],
      failure_modes: [],
      recommended_next_action: "Review the raw answer above",
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
