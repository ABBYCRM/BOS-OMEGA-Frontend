import type { BosOutput, ValidationReport } from "./types.js";

const UNSAFE_OUTPUT_PATTERNS = [
  /\b(here is how to make|instructions for making|step.by.step.*bomb|synthesize.*drug)\b/i,
  /\b(hack into|break into|gain unauthorized access)\b/i,
];

export function validateOutput(
  raw: string,
  expected_task_type?: string
): ValidationReport {
  let parsed: BosOutput | null = null;
  let schema_pass = false;

  const candidate = extractJsonCandidate(raw);
  if (candidate) {
    try {
      parsed = JSON.parse(candidate) as BosOutput;
      schema_pass = validateSchema(parsed);
    } catch {
      schema_pass = false;
    }
  }

  const safety_pass = checkSafety(raw);
  const instruction_pass = parsed ? checkInstructions(parsed, expected_task_type) : false;
  const completeness_pass = parsed ? checkCompleteness(parsed) : false;
  const confidence_score = computeConfidence(parsed, schema_pass, safety_pass, instruction_pass, completeness_pass);

  const notes = buildNotes(schema_pass, safety_pass, instruction_pass, completeness_pass, parsed);

  return {
    schema_pass,
    safety_pass,
    instruction_pass,
    completeness_pass,
    confidence_score,
    notes,
    passed: schema_pass && safety_pass && instruction_pass && completeness_pass && confidence_score >= 0.5,
  };
}

/**
 * Robustly extract a JSON object string from an LLM raw response.
 *
 * Strategies tried in order (audit H-3 — fragile single-regex was misparsing
 * fenced blocks and merging unrelated brace pairs across prose):
 *   1) ```json … ``` fenced block (most explicit)
 *   2) bare ``` … ``` fenced block
 *   3) balanced-brace scan from the first `{`, depth-tracked, with proper
 *      string-literal handling so braces inside strings don't confuse us.
 *
 * Returns the candidate substring (suitable for JSON.parse) or null.
 */
export function extractJsonCandidate(raw: string): string | null {
  // 1) ```json … ```
  const fencedJson = raw.match(/```json\s*([\s\S]*?)```/i);
  if (fencedJson?.[1]) {
    const trimmed = fencedJson[1].trim();
    if (trimmed.startsWith("{")) return trimmed;
  }
  // 2) ``` … ```
  const fencedAny = raw.match(/```\s*([\s\S]*?)```/);
  if (fencedAny?.[1]) {
    const trimmed = fencedAny[1].trim();
    if (trimmed.startsWith("{")) return trimmed;
  }
  // 3) Balanced-brace scan
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let in_string = false;
  let escape = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]!;
    if (in_string) {
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') { in_string = false; }
      continue;
    }
    if (ch === '"') { in_string = true; continue; }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

function validateSchema(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  if (!["GO", "HOLD", "ABORT"].includes(o["state"] as string)) return false;
  if (typeof o["answer"] !== "string") return false;
  if (typeof o["task_type"] !== "string") return false;
  return true;
}

function checkSafety(raw: string): boolean {
  for (const pattern of UNSAFE_OUTPUT_PATTERNS) {
    if (pattern.test(raw)) return false;
  }
  return true;
}

function checkInstructions(parsed: BosOutput, expected_task_type?: string): boolean {
  if (!parsed.state || !parsed.answer) return false;
  if (parsed.answer.length < 5) return false;
  return true;
}

function checkCompleteness(parsed: BosOutput): boolean {
  if (!parsed.answer || parsed.answer.trim().length < 10) return false;
  if (!parsed.recommended_next_action) return false;
  return true;
}

function computeConfidence(
  parsed: BosOutput | null,
  schema_pass: boolean,
  safety_pass: boolean,
  instruction_pass: boolean,
  completeness_pass: boolean
): number {
  let score = 0;
  if (schema_pass) score += 0.3;
  if (safety_pass) score += 0.3;
  if (instruction_pass) score += 0.2;
  if (completeness_pass) score += 0.2;

  if (parsed && parsed.uncertainties && parsed.uncertainties.length > 2) {
    score *= 0.8;
  }
  if (parsed && parsed.failure_modes && parsed.failure_modes.length > 0) {
    score *= 0.9;
  }

  return Math.min(Math.max(score, 0), 1);
}

function buildNotes(
  schema: boolean,
  safety: boolean,
  instruction: boolean,
  completeness: boolean,
  parsed: BosOutput | null
): string {
  const issues: string[] = [];
  if (!schema) issues.push("schema_failure");
  if (!safety) issues.push("unsafe_output");
  if (!instruction) issues.push("instruction_drift");
  if (!completeness) issues.push("incomplete_answer");
  if (issues.length === 0) return "All validation checks passed";
  return `Issues: ${issues.join(", ")}`;
}
