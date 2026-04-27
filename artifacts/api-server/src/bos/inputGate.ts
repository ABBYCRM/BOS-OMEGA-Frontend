import type { TriState } from "./types.js";

/**
 * Input gate — runtime safety / validity layer.
 *
 * BOP.CANON_GOVERNANCE.v1: this gate now ONLY blocks for actual system
 * reasons (per the runtime execution rule):
 *   - empty / whitespace input            → ABORT (invalid request body)
 *   - hard safety policy violations       → ABORT (safety layer)
 *
 * It DOES NOT block on "missing context", "vague input", or any other
 * model-uncertainty signal. Those are routed to the model, which is
 * governed by Canon to label them HOLD in its OWN output if appropriate.
 * Runtime never decides Tri-State based on input shape.
 */

const UNSAFE_PATTERNS = [
  /\b(hack|crack|exploit|bypass)\b.*\b(system|server|database|account)\b/i,
  /\b(create|generate|make|build)\b.*\b(malware|virus|ransomware|trojan|spyware)\b/i,
  /\b(synthesize|make|cook)\b.*\b(drugs|meth|fentanyl|explosives)\b/i,
  /\b(how to|steps to)\b.*\b(kill|harm|hurt|attack)\b.*\b(person|people|human)\b/i,
  /\b(steal|phish|social engineer)\b.*\b(credentials|passwords|data)\b/i,
  /child.*(sexual|pornograph|exploit)/i,
];

interface InputGateResult {
  state: TriState;
  sanitized_input: string;
  intent: string;
  risk_level: "none" | "low" | "medium" | "high";
  missing_info: string[];
  reason?: string;
}

export function runInputGate(rawInput: string): InputGateResult {
  const sanitized = sanitizeInput(rawInput);

  // Empty input is an INVALID REQUEST — there is nothing for the model
  // to act on. This is one of the runtime-allowed block reasons.
  if (!sanitized || sanitized.trim().length === 0) {
    return {
      state: "ABORT",
      sanitized_input: sanitized,
      intent: "unknown",
      risk_level: "none",
      missing_info: ["input_text"],
      reason: "Empty input",
    };
  }

  // Hard safety policy. This is the platform safety layer the runtime IS
  // allowed to enforce. Everything else falls through to the model.
  for (const pattern of UNSAFE_PATTERNS) {
    if (pattern.test(sanitized)) {
      return {
        state: "ABORT",
        sanitized_input: sanitized,
        intent: "unsafe",
        risk_level: "high",
        missing_info: [],
        reason: "Unsafe request detected",
      };
    }
  }

  // BOP.CANON_GOVERNANCE.v1: previously this returned HOLD for short or
  // vague inputs ("help", "tell me", < 6 chars). That was a hardcoded
  // Tri-State runtime gate. Removed — the model handles short/vague
  // inputs through Canon-governed conversational behavior.
  const intent = detectIntent(sanitized);
  const risk = assessRisk(sanitized);

  return {
    state: "GO",
    sanitized_input: sanitized,
    intent,
    risk_level: risk,
    missing_info: [],
  };
}

function sanitizeInput(input: string): string {
  return input
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/<script[^>]*>.*?<\/script>/gis, "[SCRIPT_REMOVED]")
    .replace(/javascript:/gi, "[JS_REMOVED]:")
    .trim()
    .slice(0, 32000);
}

function detectIntent(input: string): string {
  const lower = input.toLowerCase();
  if (/\b(code|function|program|script|debug|error|compile)\b/.test(lower)) return "code";
  if (/\b(legal|law|contract|liability|regulation|compliance)\b/.test(lower)) return "legal";
  if (/\b(calculate|solve|compute|equation|math|formula)\b/.test(lower)) return "math";
  if (/\b(research|study|analyze|compare|evidence|data)\b/.test(lower)) return "research";
  if (/\b(summarize|summary|tldr|overview|brief)\b/.test(lower)) return "summarization";
  if (/\b(extract|parse|find|identify|list all)\b/.test(lower)) return "extraction";
  if (/\b(plan|strategy|roadmap|steps|how should|approach)\b/.test(lower)) return "planning";
  if (/\b(write|create|story|poem|creative|imagine)\b/.test(lower)) return "creative";
  if (/\b(safe|unsafe|appropriate|ethical|review|check)\b/.test(lower)) return "safety_review";
  return "general";
}

function assessRisk(input: string): "none" | "low" | "medium" | "high" {
  const lower = input.toLowerCase();
  if (/\b(confidential|private|secret|proprietary)\b/.test(lower)) return "medium";
  if (/\b(dangerous|illegal|criminal|weapon)\b/.test(lower)) return "medium";
  return "low";
}
