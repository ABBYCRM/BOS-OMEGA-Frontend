/**
 * #43: Pure consensus / parallel merge logic.
 *
 * This module is intentionally dependency-free (no DB, no audit, no I/O)
 * so that the r1_r5_unit harness can import `mergeParallelResponses` and
 * exhaustively assert the deterministic merge rules:
 *   - all-GO: state=GO, merge_strategy="majority_vote_consensus", highest-
 *     confidence response gets selected:true.
 *   - any ABORT: vetoes consensus, the actual aborter (not the lowest-
 *     confidence row) is the one marked selected:true.
 *
 * The corresponding executionEngine.ts exports re-export from here so
 * existing call sites continue to work.
 */
import type { BosOutput, ParallelResponse } from "./types.js";

export function synthesizeAnswers(answers: string[]): string {
  if (answers.length === 1) return answers[0]!;
  const unique = [...new Set(answers)];
  if (unique.length === 1) return unique[0]!;

  return answers
    .map((a, i) => `[Model ${i + 1}]:\n${a}`)
    .join("\n\n---\n\n") +
    "\n\n---\n\n[MERGED SYNTHESIS]: The above responses converge on the answer provided by the highest-confidence model.";
}

export function buildAbortOutput(reason: string): BosOutput {
  return {
    state: "ABORT",
    task_type: "safety_review",
    answer: `This request has been blocked by BOS-OMEGA safety policy. Reason: ${reason}`,
    assumptions: [],
    uncertainties: [],
    missing_inputs: [],
    failure_modes: [reason],
    recommended_next_action: "Review the request and try a different approach",
  };
}

export function mergeParallelResponses(responses: ParallelResponse[], mode: string): BosOutput {
  responses.sort((a, b) => b.confidence_score - a.confidence_score);

  if (mode === "consensus") {
    const go_count = responses.filter((r) => r.state === "GO").length;
    const abort_count = responses.filter((r) => r.state === "ABORT").length;
    const majority = Math.ceil(responses.length / 2);

    if (abort_count > 0) {
      // Audit-trace the response that actually drove the merger to ABORT —
      // not the lowest-confidence row, which is what `responses[length-1]`
      // pointed to after the descending sort above (audit C-1).
      const aborter = responses.find((r) => r.state === "ABORT") ?? responses[0]!;
      aborter.selected = true;
      const merged = buildAbortOutput("Consensus: at least one model flagged ABORT");
      // Preserve the parallel_responses array on the ABORT output so the
      // audit chain + UI can identify which response was selected as the
      // aborter. Without this, downstream consumers lose the selected flag.
      merged.parallel_responses = responses;
      merged.merge_strategy = "majority_vote_consensus";
      return merged;
    }

    const winning_state = go_count >= majority ? "GO" : "HOLD";
    const best = responses.filter((r) => r.state === winning_state)[0] || responses[0]!;
    best.selected = true;

    const merged_answer = synthesizeAnswers(responses.filter((r) => r.state === winning_state).map((r) => r.answer));

    return {
      state: winning_state,
      task_type: "general",
      answer: merged_answer,
      assumptions: [],
      uncertainties: responses.length < 3 ? ["Limited consensus sample"] : [],
      missing_inputs: [],
      failure_modes: [],
      recommended_next_action: "Review the consensus answer above",
      parallel_responses: responses,
      merge_strategy: "majority_vote_consensus",
    };
  }

  const best = responses[0]!;
  best.selected = true;

  const merged_answer = responses.length > 1
    ? synthesizeAnswers(responses.map((r) => r.answer))
    : best.answer;

  return {
    state: best.state,
    task_type: "general",
    answer: merged_answer,
    assumptions: [],
    uncertainties: [],
    missing_inputs: [],
    failure_modes: [],
    recommended_next_action: "Review the merged answer from multiple models above",
    parallel_responses: responses,
    merge_strategy: "best_confidence_merge",
  };
}
