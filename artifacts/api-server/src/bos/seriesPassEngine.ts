import { db } from "@workspace/db";
import {
  executionRunsTable,
  seriesPassesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import type { BosOutput, ModelScore, TaskContext, ValidationReport } from "./types.js";
import { validateOutput, extractJsonCandidate } from "./validationEngine.js";
import { repairOutput } from "./repairEngine.js";
import { auditLog } from "./auditEngine.js";
import { callProviderDirect } from "./providerBridge.js";
import { recordSuccess, recordFailure } from "./circuitBreaker.js";
import { MOCK_MODE_NOTICE, buildPersonaSystemSuffix } from "../providers/prompts.js";
// Follow-up #41: pure helper lives in a no-deps module so unit tests can
// import it without dragging @workspace/db. Re-exported here so existing
// callers that import from seriesPassEngine.ts still work.
import { assessSeriesPassFinalState } from "./finalStateHelpers.js";
export { assessSeriesPassFinalState };

export type SeriesRole = "DRAFTER" | "CRITIC" | "EXPANDER" | "ADVERSARY" | "SYNTHESIZER" | "OMEGA_VALIDATOR";

const SERIES_ROLES: SeriesRole[] = ["DRAFTER", "CRITIC", "EXPANDER", "ADVERSARY", "SYNTHESIZER"];

const ROLE_INSTRUCTIONS: Record<SeriesRole, string> = {
  DRAFTER: `You are the DRAFTER. Build the first complete, well-structured answer to the user's task.
Be direct, comprehensive, and clear. Do not over-optimize. Write a full initial answer.`,

  CRITIC: `You are the CRITIC. You have the original task AND a draft answer from the previous model.
Your job: find every error, missing section, ambiguity, and weak point in the previous answer.
Then REPAIR and IMPROVE the answer — don't just list problems. Return the improved answer.`,

  EXPANDER: `You are the EXPANDER. You have the original task AND the current best answer.
Your job: deepen the architecture, add edge cases, add failure modes, add implementation detail.
Fill every gap. Expand every section that is too shallow. Return the expanded answer.`,

  ADVERSARY: `You are the ADVERSARY. You have the original task AND the current best answer.
Your job: attack assumptions, detect hallucinations, detect weak logic, detect unsupported claims.
Then CORRECT every problem you found. Return the hardened, corrected answer.`,

  SYNTHESIZER: `You are the SYNTHESIZER. You have the original task AND the refined answer from previous passes.
Your job: merge the strongest parts, remove contradictions, compress noise.
Produce the definitive, clean, final answer. This is the version that will be released.`,

  OMEGA_VALIDATOR: `You are the OMEGA VALIDATOR. You have the final answer.
Perform a final schema, safety, completeness, and no-drift pass.
Return your assessment in the standard BOS JSON format. Release only if everything passes.`,
};

function buildSeriesPrompt(
  original_task: string,
  previous_answer: string | null,
  validation_notes: string[],
  role: SeriesRole,
  pass_number: number,
  total_passes: number,
): string {
  const role_instruction = ROLE_INSTRUCTIONS[role];

  let prompt = `=== BOS-OMEGA SERIES PASS ${pass_number}/${total_passes} | ROLE: ${role} ===\n\n`;
  prompt += `${role_instruction}\n\n`;
  prompt += `=== ORIGINAL USER TASK ===\n${original_task}\n\n`;

  if (previous_answer) {
    prompt += `=== CURRENT BEST ANSWER (from previous pass) ===\n${previous_answer}\n\n`;
  }

  if (validation_notes.length > 0) {
    prompt += `=== VALIDATION NOTES FROM PREVIOUS PASSES ===\n${validation_notes.join("\n")}\n\n`;
  }

  prompt += `=== YOUR OUTPUT REQUIREMENTS ===
Return a JSON object with this exact structure:
{
  "state": "GO" | "HOLD" | "ABORT",
  "task_type": "${role === "OMEGA_VALIDATOR" ? "validation" : "general"}",
  "answer": "your complete improved answer here",
  "assumptions": ["list of assumptions made"],
  "uncertainties": ["list of remaining uncertainties"],
  "missing_inputs": ["list of information that would improve the answer"],
  "failure_modes": ["list of ways this answer could be wrong"],
  "recommended_next_action": "what should be done next",
  "pass_role": "${role}",
  "errors_found": ["list of errors found in previous answer (if applicable)"]
}`;

  return prompt;
}

export interface SeriesPassResult {
  run_id: string;
  final_output: BosOutput;
  passes: Array<{
    pass_number: number;
    role: SeriesRole;
    provider: string;
    model: string;
    state: string;
    validation_score: number;
    errors_found: string[];
    latency_ms: number;
    /** Follow-up #41: explicit success flag from the underlying call (mock-mode failure → false) */
    success: boolean;
  }>;
}

export async function runSeriesPass(
  ctx: TaskContext,
  models: ModelScore[],
): Promise<{ result: BosOutput; run_id: string }> {
  const run_id = randomUUID();

  // Create execution run record
  const selected_model_names = models.slice(0, SERIES_ROLES.length).map((m) => `${m.provider_name}/${m.model_name}`);
  await db.insert(executionRunsTable).values({
    id: run_id,
    task_id: ctx.task_id,
    mode: "series_pass",
    status: "running",
    total_passes: Math.min(models.length, SERIES_ROLES.length),
    models_used: selected_model_names,
  });

  await auditLog(ctx.task_id, "SERIES_PASS_STARTED", `Starting series pass with ${selected_model_names.length} models`);

  let current_answer: string | null = null;
  const validation_notes: string[] = [];
  const pass_results: SeriesPassResult["passes"] = [];

  // Distribute models across series roles. We require at least 2 distinct
  // models — series-pass with a single model collapses to "model A critiquing
  // model A's draft for 5 rounds" which is precisely the failure mode the
  // architecture is designed to avoid (audit H-2). The pipeline is responsible
  // for choosing a fallback when this throws.
  if (models.length < 2) {
    throw new Error(
      `series-pass requires >= 2 distinct models for role diversity (got ${models.length})`,
    );
  }
  const pass_models = models.slice(0, SERIES_ROLES.length);
  // If fewer models than roles, rotate through the available pool. Adjacent
  // roles will collide for very small pools (2 models -> ABABA), but at least
  // every role gets a different *neighbor* model.
  while (pass_models.length < SERIES_ROLES.length) {
    pass_models.push(models[pass_models.length % models.length]!);
  }

  for (let i = 0; i < SERIES_ROLES.length; i++) {
    const role = SERIES_ROLES[i]!;
    const model_info = pass_models[i]!;
    const pass_number = i + 1;

    await auditLog(ctx.task_id, "SERIES_PASS_STEP", `Pass ${pass_number}/${SERIES_ROLES.length}: ${role} via ${model_info.provider_name}/${model_info.model_name}`);

    const prompt = buildSeriesPrompt(
      ctx.input,
      current_answer,
      validation_notes,
      role,
      pass_number,
      SERIES_ROLES.length,
    );

    const start_time = Date.now();
    const call_result = await callProviderDirect(prompt, "series_pass", model_info, {
      attachment_context: ctx.attachment_context,
      attachment_images: ctx.attachment_images,
      persona_prompt: buildPersonaSystemSuffix(ctx.persona) || undefined,
      task_id: ctx.task_id,
    });
    const latency_ms = Date.now() - start_time;

    // Follow-up #41: keep provider_health/circuit-breaker counters
    // consistent with single/parallel execution paths. Mock-mode failures
    // (R-5.4: success:false from no-key path) accrue here just like real
    // provider outages, so the breaker accurately reflects unusable
    // providers regardless of which engine the call came from.
    if (call_result.success) {
      await recordSuccess(model_info.provider_id, latency_ms);
    } else {
      await recordFailure(model_info.provider_id, call_result.error_type || "unknown_exception");
    }

    const pass_id = randomUUID();
    let pass_output: BosOutput | null = null;
    let validation: ValidationReport | null = null;
    let errors_found: string[] = [];
    let state: string = "GO";
    let validation_score = 0.5;

    if (call_result.success && call_result.raw_response) {
      validation = validateOutput(call_result.raw_response, ctx.task_type);
      validation_score = validation.confidence_score;

      // Parse the output via shared hardened extractor (fenced + balanced-brace)
      try {
        const candidate = extractJsonCandidate(call_result.raw_response);
        if (candidate) {
          const parsed = JSON.parse(candidate) as Partial<BosOutput> & { errors_found?: string[]; pass_role?: string };
          errors_found = Array.isArray(parsed.errors_found) ? parsed.errors_found : [];
          state = parsed.state || "GO";
          pass_output = {
            state: (["GO", "HOLD", "ABORT"].includes(state) ? state : "GO") as BosOutput["state"],
            task_type: parsed.task_type || ctx.task_type,
            answer: parsed.answer || call_result.raw_response,
            assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions : [],
            uncertainties: Array.isArray(parsed.uncertainties) ? parsed.uncertainties : [],
            missing_inputs: Array.isArray(parsed.missing_inputs) ? parsed.missing_inputs : [],
            failure_modes: Array.isArray(parsed.failure_modes) ? parsed.failure_modes : [],
            recommended_next_action: parsed.recommended_next_action || "Review pass output",
          };
        }
      } catch {}

      if (!pass_output) {
        pass_output = {
          state: "GO",
          task_type: ctx.task_type,
          answer: call_result.raw_response.slice(0, 3000),
          assumptions: [],
          uncertainties: ["Response parsing incomplete"],
          missing_inputs: [],
          failure_modes: [],
          recommended_next_action: "Review raw output",
        };
      }

      if (validation_notes.length < 5) {
        validation_notes.push(`Pass ${pass_number} (${role}): score=${validation_score.toFixed(2)}, errors=[${errors_found.slice(0, 2).join(", ")}]`);
      }

      // ABORT propagation
      if (state === "ABORT") {
        await db.insert(seriesPassesTable).values({
          id: pass_id,
          run_id,
          pass_number,
          provider: model_info.provider_name,
          model: model_info.model_name,
          role,
          input_snapshot: prompt.slice(0, 1000),
          output_snapshot: call_result.raw_response.slice(0, 2000),
          validation_score,
          errors_found,
          state: "ABORT",
          latency_ms,
        });
        await db.update(executionRunsTable).set({ status: "aborted", completed_at: new Date() }).where(eq(executionRunsTable.id, run_id));
        await auditLog(ctx.task_id, "SERIES_PASS_ABORTED", `Pass ${pass_number} returned ABORT — halting series`);
        return {
          result: { ...pass_output, state: "ABORT" },
          run_id,
        };
      }

      // Update current answer for next pass
      current_answer = pass_output.answer;
    } else {
      // Provider failed — use previous answer if available, note the error
      state = "HOLD";
      validation_score = 0.3;
      errors_found = [`Provider error: ${call_result.error_type || "unknown"}`];
      validation_notes.push(`Pass ${pass_number} (${role}): FAILED — ${call_result.error_type}`);
    }

    await db.insert(seriesPassesTable).values({
      id: pass_id,
      run_id,
      pass_number,
      provider: model_info.provider_name,
      model: model_info.model_name,
      role,
      input_snapshot: prompt.slice(0, 1000),
      output_snapshot: (call_result.raw_response || call_result.error_message || "").slice(0, 2000),
      validation_score,
      errors_found,
      state,
      latency_ms,
    });

    pass_results.push({
      pass_number,
      role,
      provider: model_info.provider_name,
      model: model_info.model_name,
      state,
      validation_score,
      errors_found,
      latency_ms,
      success: call_result.success,
    });
  }

  // Follow-up #41: gate the final state on actual pass success. The pure
  // helper (assessSeriesPassFinalState) returns HOLD whenever no pass
  // produced a real GO output — this prevents mock-mode/no-key failures
  // from masquerading as a confident final answer (R-5.4 contract).
  const assessment = assessSeriesPassFinalState(
    pass_results.map((p) => ({ state: p.state, success: p.success })),
  );

  let final_answer: string;
  let final_failure_modes: string[] = [];
  let final_recommended: string;
  if (assessment.final_state === "HOLD") {
    final_answer = current_answer
      ? `${MOCK_MODE_NOTICE}\n\nSeries pass degraded — no pass produced a real GO answer (${assessment.failed_count} failed / ${assessment.succeeded_count} non-GO of ${pass_results.length}). The text below is the last available draft and is not validated.\n\n${current_answer}`
      : `Series pass could not produce a final answer (${assessment.failed_count} failed of ${pass_results.length}). All passes returned mock-mode/no-key failures or provider errors.`;
    final_failure_modes = [
      `Series pass degraded: ${assessment.reason}`,
      `${assessment.failed_count} of ${pass_results.length} passes failed`,
    ];
    final_recommended = "Configure provider API keys, check provider health, or rerun with a different mode.";
    await auditLog(
      ctx.task_id,
      "SERIES_PASS_DEGRADED",
      `Series pass degraded to HOLD — ${assessment.reason} (${assessment.failed_count}/${pass_results.length} failed, ${assessment.succeeded_count} non-GO)`,
      {
        reason: assessment.reason,
        failed_count: assessment.failed_count,
        succeeded_count: assessment.succeeded_count,
        total_passes: pass_results.length,
      },
    );
  } else {
    final_answer = current_answer || "Series pass could not produce a final answer.";
    final_recommended = "Review the series-refined answer above";
  }

  const final_output: BosOutput = {
    state: assessment.final_state,
    task_type: ctx.task_type,
    answer: final_answer,
    assumptions: [],
    uncertainties: assessment.final_state === "HOLD"
      ? [`${assessment.failed_count}/${pass_results.length} passes failed (${assessment.reason})`]
      : [],
    missing_inputs: [],
    failure_modes: final_failure_modes,
    recommended_next_action: final_recommended,
    merge_strategy: "series_pass_5_roles",
    parallel_responses: pass_results.map((p) => ({
      provider: p.provider,
      model: `${p.model} (${p.role})`,
      state: p.state as "GO" | "HOLD" | "ABORT",
      answer: `Pass ${p.pass_number}: ${p.role}`,
      confidence_score: p.validation_score,
      latency_ms: p.latency_ms,
      selected: p.pass_number === SERIES_ROLES.length,
    })),
  };

  await db.update(executionRunsTable)
    .set({
      status: "completed",
      completed_at: new Date(),
      final_score: pass_results.reduce((sum, p) => sum + p.validation_score, 0) / pass_results.length,
    })
    .where(eq(executionRunsTable.id, run_id));

  await auditLog(ctx.task_id, "SERIES_PASS_COMPLETED", `Series pass completed — ${pass_results.length} passes`, {
    avg_score: (pass_results.reduce((s, p) => s + p.validation_score, 0) / pass_results.length).toFixed(2),
  });

  return { result: final_output, run_id };
}
