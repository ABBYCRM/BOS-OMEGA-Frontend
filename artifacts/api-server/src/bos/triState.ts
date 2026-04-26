import type { TriState } from "./types.js";

interface TriStateInput {
  input_safe: boolean;
  has_required_info: boolean;
  provider_available: boolean;
  has_fallback: boolean;
  risk_level: "none" | "low" | "medium" | "high";
  missing_info: string[];
  reason?: string;
}

interface TriStateResult {
  state: TriState;
  reason: string;
}

export function evaluateTriState(input: TriStateInput): TriStateResult {
  if (!input.input_safe || input.risk_level === "high") {
    return {
      state: "ABORT",
      reason: input.reason || "Unsafe or policy-blocked request",
    };
  }

  if (input.missing_info.length > 0) {
    return {
      state: "HOLD",
      reason: `Missing required information: ${input.missing_info.join(", ")}`,
    };
  }

  if (!input.provider_available && !input.has_fallback) {
    return {
      state: "HOLD",
      reason: "No LLM provider available and no fallback configured",
    };
  }

  return {
    state: "GO",
    reason: "Safe, sufficient information, provider available",
  };
}
