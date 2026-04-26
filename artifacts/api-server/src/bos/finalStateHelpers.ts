/**
 * Follow-up #41: pure helpers that decide the final state of series_pass
 * and boil_the_ocean runs from per-call success signals.
 *
 * Kept in a dependency-free module so the unit test harness
 * (`node --experimental-strip-types tests/r1_r5_unit.mjs`) can import
 * them without dragging in @workspace/db.
 *
 * Contract: neither mode may emit GO when every (or every critical)
 * underlying call was a mock-mode/no-key failure (R-5.4 contract).
 */

export interface SeriesPassFinalAssessment {
  final_state: "GO" | "HOLD";
  reason:
    | "no_passes_executed"
    | "all_passes_failed"
    | "no_pass_returned_GO"
    | "at_least_one_GO_pass";
  failed_count: number;
  succeeded_count: number;
}

/**
 * The series cannot honestly emit GO if every pass produced a non-GO state
 * (HOLD/ABORT/FAILED), because that means no model ever produced a real,
 * validated answer — current_answer would either be null or stale-from-a-
 * failed-attempt.
 */
export function assessSeriesPassFinalState(
  passes: Array<{ state: string; success: boolean }>,
): SeriesPassFinalAssessment {
  const failed = passes.filter((p) => !p.success);
  const succeeded_with_go = passes.filter((p) => p.success && p.state === "GO");

  if (passes.length === 0) {
    return { final_state: "HOLD", reason: "no_passes_executed", failed_count: 0, succeeded_count: 0 };
  }
  if (succeeded_with_go.length === 0) {
    return {
      final_state: "HOLD",
      reason: failed.length === passes.length ? "all_passes_failed" : "no_pass_returned_GO",
      failed_count: failed.length,
      succeeded_count: passes.length - failed.length,
    };
  }
  return {
    final_state: "GO",
    reason: "at_least_one_GO_pass",
    failed_count: failed.length,
    succeeded_count: passes.length - failed.length,
  };
}

export interface BtoFinalAssessment {
  final_state: "GO" | "HOLD";
  reason:
    | "all_agents_failed"
    | "synthesis_failed"
    | "no_agents_dispatched"
    | "synthesis_succeeded";
}

/**
 * BTO already short-circuits to HOLD when zero agents succeed, but the
 * synthesis call itself can still fall into mock mode (success:false from
 * R-5.4). When that happens, the synthesis "answer" is just the no-key
 * placeholder text — emitting GO with a placeholder is exactly the
 * mock-as-success leak this follow-up exists to close.
 */
export function assessBtoFinalState(args: {
  successful_agents: number;
  total_agents: number;
  synthesis_success: boolean;
}): BtoFinalAssessment {
  if (args.successful_agents === 0) {
    return { final_state: "HOLD", reason: "all_agents_failed" };
  }
  if (!args.synthesis_success) {
    return { final_state: "HOLD", reason: "synthesis_failed" };
  }
  if (args.total_agents === 0) {
    return { final_state: "HOLD", reason: "no_agents_dispatched" };
  }
  return { final_state: "GO", reason: "synthesis_succeeded" };
}
