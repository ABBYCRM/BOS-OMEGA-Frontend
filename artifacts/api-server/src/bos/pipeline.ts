import { db } from "@workspace/db";
import { tasksTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import type { BosOutput, ExecutionMode, TaskContext, TriState } from "./types.js";
import { runInputGate } from "./inputGate.js";
import { classifyTask } from "./taskClassifier.js";
import { evaluateTriState } from "./triState.js";
import { selectModel } from "./modelRouter.js";
import { executePipeline } from "./executionEngine.js";
import { auditLog } from "./auditEngine.js";
import { logger } from "../lib/logger.js";

export interface PipelineInput {
  input: string;
  mode?: ExecutionMode;
  task_type_override?: string;
  parallel_models?: number;
}

export interface PipelineResult {
  task_id: string;
  tri_state: TriState;
  task_type: string;
  selected_provider?: string;
  selected_model?: string;
  final_status: string;
  bos_output: BosOutput;
}

export async function runBosPipeline(pipelineInput: PipelineInput): Promise<PipelineResult> {
  const task_id = randomUUID();
  const mode: ExecutionMode = pipelineInput.mode || "single";
  const parallel_count = mode === "single" ? 1 : (pipelineInput.parallel_models || 3);

  await auditLog(task_id, "TASK_RECEIVED", "Task received by BOS-OMEGA", { mode, input_length: pipelineInput.input.length });

  const gate = runInputGate(pipelineInput.input);
  await auditLog(task_id, "INPUT_GATE_RESULT", `Input gate: ${gate.state}`, { intent: gate.intent, risk: gate.risk_level });

  if (gate.state === "ABORT") {
    const output: BosOutput = {
      state: "ABORT",
      task_type: "safety_review",
      answer: `BOS-OMEGA ABORT: ${gate.reason}`,
      assumptions: [],
      uncertainties: [],
      missing_inputs: [],
      failure_modes: [gate.reason || "Policy violation"],
      recommended_next_action: "Review the request and ensure it complies with policy",
    };
    await saveTask(task_id, pipelineInput.input, "safety_review", "ABORT", mode, undefined, undefined, "ABORTED", JSON.stringify(output));
    await auditLog(task_id, "TASK_ABORTED", gate.reason || "Aborted by input gate");
    return { task_id, tri_state: "ABORT", task_type: "safety_review", final_status: "ABORTED", bos_output: output };
  }

  if (gate.state === "HOLD") {
    const output: BosOutput = {
      state: "HOLD",
      task_type: "general",
      answer: `BOS-OMEGA HOLD: ${gate.reason}`,
      assumptions: [],
      uncertainties: [],
      missing_inputs: gate.missing_info,
      failure_modes: [],
      recommended_next_action: `Provide the following missing information: ${gate.missing_info.join(", ")}`,
    };
    await saveTask(task_id, pipelineInput.input, "general", "HOLD", mode, undefined, undefined, "HELD", JSON.stringify(output));
    await auditLog(task_id, "TASK_HELD", gate.reason || "Held by input gate");
    return { task_id, tri_state: "HOLD", task_type: "general", final_status: "HELD", bos_output: output };
  }

  const classification = classifyTask(gate.sanitized_input, gate.intent);
  const task_type = pipelineInput.task_type_override || classification.task_type;
  await auditLog(task_id, "TASK_CLASSIFIED", `Task type: ${task_type}`, { confidence: classification.confidence });

  const models = await selectModel(task_type, gate.sanitized_input.length, mode, parallel_count + 2);

  const tri_state_result = evaluateTriState({
    input_safe: gate.state === "GO",
    has_required_info: gate.missing_info.length === 0,
    provider_available: models.length > 0,
    has_fallback: models.length > 1,
    risk_level: gate.risk_level,
    missing_info: gate.missing_info,
  });

  await auditLog(task_id, "TRI_STATE_EVALUATED", `Tri-state: ${tri_state_result.state}`, { reason: tri_state_result.reason });

  if (tri_state_result.state === "ABORT") {
    const output: BosOutput = {
      state: "ABORT",
      task_type,
      answer: `BOS-OMEGA ABORT: ${tri_state_result.reason}`,
      assumptions: [],
      uncertainties: [],
      missing_inputs: [],
      failure_modes: [tri_state_result.reason],
      recommended_next_action: "Check provider availability and request validity",
    };
    await saveTask(task_id, pipelineInput.input, task_type, "ABORT", mode, undefined, undefined, "ABORTED", JSON.stringify(output));
    return { task_id, tri_state: "ABORT", task_type, final_status: "ABORTED", bos_output: output };
  }

  if (tri_state_result.state === "HOLD") {
    const output: BosOutput = {
      state: "HOLD",
      task_type,
      answer: `BOS-OMEGA HOLD: ${tri_state_result.reason}`,
      assumptions: [],
      uncertainties: [],
      missing_inputs: gate.missing_info,
      failure_modes: [],
      recommended_next_action: tri_state_result.reason,
    };
    await saveTask(task_id, pipelineInput.input, task_type, "HOLD", mode, undefined, undefined, "HELD", JSON.stringify(output));
    return { task_id, tri_state: "HOLD", task_type, final_status: "HELD", bos_output: output };
  }

  const selected = models.slice(0, parallel_count);
  if (selected.length > 0) {
    await auditLog(task_id, "MODEL_SELECTED", `Selected ${selected.map((m) => `${m.provider_name}/${m.model_name}`).join(", ")}`, { count: selected.length });
  }

  await saveTask(task_id, pipelineInput.input, task_type, "GO", mode,
    selected[0]?.provider_name, selected[0]?.model_name, "RUNNING", undefined);

  const ctx: TaskContext = {
    task_id,
    input: gate.sanitized_input,
    task_type,
    tri_state: "GO",
    mode,
    parallel_models: parallel_count,
  };

  const { result, attempts_saved } = await executePipeline(ctx, selected);

  const final_status = result.state === "ABORT" ? "ABORTED" : result.state === "HOLD" ? "HELD" : "COMPLETED";
  await db.update(tasksTable)
    .set({
      final_status,
      final_output: JSON.stringify(result),
      selected_provider: selected[0]?.provider_name,
      selected_model: selected[0]?.model_name,
    })
    .where(eq(tasksTable.id, task_id));

  return {
    task_id,
    tri_state: result.state,
    task_type,
    selected_provider: selected[0]?.provider_name,
    selected_model: selected[0]?.model_name,
    final_status,
    bos_output: result,
  };
}

async function saveTask(
  task_id: string,
  input: string,
  task_type: string,
  tri_state: string,
  mode: string,
  provider?: string,
  model?: string,
  final_status?: string,
  final_output?: string
): Promise<void> {
  await db.insert(tasksTable).values({
    id: task_id,
    input_text: input,
    task_type,
    tri_state,
    mode,
    selected_provider: provider || null,
    selected_model: model || null,
    final_status: final_status || "pending",
    final_output: final_output || null,
  });
}
