/**
 * Task #67 — Lattice continuity scratchpad summary builder.
 *
 * Pure, dependency-free helper that turns a completed BOS task into the
 * (title, content) pair we persist into memory_items as a scratchpad row
 * with source="auto_summary". Kept side-effect-free so the bare-node
 * unit tests in tests/scratchpad_unit.mjs can import and exercise it
 * without the @workspace/db package being in the resolver path.
 *
 * The output respects the **2–3 sentence summary contract** documented
 * in the canon row "BOS-OMEGA Scratchpad Summary Contract":
 *
 *   1) Sentence one identifies the task (id + type) and its tri-state.
 *   2) Sentence two is what the user asked (truncated).
 *   3) Sentence three is the answer head (truncated).
 *   4) Optional fourth sentence appends Uncertainties / Assumptions when
 *      the underlying BosOutput surfaced any — this keeps the row useful
 *      to the next task without breaking the constrained-summary shape.
 *
 * The deterministic format below IS the writer in mock-mode and as the
 * non-fatal fallback in production. An LLM-driven summariser layered on
 * top is an explicit follow-up; the spec accepts the deterministic
 * fallback as the writer of record so mock-mode and offline test
 * environments see the same contract output as production.
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
const INPUT_PREVIEW_MAX = 180;
const ANSWER_PREVIEW_MAX = 280;
const LIST_MAX = 3;

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function firstLine(s: string): string {
  return (s.split("\n")[0] ?? "").trim();
}

/**
 * Squash any embedded newlines so the summary stays a single paragraph.
 * This is a contract requirement — the canon row tells the model these
 * rows are short prose, not structured logs, so multi-line content would
 * confuse downstream re-ranking and reflow.
 */
function inline(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function buildAutoSummary(inputs: SummaryInputs): { title: string; content: string } {
  const answer = (inputs.answer ?? "").trim();
  const input = (inputs.input_text ?? "").trim();
  const head = firstLine(answer);

  // Sentence 1 — identify the task.
  const s1 = `Task ${inputs.task_id} (${inputs.task_type}) completed with state ${inputs.state}.`;
  // Sentence 2 — what the user asked.
  const s2 = input
    ? `User asked: ${truncate(inline(input), INPUT_PREVIEW_MAX)}.`
    : "User input was empty.";
  // Sentence 3 — the answer head.
  const s3 = answer
    ? `Answer: ${truncate(inline(answer), ANSWER_PREVIEW_MAX)}.`
    : "Answer was empty.";

  const sentences = [s1, s2, s3];

  // Sentence 4 (optional) — collapse uncertainties/assumptions onto a
  // single trailing clause so we never exceed four sentences.
  const tail_parts: string[] = [];
  if (inputs.uncertainties && inputs.uncertainties.length > 0) {
    tail_parts.push(`uncertainties — ${inputs.uncertainties.slice(0, LIST_MAX).join("; ")}`);
  }
  if (inputs.assumptions && inputs.assumptions.length > 0) {
    tail_parts.push(`assumptions — ${inputs.assumptions.slice(0, LIST_MAX).join("; ")}`);
  }
  if (tail_parts.length > 0) {
    sentences.push(`Notes: ${tail_parts.join(" | ")}.`);
  }

  const content = sentences.join(" ");

  // Title: first non-empty line of the answer (truncated) or fall back
  // to a task-id stub. Either way, no embedded newlines.
  const title = head
    ? `Auto: ${truncate(inline(head), TITLE_HEAD_MAX)}`
    : `Auto: task ${inputs.task_id.slice(0, 8)}`;

  return { title, content };
}
