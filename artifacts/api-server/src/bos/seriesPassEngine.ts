import { db } from "@workspace/db";
import {
  executionRunsTable,
  seriesPassesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import type { BosOutput, ModelScore, TaskContext, ValidationReport } from "./types.js";
import { validateOutput } from "./validationEngine.js";
import { repairOutput } from "./repairEngine.js";
import { auditLog } from "./auditEngine.js";
import { callProviderDirect } from "./providerBridge.js";
import { MOCK_MODE_NOTICE } from "../providers/prompts.js";

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

  // Distribute models across series roles
  const pass_models = models.slice(0, SERIES_ROLES.length);
  // If fewer models than roles, reuse from the beginning
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
    const call_result = await callProviderDirect(prompt, "series_pass", model_info);
    const latency_ms = Date.now() - start_time;

    const pass_id = randomUUID();
    let pass_output: BosOutput | null = null;
    let validation: ValidationReport | null = null;
    let errors_found: string[] = [];
    let state: string = "GO";
    let validation_score = 0.5;

    if (call_result.success && call_result.raw_response) {
      validation = validateOutput(call_result.raw_response, ctx.task_type);
      validation_score = validation.confidence_score;

      // Parse the output
      try {
        const match = call_result.raw_response.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]) as Partial<BosOutput> & { errors_found?: string[]; pass_role?: string };
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
    });
  }

  // Build final output
  const final_answer = current_answer || "Series pass could not produce a final answer.";
  const final_output: BosOutput = {
    state: "GO",
    task_type: ctx.task_type,
    answer: final_answer,
    assumptions: [],
    uncertainties: [],
    missing_inputs: [],
    failure_modes: [],
    recommended_next_action: "Review the series-refined answer above",
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
