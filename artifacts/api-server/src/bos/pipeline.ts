import { db } from "@workspace/db";
import { tasksTable, triStateDecisionsTable, modelAttemptsTable } from "@workspace/db";
import { eq, sql, inArray } from "drizzle-orm";
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
import { auditLog, complianceHoldRequired, clearComplianceFailure } from "./auditEngine.js";
import { logger } from "../lib/logger.js";
import { loadAttachmentBundle } from "../lib/uploads/loader.js";
import { budgetForMode, checkBudget, type BudgetUsage } from "./budgets.js";
import { attachmentsTable } from "@workspace/db";

// v1.1 hardening: must mirror requiredConfidenceForTaskType() in triState.ts
// so a task that demands 0.85 confidence is also flagged as high_stakes_domain
// in the gather/collapse signals.
const HIGH_STAKES_DOMAINS = new Set(["legal", "medical", "financial", "code", "security"]);

/**
 * v1.1 — Denial / HOLD explanation engine.
 * Maps a structured denial cause to a plain-English `why_decision_was_made` and a
 * `safe_alternative` the user can pursue. Every BosOutput in HOLD/ABORT carries these.
 */
type DenialCause =
  | "input_gate_abort"
  | "input_gate_hold_missing_info"
  | "tri_state_abort"
  | "tri_state_hold_no_provider"
  | "tri_state_hold_low_confidence"
  | "tri_state_hold_default"
  | "budget_exceeded"
  | "compliance_audit_failure";

function denialExplanation(cause: DenialCause, reason: string): {
  why_decision_was_made: string;
  safe_alternative: string;
  recommended_next_action: string;
} {
  switch (cause) {
    case "input_gate_abort":
      return {
        why_decision_was_made: "The request was blocked by the safety gate before any model was called. BOS-OMEGA enforces a hard veto on requests that match its non-negotiable safety policy.",
        safe_alternative: "Rephrase the request without illegal, harmful, or policy-violating intent, or pursue the goal through a sanctioned channel (legal counsel, licensed professional, official documentation).",
        recommended_next_action: "Review the request against safety policy and resubmit a version that does not match the prohibited intent.",
      };
    case "input_gate_hold_missing_info":
      return {
        why_decision_was_made: "The input gate detected that required information for this task is missing. BOS-OMEGA holds the task rather than guessing.",
        safe_alternative: "Resubmit the task with the missing details filled in, or break the request into smaller steps that can be answered with the information you do have.",
        recommended_next_action: reason || "Provide the missing information and resubmit.",
      };
    case "tri_state_abort":
      return {
        why_decision_was_made: "The Tri-State engine collapsed to ABORT — the aggregated evidence (intent, risk, validation, signals) crossed the hardened ABORT threshold of 65%.",
        safe_alternative: "Reduce the risk surface (narrower scope, lower-stakes domain, or non-action-taking phrasing) and resubmit.",
        recommended_next_action: reason,
      };
    case "tri_state_hold_no_provider":
      return {
        why_decision_was_made: "No LLM provider is currently available to handle this task type. BOS-OMEGA refuses to route to a provider that lacks the required capability or whose circuit breaker is open.",
        safe_alternative: "Add or enable a provider that has the required capability tags, or wait for the open circuit breaker to recover.",
        recommended_next_action: "Configure an eligible provider/model and retry.",
      };
    case "tri_state_hold_low_confidence":
      return {
        why_decision_was_made: "GO amplitude or computed confidence fell below the hardened thresholds (GO ≥ 0.75, validation passed, confidence ≥ 0.85 for high-stakes domains else 0.70). HOLD is the safe default.",
        safe_alternative: "Provide more context, narrow the scope, or downgrade the task type from a high-stakes domain to a lower-stakes one if appropriate.",
        recommended_next_action: reason,
      };
    case "tri_state_hold_default":
      return {
        why_decision_was_made: "The Tri-State engine could not justify GO under the hardened collapse rules, so it defaulted to HOLD. Doing nothing is safer than answering with low confidence.",
        safe_alternative: "Refine the request, supply additional context, or split it into smaller well-scoped sub-tasks.",
        recommended_next_action: reason,
      };
    case "budget_exceeded":
      return {
        why_decision_was_made: "Execution exceeded the budget governor's ceiling for this mode (cost, model calls, fallbacks, or repair attempts).",
        safe_alternative: "Reduce scope, switch to a cheaper mode (e.g. single instead of boil_the_ocean), or approve a higher budget.",
        recommended_next_action: "Reduce scope or approve higher budget.",
      };
    case "compliance_audit_failure":
      return {
        why_decision_was_made: "Audit-log durability failed and the system is running in compliance mode, which requires every task to be fully auditable. Continuing without durable audit would violate compliance posture.",
        safe_alternative: "Investigate the audit-log datastore (DB connectivity, disk space, queue health) and retry once it is healthy.",
        recommended_next_action: "Restore audit durability before retrying this task.",
      };
  }
}

function attachDenial(output: BosOutput, cause: DenialCause, reason: string): BosOutput {
  const exp = denialExplanation(cause, reason);
  return {
    ...output,
    why_decision_was_made: exp.why_decision_was_made,
    safe_alternative: exp.safe_alternative,
    recommended_next_action: output.recommended_next_action || exp.recommended_next_action,
  };
}

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
  persona?: "legal" | "engineering" | "cyber";
  // Owning user. The pipeline writes this into tasks.user_id atomically on
  // the very first INSERT so a freshly-created task is never visible as a
  // legacy NULL-owned row to other authenticated users.
  user_id?: string | null;
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
    persona: pipelineInput.persona ?? null,
  });

  if (attachment_bundle.notes.length > 0) {
    await auditLog(task_id, "ATTACHMENT_NOTES", "Attachment processing notes", {
      notes: attachment_bundle.notes,
    });
    // v1.1: surface prompt-injection flagging as its own audit event
    const injection_notes = attachment_bundle.notes.filter((n) =>
      n.includes("prompt-injection patterns detected"),
    );
    if (injection_notes.length > 0) {
      await auditLog(task_id, "ATTACHMENT_INJECTION_FLAGGED", "Attachment injection patterns detected", {
        flagged: injection_notes,
      });
    }
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
    const base = buildAbortOutput(gate.reason || "Policy violation", task_id);
    const output = attachDenial(base, "input_gate_abort", gate.reason || "Policy violation");
    await saveTask(task_id, pipelineInput.input, "safety_review", "ABORT", requested_mode, undefined, undefined, "ABORTED", JSON.stringify(output), pipelineInput.user_id ?? null);
    await auditLog(task_id, "TASK_ABORTED", gate.reason || "Aborted by input gate");
    return { task_id, tri_state: "ABORT", task_type: "safety_review", final_status: "ABORTED", bos_output: output };
  }

  if (gate.state === "HOLD") {
    const base: BosOutput = {
      state: "HOLD",
      task_type: "general",
      answer: `BOS-OMEGA HOLD: ${gate.reason}`,
      assumptions: [],
      uncertainties: [],
      missing_inputs: gate.missing_info,
      failure_modes: [],
      recommended_next_action: `Provide the following missing information: ${gate.missing_info.join(", ")}`,
    };
    const output = attachDenial(base, "input_gate_hold_missing_info", gate.reason || "Missing required info");
    await saveTask(task_id, pipelineInput.input, "general", "HOLD", requested_mode, undefined, undefined, "HELD", JSON.stringify(output), pipelineInput.user_id ?? null);
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

  let resolved_mode = mode_selection.mode;
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
    validation_passed: true,
    high_stakes_domain: HIGH_STAKES_DOMAINS.has(task_type),
    task_type,
    ambiguity_detected: gate.intent === "unclear" || classification.confidence < 0.5,
    // The input gate has already short-circuited true ABORTs above. Set
    // hard_safety_abort=false here; the only path to ABORT from here is via
    // the abort-amplitude rule.
    hard_safety_abort: false,
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
    const base: BosOutput = {
      state: "ABORT",
      task_type,
      answer: `BOS-OMEGA ABORT: ${tri_state_result.reason}`,
      assumptions: [],
      uncertainties: [],
      missing_inputs: [],
      failure_modes: [tri_state_result.reason],
      recommended_next_action: "Check provider availability and request validity",
    };
    const output = attachDenial(base, "tri_state_abort", tri_state_result.reason);
    await saveTask(task_id, pipelineInput.input, task_type, "ABORT", resolved_mode, undefined, undefined, "ABORTED", JSON.stringify(output), pipelineInput.user_id ?? null);
    await auditLog(task_id, "TASK_ABORTED", tri_state_result.reason);
    return { task_id, tri_state: "ABORT", task_type, final_status: "ABORTED", bos_output: output };
  }

  if (tri_state_result.state === "HOLD") {
    // Pick the right denial cause based on what the collapse rule said.
    const cause: DenialCause = models.length === 0
      ? "tri_state_hold_no_provider"
      : tri_state_result.reason.startsWith("Hardened default")
        ? "tri_state_hold_low_confidence"
        : "tri_state_hold_default";
    const base: BosOutput = {
      state: "HOLD",
      task_type,
      answer: `BOS-OMEGA HOLD: ${tri_state_result.reason}`,
      assumptions: [],
      uncertainties: [],
      missing_inputs: gate.missing_info,
      failure_modes: [],
      recommended_next_action: tri_state_result.reason,
    };
    const output = attachDenial(base, cause, tri_state_result.reason);
    await saveTask(task_id, pipelineInput.input, task_type, "HOLD", resolved_mode, undefined, undefined, "HELD", JSON.stringify(output), pipelineInput.user_id ?? null);
    await auditLog(task_id, "TASK_HELD", tri_state_result.reason);
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
    pipelineInput.user_id ?? null,
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
    persona: pipelineInput.persona,
  };

  let result: BosOutput;
  let run_id: string | undefined;

  // Dispatch to correct engine. series_pass requires >=2 distinct models —
  // if the registry is too thin (low-availability env, all-but-one disabled,
  // budget pruning), gracefully downgrade to single-shot rather than throwing
  // a 500. This preserves availability and matches the spirit of H-2 (the
  // throw is a developer-facing guard, not a user-facing failure).
  if (resolved_mode === "series_pass" && models.length < 2) {
    await auditLog(
      task_id,
      "MODE_DOWNGRADED",
      `series_pass requires >=2 models but ${models.length} eligible; degraded to single`,
      { from: "series_pass", to: "single", eligible_models: models.length },
    );
    resolved_mode = "single";
    ctx.mode = "single" as ExecutionMode;
  }

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

  // === v1.1 post-execution governance checks ===

  // 1) Budget governor — read the actual model_attempts rows that the engine
  //    persisted for this task and aggregate cost / model count from them.
  //    This is the source of truth for what was actually spent; using
  //    `parallel_responses?.length` would under-count fallback attempts and
  //    serial-mode hops. We `.max(., 1)` so a single-mode task always counts
  //    at least one model call.
  const budget = budgetForMode(resolved_mode as ExecutionMode);
  let attempts_count = 1;
  let attempts_cost = 0;
  try {
    const rows = await db
      .select({
        n: sql<number>`COUNT(*)::int`,
        total: sql<number>`COALESCE(SUM(${modelAttemptsTable.cost_estimate}), 0)::float`,
      })
      .from(modelAttemptsTable)
      .where(eq(modelAttemptsTable.task_id, task_id));
    attempts_count = Math.max(rows[0]?.n ?? 1, 1);
    attempts_cost = rows[0]?.total ?? 0;
  } catch (err) {
    logger.warn({ err, task_id }, "budget governor: failed to read model_attempts; falling back to in-memory proxy");
    attempts_count = Math.max(result.parallel_responses?.length ?? 1, 1);
  }
  const usage: BudgetUsage = {
    models_used: attempts_count,
    fallbacks_used: Math.max(attempts_count - 1, 0),
    repair_attempts_used: result.repair_applied ? 1 : 0,
    cost_usd_used: attempts_cost,
  };
  const verdict = checkBudget(budget, usage);
  if (!verdict.ok) {
    const base: BosOutput = {
      state: "HOLD",
      task_type,
      answer: `BOS-OMEGA HOLD: ${verdict.reason}`,
      assumptions: [],
      uncertainties: [],
      missing_inputs: [],
      failure_modes: ["budget_exceeded"],
      recommended_next_action: verdict.reason || "Reduce scope or approve higher budget.",
    };
    const output = attachDenial(base, "budget_exceeded", verdict.reason || "");
    await db.update(tasksTable)
      .set({ final_status: "HELD", final_output: JSON.stringify(output), mode: resolved_mode })
      .where(eq(tasksTable.id, task_id));
    await auditLog(task_id, "BUDGET_EXCEEDED", verdict.reason || "Budget exceeded", { mode: resolved_mode, usage });
    await auditLog(task_id, "TASK_HELD", verdict.reason || "Held by budget governor");
    return { task_id, tri_state: "HOLD", task_type, final_status: "HELD", bos_output: output, run_id, execution_mode: resolved_mode };
  }

  // 2) Audit durability — if the audit DB was unhealthy and we're in compliance
  //    mode, the failure-mode matrix says HOLD the task.
  if (complianceHoldRequired()) {
    clearComplianceFailure();
    const base: BosOutput = {
      state: "HOLD",
      task_type,
      answer: "BOS-OMEGA HOLD: Audit-log durability is compromised and the system is in compliance mode.",
      assumptions: [],
      uncertainties: [],
      missing_inputs: [],
      failure_modes: ["audit_db_failure"],
      recommended_next_action: "Restore audit datastore health and retry.",
    };
    const output = attachDenial(base, "compliance_audit_failure", "audit_db_failure");
    await db.update(tasksTable)
      .set({ final_status: "HELD", final_output: JSON.stringify(output), mode: resolved_mode })
      .where(eq(tasksTable.id, task_id));
    await auditLog(task_id, "TASK_HELD", "Held by compliance audit-failure rule");
    return { task_id, tri_state: "HOLD", task_type, final_status: "HELD", bos_output: output, run_id, execution_mode: resolved_mode };
  }

  const final_status = result.state === "ABORT" ? "ABORTED" : result.state === "HOLD" ? "HELD" : "COMPLETED";

  // v1.1: ensure HOLD/ABORT outputs from the engines also carry denial fields.
  const result_with_denial: BosOutput = result.state === "GO"
    ? result
    : attachDenial(
        result,
        result.state === "ABORT" ? "tri_state_abort" : "tri_state_hold_default",
        result.recommended_next_action || result.answer,
      );

  await db.update(tasksTable)
    .set({
      final_status,
      final_output: JSON.stringify(result_with_denial),
      selected_provider: models[0]?.provider_name,
      selected_model: models[0]?.model_name,
      mode: resolved_mode,
    })
    .where(eq(tasksTable.id, task_id));

  await auditLog(task_id, "TASK_COMPLETED", `Task completed with state ${result_with_denial.state}`, { mode: resolved_mode, run_id });

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
  provider: string | undefined,
  model: string | undefined,
  final_status: string | undefined,
  final_output: string | undefined,
  user_id: string | null,
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
    user_id,
  });
}
