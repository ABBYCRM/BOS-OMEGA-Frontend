import { db } from "@workspace/db";
import { tasksTable, triStateDecisionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import type { BosOutput, ExecutionMode, TaskContext, TriState } from "./types.js";
import { runInputGate } from "./inputGate.js";
import { classifyTask } from "./taskClassifier.js";
import { evaluateTriState, type TriStateResult } from "./triState.js";
import { selectModel } from "./modelRouter.js";
import { executePipeline } from "./executionEngine.js";
import { runSeriesPass } from "./seriesPassEngine.js";
import { runBoilTheOcean } from "./boilTheOceanEngine.js";
import { selectExecutionMode } from "./modeSelector.js";
import { auditLog } from "./auditEngine.js";
import { logger } from "../lib/logger.js";
import { loadAttachmentBundle } from "../lib/uploads/loader.js";
import { attachmentsTable } from "@workspace/db";
import { inArray } from "drizzle-orm";

const HIGH_STAKES_DOMAINS = new Set(["legal", "medical", "financial", "research", "code"]);

async function persistTriStateDecision(task_id: string, result: TriStateResult): Promise<string> {
  const id = randomUUID();
  await db.insert(triStateDecisionsTable).values({
    id,
    task_id,
    go_score: result.vector.go,
    hold_score: result.vector.hold,
    abort_score: result.vector.abort,
    evidence_signals: JSON.stringify(result.evidence_signals),
    collapse_reason: result.collapse_reason,
    final_state: result.state,
    confidence_score: result.confidence_score,
  });
  return id;
}

export interface PipelineInput {
  input: string;
  mode?: ExecutionMode;
  task_type_override?: string;
  parallel_models?: number;
  max_models?: number;
  agents_per_model?: number;
  attachment_ids?: string[];
}

export interface PipelineResult {
  task_id: string;
  tri_state: TriState;
  task_type: string;
  selected_provider?: string;
  selected_model?: string;
  final_status: string;
  bos_output: BosOutput;
  run_id?: string;
  execution_mode?: string;
}

export async function runBosPipeline(pipelineInput: PipelineInput): Promise<PipelineResult> {
  const task_id = randomUUID();
  const requested_mode: ExecutionMode = pipelineInput.mode || "auto";

  // === Load attachments early so they're audited and available throughout the run ===
  const attachment_ids = pipelineInput.attachment_ids ?? [];
  const attachment_bundle = await loadAttachmentBundle(attachment_ids);

  await auditLog(task_id, "TASK_RECEIVED", "Task received by BOS-OMEGA", {
    mode: requested_mode,
    input_length: pipelineInput.input.length,
    attachments: attachment_ids.length,
    attachment_images: attachment_bundle.images.length,
    attachment_context_chars: attachment_bundle.context_block.length,
  });

  if (attachment_bundle.notes.length > 0) {
    await auditLog(task_id, "ATTACHMENT_NOTES", "Attachment processing notes", {
      notes: attachment_bundle.notes,
    });
  }

  // Link attachments to this task as soon as we know the task id.
  if (attachment_ids.length > 0) {
    await db
      .update(attachmentsTable)
      .set({ task_id })
      .where(inArray(attachmentsTable.id, attachment_ids));
  }

  const gate = runInputGate(pipelineInput.input);
  await auditLog(task_id, "INPUT_GATE_RESULT", `Input gate: ${gate.state}`, {
    intent: gate.intent,
    risk: gate.risk_level,
  });

  if (gate.state === "ABORT") {
    const output = buildAbortOutput(gate.reason || "Policy violation", task_id);
    await saveTask(task_id, pipelineInput.input, "safety_review", "ABORT", requested_mode, undefined, undefined, "ABORTED", JSON.stringify(output));
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
    await saveTask(task_id, pipelineInput.input, "general", "HOLD", requested_mode, undefined, undefined, "HELD", JSON.stringify(output));
    await auditLog(task_id, "TASK_HELD", gate.reason || "Held by input gate");
    return { task_id, tri_state: "HOLD", task_type: "general", final_status: "HELD", bos_output: output };
  }

  const classification = classifyTask(gate.sanitized_input, gate.intent);
  const task_type = pipelineInput.task_type_override || classification.task_type;
  await auditLog(task_id, "TASK_CLASSIFIED", `Task type: ${task_type}`, { confidence: classification.confidence });

  // MODE SELECTION — auto-pick or use explicit request
  const mode_selection = selectExecutionMode(
    requested_mode,
    gate.sanitized_input,
    task_type,
    gate.sanitized_input.length,
  );

  const resolved_mode = mode_selection.mode;
  await auditLog(task_id, "MODE_SELECTED", `Execution mode: ${resolved_mode}`, {
    reason: mode_selection.reason,
    confidence: mode_selection.confidence,
    requested: requested_mode,
  });

  // Fetch models — fetch more for BTO and series pass
  const fetch_count = resolved_mode === "boil_the_ocean" ? 10 :
    resolved_mode === "series_pass" ? 7 :
    (pipelineInput.parallel_models || 3) + 2;

  const models = await selectModel(task_type, gate.sanitized_input.length, resolved_mode as "single" | "parallel" | "consensus", fetch_count);

  const tri_state_result = evaluateTriState({
    input_safe: gate.state === "GO",
    has_required_info: gate.missing_info.length === 0,
    provider_available: models.length > 0,
    has_fallback: models.length > 1,
    risk_level: gate.risk_level,
    missing_info: gate.missing_info,
    intent_clarity: classification.confidence,
    confidence_score: classification.confidence,
    high_stakes_domain: HIGH_STAKES_DOMAINS.has(task_type),
    task_type,
    ambiguity_detected: gate.intent === "unclear" || classification.confidence < 0.5,
  });

  // Persist the qubit-inspired decision (vector + signals + collapse reason)
  const decision_id = await persistTriStateDecision(task_id, tri_state_result);

  await auditLog(task_id, "TRI_STATE_EVALUATED", `Tri-state: ${tri_state_result.state}`, {
    reason: tri_state_result.reason,
    go: tri_state_result.vector.go.toFixed(3),
    hold: tri_state_result.vector.hold.toFixed(3),
    abort: tri_state_result.vector.abort.toFixed(3),
    confidence: tri_state_result.confidence_score.toFixed(3),
    signals: tri_state_result.evidence_signals.length,
    decision_id,
  });

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
    await saveTask(task_id, pipelineInput.input, task_type, "ABORT", resolved_mode, undefined, undefined, "ABORTED", JSON.stringify(output));
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
    await saveTask(task_id, pipelineInput.input, task_type, "HOLD", resolved_mode, undefined, undefined, "HELD", JSON.stringify(output));
    return { task_id, tri_state: "HOLD", task_type, final_status: "HELD", bos_output: output };
  }

  if (models.length > 0) {
    await auditLog(task_id, "MODEL_SELECTED", `Selected ${models.slice(0, 3).map((m) => `${m.provider_name}/${m.model_name}`).join(", ")}`, {
      count: models.length,
    });
  }

  await saveTask(
    task_id,
    pipelineInput.input,
    task_type,
    "GO",
    resolved_mode,
    models[0]?.provider_name,
    models[0]?.model_name,
    "RUNNING",
    undefined,
  );

  const ctx: TaskContext = {
    task_id,
    input: gate.sanitized_input,
    task_type,
    tri_state: "GO",
    mode: resolved_mode as ExecutionMode,
    parallel_models: pipelineInput.parallel_models || 3,
    attachment_context: attachment_bundle.context_block || undefined,
    attachment_images: attachment_bundle.images.length > 0 ? attachment_bundle.images : undefined,
  };

  let result: BosOutput;
  let run_id: string | undefined;

  // Dispatch to correct engine
  if (resolved_mode === "series_pass") {
    const sp_result = await runSeriesPass(ctx, models);
    result = sp_result.result;
    run_id = sp_result.run_id;
  } else if (resolved_mode === "boil_the_ocean") {
    const bto_result = await runBoilTheOcean(
      ctx,
      models,
      pipelineInput.max_models || 5,
      pipelineInput.agents_per_model || 5,
    );
    result = bto_result.result;
    run_id = bto_result.run_id;
  } else {
    // Normal / parallel / consensus → existing engine
    const parallel_count = resolved_mode === "parallel" || resolved_mode === "consensus"
      ? (pipelineInput.parallel_models || 3)
      : 1;
    const selected = models.slice(0, parallel_count);
    const { result: exec_result } = await executePipeline(ctx, selected);
    result = exec_result;
  }

  const final_status = result.state === "ABORT" ? "ABORTED" : result.state === "HOLD" ? "HELD" : "COMPLETED";

  await db.update(tasksTable)
    .set({
      final_status,
      final_output: JSON.stringify(result),
      selected_provider: models[0]?.provider_name,
      selected_model: models[0]?.model_name,
      mode: resolved_mode,
    })
    .where(eq(tasksTable.id, task_id));

  await auditLog(task_id, "TASK_COMPLETED", `Task completed with state ${result.state}`, { mode: resolved_mode, run_id });

  return {
    task_id,
    tri_state: result.state,
    task_type,
    selected_provider: models[0]?.provider_name,
    selected_model: models[0]?.model_name,
    final_status,
    bos_output: result,
    run_id,
    execution_mode: resolved_mode,
  };
}

function buildAbortOutput(reason: string, task_id: string): BosOutput {
  return {
    state: "ABORT",
    task_type: "safety_review",
    answer: `This request has been blocked by BOS-OMEGA safety policy. Reason: ${reason}`,
    assumptions: [],
    uncertainties: [],
    missing_inputs: [],
    failure_modes: [reason],
    recommended_next_action: "Review the request and ensure it complies with policy",
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
  final_output?: string,
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
