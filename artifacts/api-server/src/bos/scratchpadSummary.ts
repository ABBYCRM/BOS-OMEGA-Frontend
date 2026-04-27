/**
 * Task #67 — Lattice continuity scratchpad summary builder.
 *
 * Pure, dependency-free helper that turns a completed BOS task into the
 * (title, content) pair we persist into memory_items as a scratchpad row
 * with source="auto_summary". Kept side-effect-free so the bare-node
 * unit tests in tests/scratchpad_unit.mjs can import and exercise it
 * without the @workspace/db package being in the resolver path.
 *
 * The output respects the **strict 2–3 sentence summary contract**
 * defined in the canon row "BOS-OMEGA Scratchpad Summary Contract":
 *
 *   1) Sentence one identifies the task (id, type, tri-state) and the
 *      head of the user's request.
 *   2) Sentence two is the head of the answer.
 *   3) Sentence three (OPTIONAL) folds the top uncertainty / assumption
 *      into a single trailing clause. The writer NEVER emits a fourth
 *      sentence — exceeding three sentences is a contract violation
 *      enforced by tests/scratchpad_unit.mjs.
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
const INPUT_PREVIEW_MAX = 140;
const ANSWER_PREVIEW_MAX = 240;
const NOTE_PREVIEW_MAX = 140;

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

/**
 * Strip sentence-terminating punctuation from interpolated user text so
 * the writer's structural sentence count is preserved regardless of the
 * punctuation in the request, answer, or notes. Without this, an input
 * like "A. B." would produce two extra sentence boundaries inside the
 * "request" clause and silently breach the 2–3 sentence ceiling.
 *
 * We replace `.`, `!`, `?` (and the unicode `…`) with spaces, then
 * collapse runs of whitespace. The ellipsis we ourselves add via
 * `truncate()` is re-applied AFTER this pass at the call site, so its
 * sentinel character is never interpolated into prose by mistake.
 */
function stripTerminators(s: string): string {
  return s.replace(/[.!?…]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Apply both transforms (`inline` then `stripTerminators`) and then
 * truncate. Keeping the order strict here matters: truncating first
 * could place an ellipsis inside the prose that `stripTerminators`
 * would then erase.
 */
function preview(s: string, n: number): string {
  return truncate(stripTerminators(inline(s)), n);
}

export function buildAutoSummary(inputs: SummaryInputs): { title: string; content: string } {
  const answer = (inputs.answer ?? "").trim();
  const input = (inputs.input_text ?? "").trim();
  const head = firstLine(answer);

  // Sentence 1 — identify the task AND fold in the user's request head.
  // Combining task identity with the request keeps the summary at 2–3
  // sentences while still surfacing the prompt entity for downstream
  // relevance scoring. Embedded user text is run through `preview()`
  // which strips sentence terminators (`.!?…`) so the structural
  // sentence count cannot be inflated by punctuation in the request.
  const request_clause = input
    ? ` for request "${preview(input, INPUT_PREVIEW_MAX)}"`
    : ` (no input text)`;
  const s1 = `Task ${inputs.task_id} (${inputs.task_type}) completed with state ${inputs.state}${request_clause}.`;

  // Sentence 2 — the answer head. Same terminator-stripping rationale
  // as sentence 1: a multi-sentence answer must not turn into multiple
  // structural sentences inside the summary.
  const s2 = answer
    ? `Answer: ${preview(answer, ANSWER_PREVIEW_MAX)}.`
    : "Answer was empty.";

  // Sentence 3 (OPTIONAL) — fold the single most-relevant note. We
  // deliberately pick ONE item (uncertainty wins over assumption) so the
  // summary stays at most three sentences. Multiple notes are dropped
  // here on purpose; the canon row tells the model that auto-summaries
  // are lossy by design and that full task detail lives in /api/tasks.
  const top_uncertainty = inputs.uncertainties?.find((u) => u && u.trim().length > 0);
  const top_assumption = inputs.assumptions?.find((a) => a && a.trim().length > 0);
  const top_note = top_uncertainty
    ? { label: "uncertainty", text: top_uncertainty }
    : top_assumption
      ? { label: "assumption", text: top_assumption }
      : null;

  const sentences = [s1, s2];
  if (top_note) {
    sentences.push(
      `Top ${top_note.label}: ${preview(top_note.text, NOTE_PREVIEW_MAX)}.`,
    );
  }

  const content = sentences.join(" ");

  // Title: first non-empty line of the answer (truncated) or fall back
  // to a task-id stub. Either way, no embedded newlines.
  const title = head
    ? `Auto: ${truncate(inline(head), TITLE_HEAD_MAX)}`
    : `Auto: task ${inputs.task_id.slice(0, 8)}`;

  return { title, content };
}
