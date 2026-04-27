import { db } from "@workspace/db";
import { tasksTable, triStateDecisionsTable, modelAttemptsTable, memoryItemsTable } from "@workspace/db";
import { personaSlotId } from "./personaCanonSeed.js";
import { buildPersonaOverlay } from "./personaOverlay.js";
import { eq, sql, inArray, and, desc, isNotNull } from "drizzle-orm";
import { randomUUID, createHash } from "crypto";
import type { BosOutput, ExecutionMode, TaskContext, TriState } from "./types.js";
import { runInputGate } from "./inputGate.js";
import { classifyFrontDoorInput } from "./frontDoorInterpreter.js";
import { detectImageIntent, detectImageEditIntent } from "./imageIntent.js";
import { runImageGeneration, runImageEdit } from "./imageProviderBridge.js";
import { safeInputPreview } from "./frontDoorResponses.js";
import { classifyTask } from "./taskClassifier.js";
import { buildTriStateMetadata, type TriStateDisplayMetadata, type TriStateResult } from "./triState.js";
import { selectModel } from "./modelRouter.js";
import { executePipeline } from "./executionEngine.js";
import { runSeriesPass } from "./seriesPassEngine.js";
import { runBoilTheOcean } from "./boilTheOceanEngine.js";
import { selectExecutionMode } from "./modeSelector.js";
import {
  getCanonMemory,
  getContinuityMemory,
  getPatchesMemory,
  getScratchpad,
  buildContextFromMemory,
} from "./memoryEngine.js";
import { getEffectiveBudgets } from "./userBudgets.js";
import { auditLog, complianceHoldRequired, clearComplianceFailure } from "./auditEngine.js";
import { writeAutoSummary } from "./scratchpadWriter.js";
import { logger } from "../lib/logger.js";
import { loadAttachmentBundle } from "../lib/uploads/loader.js";
import { budgetForMode, checkBudget, type BudgetUsage } from "./budgets.js";
import { attachmentsTable } from "@workspace/db";

// BOP.FRONT_DOOR.v1 — sha-256 hash of the raw input so two audit events
// for the same prompt can be correlated without re-storing the full text.
function hashInput(s: string): string {
  return "sha256:" + createHash("sha256").update(s ?? "", "utf8").digest("hex").slice(0, 16);
}

/**
 * BOP.CANON_GOVERNANCE.v1 — Canon load failure marker.
 *
 * When the canon layer cannot be read (DB error, missing seed), the pipeline
 * MUST fail loudly rather than silently fall through to a model call without
 * its governance prompt. The route layer translates this into a 500 with
 * `code: "CANON_LOAD_ERROR"` so callers can distinguish it from generic
 * SYSTEM_ERROR.
 */
export class CanonLoadError extends Error {
  readonly code = "CANON_LOAD_ERROR";
  constructor(message: string, public cause_err?: unknown) {
    super(message);
    this.name = "CanonLoadError";
  }
}

/**
 * Denial / HOLD explanation engine.
 * Maps a structured denial cause to a plain-English `why_decision_was_made` and a
 * `safe_alternative` the user can pursue. Every BosOutput in HOLD/ABORT carries these.
 *
 * BOP.CANON_GOVERNANCE.v1 trimmed the Tri-State runtime gate causes — only
 * the safety/system-shape causes remain. Model-driven HOLD output goes
 * through `model_self_held` instead.
 */
type DenialCause =
  | "input_gate_abort"
  | "no_provider_available"
  | "model_self_held"
  | "model_self_aborted"
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
    case "no_provider_available":
      return {
        why_decision_was_made: "No LLM provider is currently available to handle this task type. BOS-OMEGA refuses to route to a provider that lacks the required capability or whose circuit breaker is open.",
        safe_alternative: "Add or enable a provider that has the required capability tags, or wait for the open circuit breaker to recover.",
        recommended_next_action: "Configure an eligible provider/model and retry.",
      };
    case "model_self_held":
      return {
        why_decision_was_made: "The model labelled its own response HOLD per the BOS Canon prompt — typically because it lacked the context, tools, or certainty to answer responsibly. This is a model-level governance signal, not a runtime block.",
        safe_alternative: "Read the model's recommended_next_action below; usually it asks for clarifying information you can provide.",
        recommended_next_action: reason || "Provide the missing information the model asked for and resubmit.",
      };
    case "model_self_aborted":
      return {
        why_decision_was_made: "The model labelled its own response ABORT per the BOS Canon prompt — typically because the request, while syntactically allowed, conflicts with stated assumptions, ethics, or scope.",
        safe_alternative: "Adjust the request to fit the canon-defined scope, or escalate via a sanctioned channel.",
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

/**
 * Task #84 — find the most recent generated_attachment in a conversation.
 *
 * Walks the most recent image_generation / image_edit tasks in this
 * conversation (newest first), parses each row's `final_output` JSON, and
 * returns the first attachment id we find on `generated_attachments[0].id`.
 * When `user_id` is provided we additionally constrain by `tasks.user_id`
 * so an unauthenticated edit request can never reach into another user's
 * thread.
 *
 * Returns `null` when nothing is found, when the conversation has no
 * image task yet, or when a JSON parse fails — the caller treats null
 * as "fall through to text path" rather than failing.
 */
async function findMostRecentGeneratedAttachment(
  conversation_id: string,
  user_id: string | null,
): Promise<string | null> {
  try {
    const where_clause = user_id
      ? and(
          eq(tasksTable.conversation_id, conversation_id),
          eq(tasksTable.user_id, user_id),
          inArray(tasksTable.task_type, ["image_generation", "image_edit"]),
          isNotNull(tasksTable.final_output),
        )
      : and(
          eq(tasksTable.conversation_id, conversation_id),
          inArray(tasksTable.task_type, ["image_generation", "image_edit"]),
          isNotNull(tasksTable.final_output),
        );
    const rows = await db
      .select({ id: tasksTable.id, final_output: tasksTable.final_output })
      .from(tasksTable)
      .where(where_clause)
      .orderBy(desc(tasksTable.created_at))
      .limit(5);
    for (const row of rows) {
      if (!row.final_output) continue;
      try {
        const parsed = JSON.parse(row.final_output) as Partial<BosOutput>;
        const attachments = parsed.generated_attachments;
        if (Array.isArray(attachments) && attachments.length > 0) {
          const first = attachments[0];
          if (first && typeof first.id === "string" && first.id.length > 0) {
            return first.id;
          }
        }
      } catch {
        // Malformed final_output — skip and look further back.
      }
    }
  } catch (err) {
    logger.warn({ err, conversation_id }, "findMostRecentGeneratedAttachment lookup failed");
  }
  return null;
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
  /** Persona slot (A|B|C) — resolves at pipeline start to a memory_items row
   *  whose content becomes the persona overlay. Takes precedence over the
   *  legacy `persona` field. */
  persona_slot?: "A" | "B" | "C";
  // Owning user. The pipeline writes this into tasks.user_id atomically on
  // the very first INSERT so a freshly-created task is never visible as a
  // legacy NULL-owned row to other authenticated users.
  user_id?: string | null;
  // Lattice continuity (Task #68) — conversation grouping. The route layer
  // PLANS the assignment via planConversationAssignment() before invoking
  // the pipeline. The actual conversation INSERT/UPDATE is performed
  // inside `saveTask`'s transaction so we never strand empty conversation
  // rows on a downstream pipeline failure. null when anonymous or when the
  // clusterer failed transiently and the route chose to proceed unscoped.
  conversation_decision?: import("./conversationClusterer.js").ConvDecision | null;
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

  // === Resolve persona slot (A|B|C) to its memory_items row, if requested ===
  // The slot row (layer="persona") carries the user-editable title + content
  // overlay. We resolve once here so every execution engine receives the same
  // already-wrapped persona prompt text and the audit chain records exactly
  // which slot ran.
  let persona_slot_resolved: { slot: "A"|"B"|"C"; title: string; content: string } | null = null;
  if (pipelineInput.persona_slot) {
    const slot = pipelineInput.persona_slot;
    const slot_id = personaSlotId(slot);
    const [row] = await db
      .select()
      .from(memoryItemsTable)
      .where(eq(memoryItemsTable.id, slot_id))
      .limit(1);
    if (row) {
      persona_slot_resolved = { slot, title: row.title, content: row.content };
    }
  }

  await auditLog(task_id, "TASK_RECEIVED", "Task received by BOS-OMEGA", {
    mode: requested_mode,
    input_length: pipelineInput.input.length,
    attachments: attachment_ids.length,
    attachment_images: attachment_bundle.images.length,
    attachment_context_chars: attachment_bundle.context_block.length,
    persona: pipelineInput.persona ?? null,
    persona_slot: persona_slot_resolved?.slot ?? null,
    persona_title: persona_slot_resolved?.title ?? null,
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

  // === BOP.FRONT_DOOR.v1 — preflight classification ===
  // Run BEFORE the input gate / Tri-State engine. Greetings, empty input,
  // vague stubs, and obvious non-tasks get friendly UX guidance instead of
  // a HOLD verdict. Low-confidence ambiguous input falls through to BOS to
  // avoid false-blocking real work.
  const fd = classifyFrontDoorInput(pipelineInput.input, {
    has_attachments: attachment_ids.length > 0,
  });
  const fd_preview = safeInputPreview(pipelineInput.input);
  const fd_input_hash = hashInput(pipelineInput.input);
  await auditLog(task_id, "FRONT_DOOR_CLASSIFIED", `Front door: ${fd.route}`, {
    route: fd.route,
    confidence: fd.confidence,
    rationale: fd.rationale,
    signals: fd.signals,
    should_invoke_bos_engine: fd.shouldInvokeBosEngine,
    has_attachments: attachment_ids.length > 0,
    input_hash: fd_input_hash,
    input_preview: fd_preview.preview,
    input_truncated: fd_preview.truncated,
    input_length: fd_preview.original_length,
    classified_at: new Date().toISOString(),
  });

  // BOP.CANON_GOVERNANCE.v1: the front door used to early-return a HOLD
  // for greetings / empty stubs / under-specified / likely-non-task
  // inputs and never call the model. That was a Tri-State runtime gate
  // dressed as UX guidance. The model is now ALWAYS invoked when the
  // safety gate passes; Canon teaches the model to greet the user
  // conversationally, ask clarifying questions for vague stubs, and
  // label its own output GO/HOLD/ABORT as appropriate. The classifier
  // is preserved purely for observability (FRONT_DOOR_CLASSIFIED audit).

  const gate = runInputGate(pipelineInput.input);
  await auditLog(task_id, "INPUT_GATE_RESULT", `Input gate: ${gate.state}`, {
    intent: gate.intent,
    risk: gate.risk_level,
  });

  if (gate.state === "ABORT") {
    const base = buildAbortOutput(gate.reason || "Policy violation", task_id);
    const output = attachDenial(base, "input_gate_abort", gate.reason || "Policy violation");
    await saveTask(task_id, pipelineInput.input, "safety_review", "ABORT", requested_mode, undefined, undefined, "ABORTED", JSON.stringify(output), pipelineInput.user_id ?? null, pipelineInput.conversation_decision ?? null);
    await auditLog(task_id, "TASK_ABORTED", gate.reason || "Aborted by input gate");
    return { task_id, tri_state: "ABORT", task_type: "safety_review", final_status: "ABORTED", bos_output: output };
  }

  // BOP.CANON_GOVERNANCE.v1: the input gate's missing_info HOLD branch
  // was removed. Vague / under-specified inputs flow through to the
  // model. Canon governs whether the model labels its own output HOLD
  // and asks the user for the missing context. Runtime never blocks
  // for "model uncertainty" or "missing context" reasons.

  // Task #84 — image-EDIT routing.
  //
  // Detect a follow-up "edit/refine" phrase ("make the sneaker blue",
  // "remove the background", "edit my image", ...). Only intercept when
  // we can resolve a parent generated_attachment in the active
  // conversation; otherwise fall through to text path so a stray "make
  // it blue" outside an image thread is answered conversationally.
  // Edit detection runs BEFORE generation detection so an explicit
  // "edit my image to add a hat" can never be misrouted to a fresh
  // generation attempt.
  const edit_intent = detectImageEditIntent(gate.sanitized_input);
  const conv_id_for_edit =
    pipelineInput.conversation_decision?.conversation_id ?? null;
  if (edit_intent.is_image_edit && conv_id_for_edit) {
    const parent_id = await findMostRecentGeneratedAttachment(
      conv_id_for_edit,
      pipelineInput.user_id ?? null,
    );
    if (parent_id) {
      const outcome = await runImageEdit({
        prompt: edit_intent.prompt,
        size: "1024x1024",
        user_id: pipelineInput.user_id ?? null,
        task_id,
        source_attachment_id: parent_id,
        matched_phrase: edit_intent.matched_phrase,
      });

      const tri_state: TriState = outcome.success ? "GO" : "HOLD";
      const final_status = outcome.success ? "DONE" : "HELD";
      const provenance = outcome.attempts.find((a) => a.success);
      const provider = provenance?.provider ?? "image_bridge";
      const model = provenance?.model ?? "image_bridge";

      const base: BosOutput = {
        state: tri_state,
        task_type: "image_edit",
        answer: outcome.summary,
        assumptions: outcome.mocked
          ? ["Mock mode active — no live image API was called. Set IMAGE_GENERATION_LIVE=1 to enable live providers."]
          : [],
        uncertainties: [],
        missing_inputs: [],
        failure_modes: outcome.success
          ? []
          : outcome.attempts.filter((a) => !a.success).map((a) => `${a.provider}:${a.error_type ?? "unknown"}`),
        recommended_next_action: outcome.success
          ? "Compare the edited image to the original inline."
          : "Configure an image provider (OpenAI gpt-image-1 or Gemini gemini-2.5-flash-image) and retry.",
        generated_attachments: outcome.attachments,
      };

      const output = outcome.success
        ? base
        : attachDenial(base, "no_provider_available", outcome.summary);

      await saveTask(
        task_id,
        pipelineInput.input,
        "image_edit",
        tri_state,
        "single",
        provider,
        model,
        final_status,
        JSON.stringify(output),
        pipelineInput.user_id ?? null,
        pipelineInput.conversation_decision ?? null,
      );

      await persistTriStateDecision(
        task_id,
        buildTriStateMetadata({ state: tri_state, answer: outcome.summary }, 0),
      );

      await auditLog(task_id, "TASK_COMPLETED", `Task completed with state ${tri_state}`, {
        mode: "single",
        task_type: "image_edit",
      });

      // Continuity scratchpad — same authority tier as image_generation
      // so a follow-up "what was the image you edited?" picks up this
      // row's storage_path anchor in memory_context.
      if (tri_state !== "ABORT") {
        try {
          const path_lines = outcome.attachments
            .map((a) => `${a.storage_path} (${a.provider}${a.mock ? "/mock" : ""})`)
            .join(" ");
          const continuity_answer = path_lines
            ? `Edited image at ${path_lines} (parent ${parent_id}). ${outcome.summary}`
            : outcome.summary;
          await writeAutoSummary({
            task_id,
            task_type: "image_edit",
            state: tri_state,
            answer: continuity_answer,
            input_text: pipelineInput.input,
            assumptions: output.assumptions,
            uncertainties: output.uncertainties,
            user_id: pipelineInput.user_id ?? null,
            authority_level: 4,
          });
        } catch (err) {
          logger.warn({ err, task_id }, "writeAutoSummary threw (non-fatal) for image_edit task");
        }
      }

      return {
        task_id,
        tri_state,
        task_type: "image_edit",
        final_status,
        bos_output: output,
      };
    }
    // Edit intent matched but no parent attachment exists in this
    // conversation — fall through so the text engines answer
    // ("you haven't generated an image yet, ...").
  }

  // Task #83 — image-generation routing.
  //
  // The detector is conservative (verb + image noun within a short
  // window, no edit/describe negatives) so a prompt like
  // "describe this image" is NOT intercepted. Only generation-style
  // requests like "generate an image of a red sneaker" land here.
  // We bypass the standard text classifier + execution engines and call
  // the dedicated provider bridge, which handles mock-mode default,
  // OpenAI → Gemini fallback, persistence via the uploads pipeline,
  // and IMAGE_REQUESTED / IMAGE_GENERATED / IMAGE_GENERATION_FAILED
  // audit events on its own.
  const image_intent = detectImageIntent(gate.sanitized_input);
  if (image_intent.is_image_generation) {
    const outcome = await runImageGeneration({
      prompt: image_intent.prompt,
      size: image_intent.size,
      user_id: pipelineInput.user_id ?? null,
      task_id,
      matched_phrase: image_intent.matched_phrase,
    });

    const tri_state: TriState = outcome.success ? "GO" : "HOLD";
    const final_status = outcome.success ? "DONE" : "HELD";
    const provenance = outcome.attempts.find((a) => a.success);
    const provider = provenance?.provider ?? "image_bridge";
    const model = provenance?.model ?? "image_bridge";

    const base: BosOutput = {
      state: tri_state,
      task_type: "image_generation",
      answer: outcome.summary,
      assumptions: outcome.mocked
        ? ["Mock mode active — no live image API was called. Set IMAGE_GENERATION_LIVE=1 to enable live providers."]
        : [],
      uncertainties: [],
      missing_inputs: [],
      failure_modes: outcome.success
        ? []
        : outcome.attempts.filter((a) => !a.success).map((a) => `${a.provider}:${a.error_type ?? "unknown"}`),
      recommended_next_action: outcome.success
        ? "View the generated image inline."
        : "Configure an image provider (OpenAI gpt-image-1 or Gemini gemini-2.5-flash-image) and retry.",
      generated_attachments: outcome.attachments,
    };

    const output = outcome.success ? base : attachDenial(base, "no_provider_available", outcome.summary);

    await saveTask(
      task_id,
      pipelineInput.input,
      "image_generation",
      tri_state,
      "single",
      provider,
      model,
      final_status,
      JSON.stringify(output),
      pipelineInput.user_id ?? null,
      pipelineInput.conversation_decision ?? null,
    );

    // Display-only tri-state row so /api/tri-state/by-task always has data,
    // mirroring the no-provider-available branch below.
    await persistTriStateDecision(
      task_id,
      buildTriStateMetadata({ state: tri_state, answer: outcome.summary }, 0),
    );

    await auditLog(task_id, "TASK_COMPLETED", `Task completed with state ${tri_state}`, {
      mode: "single",
      task_type: "image_generation",
    });

    // Task #67/#83 — write a continuity scratchpad row so a later task in
    // the same conversation can recall this image via memory_context. The
    // summary deliberately includes the storage_path so a follow-up like
    // "make the sneaker blue" has the prior attachment id available to the
    // model. Writer failures are non-fatal.
    if (tri_state !== "ABORT") {
      try {
        // Lead with the storage_path so the auto-summary's bounded answer
        // preview (stripped of sentence terminators, truncated to ~240 chars)
        // always carries the prior attachment URL into a follow-up task's
        // memory_context. Without this, a "what was the image you made?"
        // follow-up has no anchor to the prior generation.
        const path_lines = outcome.attachments
          .map((a) => `${a.storage_path} (${a.provider}${a.mock ? "/mock" : ""})`)
          .join(" ");
        const continuity_answer = path_lines
          ? `Generated image at ${path_lines}. ${outcome.summary}`
          : outcome.summary;
        await writeAutoSummary({
          task_id,
          task_type: "image_generation",
          state: tri_state,
          answer: continuity_answer,
          input_text: pipelineInput.input,
          assumptions: output.assumptions,
          uncertainties: output.uncertainties,
          user_id: pipelineInput.user_id ?? null,
          // Boost above the standard auto-summary tier so the
          // "I just made attachment X at /api/uploads/X/raw" row
          // outranks generic-text auto rows when a follow-up like
          // "what was the image you generated?" matches both. Stays
          // under user pins (5) so explicit human signal still wins.
          authority_level: 4,
        });
      } catch (err) {
        logger.warn({ err, task_id }, "writeAutoSummary threw (non-fatal) for image task");
      }
    }

    return {
      task_id,
      tri_state,
      task_type: "image_generation",
      final_status,
      bos_output: output,
    };
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

  // BOP.CANON_GOVERNANCE.v1: the only remaining runtime block at this
  // stage is "missing required API dependency" (no eligible provider).
  // The previous Tri-State collapse engine — which folded confidence,
  // intent clarity, missing_info, ambiguity, and high_stakes_domain
  // into a HOLD/ABORT/GO verdict — has been removed. Tri-State is now
  // populated as display-only metadata from the model's OWN output
  // after execution completes (see persistTriStateDecision below).
  if (models.length === 0) {
    const reason = `No eligible LLM provider available for task_type="${task_type}". Configure or enable an eligible provider.`;
    const base: BosOutput = {
      state: "HOLD",
      task_type,
      answer: `BOS-OMEGA HOLD: ${reason}`,
      assumptions: [],
      uncertainties: [],
      missing_inputs: [],
      failure_modes: ["no_provider_available"],
      recommended_next_action: "Configure an eligible provider/model and retry.",
    };
    const output = attachDenial(base, "no_provider_available", reason);
    await saveTask(task_id, pipelineInput.input, task_type, "HOLD", resolved_mode, undefined, undefined, "HELD", JSON.stringify(output), pipelineInput.user_id ?? null, pipelineInput.conversation_decision ?? null);
    await auditLog(task_id, "TASK_HELD", reason, { cause: "no_provider_available", task_type });
    // Persist a display-only tri-state row mirroring the runtime decision
    // so the existing /api/tri-state/by-task endpoint always has data.
    await persistTriStateDecision(task_id, buildTriStateMetadata({ state: "HOLD", answer: reason }, 0));
    return { task_id, tri_state: "HOLD", task_type, final_status: "HELD", bos_output: output };
  }

  await auditLog(task_id, "MODEL_SELECTED", `Selected ${models.slice(0, 3).map((m) => `${m.provider_name}/${m.model_name}`).join(", ")}`, {
    count: models.length,
  });

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
    pipelineInput.conversation_decision ?? null,
  );

  // Task #46: build memory_context once at the orchestrator level so every
  // execution mode (single, parallel, consensus, series_pass, boil_the_ocean)
  // sees the same retrieved memory through the same channel. Previously
  // executionEngine.executePipeline fetched only canon+scratchpad inline,
  // which meant continuity/patches were silently dropped and series_pass
  // and boil_the_ocean ran with no memory at all.
  // BOP.CANON_GOVERNANCE.v1: Canon is the model's behavior contract
  // (Tri-State labelling, greeting style, uncertainty handling, etc.).
  // If it fails to load, the model would receive only the user prompt
  // with no governance overlay, silently breaking the contract. Fail
  // fast with CANON_LOAD_ERROR so the route layer surfaces a 500.
  let canon_sel: Awaited<ReturnType<typeof getCanonMemory>>;
  let continuity_sel: Awaited<ReturnType<typeof getContinuityMemory>>;
  let patches_sel: Awaited<ReturnType<typeof getPatchesMemory>>;
  let scratchpad_sel: Awaited<ReturnType<typeof getScratchpad>>;
  // Task #59: resolve the user's per-layer budget overrides (or defaults
  // when no row exists) BEFORE invoking the memory layer fetchers so each
  // layer's greedy fit runs against the user's chosen ceiling. Anonymous
  // / pre-user-id tasks fall through to defaults inside getEffectiveBudgets.
  const effective_budgets = await getEffectiveBudgets(pipelineInput.user_id ?? null);
  try {
    // Task #67 — pass user_id to non-canon layer fetchers so per-user
    // memory rows (the auto-summary writer's output and freeform manual
    // notes) cannot leak across users when the model context is built.
    // Canon stays global (no user_id) by design — it's the global
    // behaviour contract every request shares.
    const memory_user_id = pipelineInput.user_id ?? null;
    [canon_sel, continuity_sel, patches_sel, scratchpad_sel] = await Promise.all([
      getCanonMemory(gate.sanitized_input, effective_budgets.canon),
      getContinuityMemory(gate.sanitized_input, effective_budgets.continuity, memory_user_id),
      getPatchesMemory(gate.sanitized_input, effective_budgets.patches, memory_user_id),
      getScratchpad(gate.sanitized_input, effective_budgets.scratchpad, memory_user_id),
    ]);
  } catch (err) {
    await auditLog(task_id, "CANON_LOAD_ERROR", "Canon memory load failed; refusing to call model without governance overlay", {
      err_message: err instanceof Error ? err.message : String(err),
    });
    throw new CanonLoadError("Failed to load Canon memory layer", err);
  }
  if (canon_sel.items.length === 0) {
    await auditLog(task_id, "CANON_LOAD_ERROR", "Canon memory layer is empty; refusing to call model without governance overlay", {
      canon_items: 0,
    });
    throw new CanonLoadError("Canon memory layer is empty");
  }
  // Hash + version of the canon block we're about to inject so every
  // task carries a stable fingerprint of which Canon governed it. The
  // hash is computed over the rendered canon strings (in the same order
  // injected) so any text edit in any canon row changes the fingerprint.
  const canon_concat = canon_sel.items.join("\n---\n");
  const canon_hash = hashInput(canon_concat);
  await auditLog(task_id, "CANON_HASH_LOGGED", `Canon fingerprint sha256:${canon_hash.slice(7, 23)}…`, {
    canon_hash,
    canon_version: canon_sel.items.length,
    canon_chars: canon_concat.length,
  });
  const memory_context = buildContextFromMemory(
    canon_sel.items,
    continuity_sel.items,
    patches_sel.items,
    scratchpad_sel.items,
  );
  // Audit metadata: per-layer item counts + per-layer dropped counts +
  // the rendered section header names + a bounded preview. The dropped
  // counts answer "why didn't the AI use my note?" — when non-zero, an
  // item ranked but did not fit the per-layer token budget. The header
  // list is what regression tests assert against (truncating the
  // rendered block can bury later headers when an upstream layer fills
  // the preview window).
  const section_headers = (memory_context.match(/=== [A-Z ]+ ===/g) ?? []);
  // Task #50: per-item provenance for the panel. Concatenated in the same
  // layer order they appear in `memory_context` so the UI can render them
  // top-down without having to re-derive ordering. Each entry carries the
  // memory_items.id at the moment of injection so the panel can link back
  // to the source row in the Memory Manager — and detect rows that were
  // edited or deleted after the task ran (shown as "no longer available"
  // instead of a broken link).
  const injected_items = [
    ...canon_sel.injected,
    ...continuity_sel.injected,
    ...patches_sel.injected,
    ...scratchpad_sel.injected,
  ];
  // Task #58: per-row provenance for the items the per-layer budget cut.
  // Same shape as `injected_items` (id, layer, title) so the Memory Used
  // panel (and the global Audit Log) can render them through the existing
  // MemoryInjectedItemsList component — clickable Memory Manager
  // deep-links plus "no longer available" markers when the source row was
  // deleted after the task ran. Layer order matches `injected_items` so
  // per-layer ordering on screen stays consistent.
  const dropped_items_full = [
    ...canon_sel.dropped_items,
    ...continuity_sel.dropped_items,
    ...patches_sel.dropped_items,
    ...scratchpad_sel.dropped_items,
  ];
  // Task #49: persist the full memory_context alongside the bounded preview.
  // The preview keeps the audit row cheap to render in the trace UI, while
  // memory_context_full is the un-truncated payload that "View full context"
  // serves on demand via GET /api/tasks/:id/memory-context. Without storing
  // the full text here we cannot faithfully reproduce what the AI saw —
  // memory items mutate over time, so re-rendering at request time would
  // show a different context than the one actually injected.
  // Task #52: alongside the dropped *count* per layer (added in #48), surface
  // the actual *titles* of the items the greedy budget fit had to skip. The
  // count alone tells the user "2 canon notes were trimmed" but not which
  // two — so the user cannot decide whether to bump authority, shorten the
  // note, or move it. The titles arrays are bounded to DROPPED_TITLES_CAP
  // inside selectLayer so this audit row stays cheap to render.
  await auditLog(task_id, "MEMORY_INJECTED", `Memory context built (${memory_context.length} chars)`, {
    canon_items: canon_sel.items.length,
    continuity_items: continuity_sel.items.length,
    patches_items: patches_sel.items.length,
    scratchpad_items: scratchpad_sel.items.length,
    canon_dropped: canon_sel.dropped,
    continuity_dropped: continuity_sel.dropped,
    patches_dropped: patches_sel.dropped,
    scratchpad_dropped: scratchpad_sel.dropped,
    canon_dropped_titles: canon_sel.dropped_titles,
    continuity_dropped_titles: continuity_sel.dropped_titles,
    patches_dropped_titles: patches_sel.dropped_titles,
    scratchpad_dropped_titles: scratchpad_sel.dropped_titles,
    memory_context_chars: memory_context.length,
    section_headers,
    memory_context_preview: memory_context.slice(0, 8000),
    memory_context_full: memory_context,
    injected_items,
    // Task #58: per-row provenance for the budget-cut items so the panel
    // can render each dropped note with a Memory Manager deep-link, not
    // just count-and-title text. Same shape as injected_items so the UI
    // reuses the existing MemoryInjectedItemsList renderer.
    dropped_items: dropped_items_full,
    // Task #59: persist the per-layer budgets that ran for THIS task so
    // the Memory Used panel shows historically-accurate budget numbers in
    // the dropped-notice copy and per-tile tooltips, even after the user
    // edits their overrides. Without this, the panel would read the
    // user's CURRENT budgets and show wrong numbers for older tasks.
    budgets: {
      canon: effective_budgets.canon,
      continuity: effective_budgets.continuity,
      patches: effective_budgets.patches,
      scratchpad: effective_budgets.scratchpad,
    },
  });

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
    persona_slot: persona_slot_resolved?.slot,
    persona_prompt_text: persona_slot_resolved
      ? buildPersonaOverlay(persona_slot_resolved)
      : undefined,
    memory_context: memory_context || undefined,
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

  // R-1: parallel/consensus with effective N<2 also degrades. There are two
  // ways to land in single-model parallel:
  //   1. eligible model pool < 2 (registry too thin / circuit breakers open)
  //   2. user explicitly set parallel_models=1 even with a healthy pool
  // Either way, dispatching the same single model with one role overlay is
  // not "parallel" — it is single-shot wearing parallel clothing. We
  // downgrade and audit so the effective mode in the task is honest.
  if (resolved_mode === "parallel" || resolved_mode === "consensus") {
    const requested_parallel = pipelineInput.parallel_models || 3;
    const effective_count = Math.min(models.length, requested_parallel);
    if (effective_count < 2) {
      await auditLog(
        task_id,
        "MODE_DOWNGRADED",
        `${resolved_mode} requires >=2 models but effective_count=${effective_count} (eligible=${models.length}, requested=${requested_parallel}); degraded to single`,
        {
          from: resolved_mode,
          to: "single",
          eligible_models: models.length,
          requested_parallel,
          effective_count,
        },
      );
      resolved_mode = "single";
      ctx.mode = "single" as ExecutionMode;
    }
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

  // BOP.CANON_GOVERNANCE.v1: HOLD/ABORT outputs that came from the
  // model itself (Canon-driven self-labelling) get an explanation
  // attached. Note the cause has changed from `tri_state_*` to
  // `model_self_*` — the runtime no longer collapses Tri-State; the
  // model does.
  const result_with_denial: BosOutput = result.state === "GO"
    ? result
    : attachDenial(
        result,
        result.state === "ABORT" ? "model_self_aborted" : "model_self_held",
        result.recommended_next_action || result.answer,
      );

  // BOP.CANON_GOVERNANCE.v1: persist a display-only tri_state_decisions
  // row populated FROM the model output. The frontend / audit reader
  // continues to show a "decision" record per task, but the values now
  // mirror what the model itself decided rather than what a runtime
  // collapse engine forced. Confidence is sourced from the highest
  // parallel-response confidence_score when available, otherwise a
  // neutral 0.85 for GO and 0.5 for HOLD/ABORT.
  const display_confidence = result.parallel_responses && result.parallel_responses.length > 0
    ? Math.max(...result.parallel_responses.map((p) => p.confidence_score ?? 0))
    : (result.state === "GO" ? 0.85 : 0.5);
  const tri_meta = buildTriStateMetadata(result, display_confidence);
  const tri_decision_id = await persistTriStateDecision(task_id, tri_meta);
  await auditLog(task_id, "TRI_STATE_RECORDED", `Tri-state from model output: ${tri_meta.state}`, {
    state: tri_meta.state,
    confidence: tri_meta.confidence_score.toFixed(3),
    source: "model_output",
    canon_hash,
    decision_id: tri_decision_id,
    display_only: true,
  });

  await db.update(tasksTable)
    .set({
      final_status,
      final_output: JSON.stringify(result_with_denial),
      selected_provider: models[0]?.provider_name,
      selected_model: models[0]?.model_name,
      mode: resolved_mode,
      tri_state: result.state,
    })
    .where(eq(tasksTable.id, task_id));

  await auditLog(task_id, "TASK_COMPLETED", `Task completed with state ${result_with_denial.state}`, { mode: resolved_mode, run_id, canon_hash });

  // Task #67 — Lattice continuity scratchpad auto-summary writer.
  // Fires AFTER TASK_COMPLETED so the audit chain is complete even when
  // the writer fails. Belt-and-suspenders try/catch around an internally
  // non-throwing helper: writer failures must never observably affect
  // task output. Skipped when state is ABORT to avoid persisting safety-
  // refusal text into the model's continuity context.
  if (result_with_denial.state !== "ABORT") {
    try {
      await writeAutoSummary({
        task_id,
        task_type,
        state: result_with_denial.state,
        answer: result_with_denial.answer ?? "",
        input_text: pipelineInput.input,
        assumptions: result_with_denial.assumptions,
        uncertainties: result_with_denial.uncertainties,
        user_id: pipelineInput.user_id ?? null,
      });
    } catch (err) {
      logger.warn({ err, task_id }, "writeAutoSummary threw (non-fatal)");
    }
  }

  return {
    task_id,
    tri_state: result.state,
    task_type,
    selected_provider: models[0]?.provider_name,
    selected_model: models[0]?.model_name,
    final_status,
    bos_output: result_with_denial,
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

/**
 * Insert (or, on subsequent calls during the same pipeline run, leave
 * to the dedicated `db.update(tasksTable)` call sites) the tasks row,
 * and — if a `conversation_decision` is provided — atomically commit
 * that decision in the same transaction. This is the enforcement
 * point for the "no empty conversations" invariant: if the task
 * INSERT fails, the conversation INSERT/UPDATE rolls back too.
 *
 * Note: subsequent saveTask calls in the same pipeline run (e.g. when
 * the gate ABORTS after a GO row was already inserted) hit a primary-
 * key conflict on `tasks.id` — but historically those flows always
 * called saveTask exactly once per task_id, so this remains a single-
 * INSERT path. The decision is consumed only on the first call (the
 * caller passes null on subsequent calls); guarded by the runtime
 * order in the orchestrator.
 */
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
  conversation_decision:
    | import("./conversationClusterer.js").ConvDecision
    | null = null,
): Promise<void> {
  // Lazy import to avoid a circular type ref at the top of pipeline.ts.
  const { commitConversationDecision } = await import("./conversationClusterer.js");
  const conversation_id = conversation_decision?.conversation_id ?? null;
  await db.transaction(async (tx) => {
    if (conversation_decision && user_id) {
      await commitConversationDecision(
        conversation_decision,
        user_id,
        task_id,
        new Date(),
        tx,
      );
    }
    await tx.insert(tasksTable).values({
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
      conversation_id,
    });
  });
}
