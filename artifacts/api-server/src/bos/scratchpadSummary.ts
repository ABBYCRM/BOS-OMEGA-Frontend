/**
 * Task #67 — Lattice continuity scratchpad summary builder.
 *
 * Pure, dependency-free helper that turns a completed BOS task into the
 * (title, content) pair we persist into memory_items as a scratchpad row
 * with source="auto_summary". Kept side-effect-free so the bare-node
 * unit tests in tests/scratchpad_unit.mjs can import and exercise it
 * without the @workspace/db package being in the resolver path.
 *
 * The deterministic format below IS the writer for now. The Canon row
 * "BOS-OMEGA Scratchpad Summary Contract" describes the semantics the
 * model should give to these rows when they reappear in a later task's
 * scratchpad layer; an LLM-driven summariser is an explicit follow-up.
 * Mock-mode runs and offline test environments therefore see the same
 * output as production, which keeps the e2e round-trip predictable.
 */

export interface SummaryInputs {
  task_id: string;
  task_type: string;
  state: string;
  answer: string;
  input_text: string;
  assumptions?: string[];
  uncertainties?: string[];
}

const TITLE_HEAD_MAX = 80;
const INPUT_PREVIEW_MAX = 200;
const ANSWER_PREVIEW_MAX = 360;
const LIST_MAX = 3;

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function firstLine(s: string): string {
  return (s.split("\n")[0] ?? "").trim();
}

export function buildAutoSummary(inputs: SummaryInputs): { title: string; content: string } {
  const answer = (inputs.answer ?? "").trim();
  const input = (inputs.input_text ?? "").trim();
  const head = firstLine(answer);

  const lines: string[] = [];
  lines.push(`Task ${inputs.task_id} (${inputs.task_type}) — ${inputs.state}`);
  if (input) lines.push(`User asked: ${truncate(input, INPUT_PREVIEW_MAX)}`);
  if (answer) {
    lines.push(`Answer: ${truncate(answer, ANSWER_PREVIEW_MAX)}`);
  } else {
    lines.push("Answer: (empty)");
  }
  if (inputs.uncertainties && inputs.uncertainties.length > 0) {
    lines.push(`Uncertainties: ${inputs.uncertainties.slice(0, LIST_MAX).join(" · ")}`);
  }
  if (inputs.assumptions && inputs.assumptions.length > 0) {
    lines.push(`Assumptions: ${inputs.assumptions.slice(0, LIST_MAX).join(" · ")}`);
  }

  const title = head
    ? `Auto: ${truncate(head, TITLE_HEAD_MAX)}`
    : `Auto: task ${inputs.task_id.slice(0, 8)}`;

  return { title, content: lines.join("\n") };
}
