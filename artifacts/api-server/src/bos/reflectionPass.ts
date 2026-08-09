/**
 * BOS-OMEGA Reflection Pass — self-critique + improvement after every answer.
 *
 * The user said: "add reflection to the runtime".
 *
 * Reflection = after the model produces its initial answer, run a second
 * pass that re-reads the answer and improves it. The reflection pass is
 * NOT a copy-edit or a tone tweak — it specifically asks:
 *
 *   1. Did the answer actually answer the operator's question?
 *      (vs. asking for clarification when the question was answerable)
 *   2. Are the assumptions explicit and reasonable?
 *   3. Did the model default to GO with assumptions (per the 2026-08-09
 *      ANSWER-FIRST OPERATOR POSTURE) or did it return a "please clarify"
 *      HOLD that the operator now has to chase down?
 *   4. Is the answer specific enough to act on, or is it a hand-wave?
 *   5. Is there a concrete recommended next action?
 *
 * The reflection pass produces a new answer that's typically tighter,
 * more specific, and more actionable than the original. The original
 * is preserved in the audit chain so the operator can compare.
 *
 * The reflection is NOT a "second opinion" / "what would another model
 * say" — it's the model critiquing ITS OWN first answer, which is the
 * cheapest and most effective way to catch a "please clarify" reflex
 * before the operator sees it.
 *
 * The reflection pass is enabled by default for the `single` and
 * `auto` modes. Operators can opt out per-task via
 * `disable_reflection: true` in the request body.
 */

import { db } from "@workspace/db";
import { reflectionRunsTable } from "@workspace/db";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import type { BosOutput, LLMCallResult, ModelScore, TaskContext } from "./types.js";
import { validateOutput } from "./validationEngine.js";
import { auditLog } from "./auditEngine.js";
import { callProvider } from "./executionEngine.js";
import { recordSuccess, recordFailure } from "./circuitBreaker.js";

const REFLECTION_PROMPT = `=== REFLECTION PASS — SELF-CRITIQUE ===

You are reviewing the FIRST-PASS answer below. Your job is to IMPROVE it,
not to summarize it. The operator is a non-technical super-admin who
treats the AI as a junior employee: do the work, ask only when the work
is genuinely impossible.

Apply these checks in order:
1. ANSWER THE QUESTION: Did the first pass actually answer the
   operator's question, or did it return a "please clarify" HOLD when
   the question was answerable? If it was a "please clarify" HOLD,
   REWRITE IT — make the most reasonable interpretation, state your
   assumptions explicitly, and deliver the best answer you can.
2. SPECIFICITY: Is the answer specific enough to act on, or is it
   a hand-wave? If hand-wave, replace with concrete steps / numbers /
   names.
3. ASSUMPTIONS: Are the assumptions explicit and reasonable? If the
   answer made implicit assumptions, surface them.
4. NEXT ACTION: Is there a concrete, one-sentence recommended next
   action the operator can take right now? If not, add one.
5. TONE: Terse, direct, no fluff. The operator reads these answers
   on a phone between meetings.

Return the IMPROVED answer in the same BOS JSON schema:

{
  "state": "GO | HOLD | ABORT",
  "task_type": "string",
  "answer": "string — the IMPROVED response",
  "assumptions": ["string"],
  "uncertainties": ["string"],
  "missing_inputs": ["string"],
  "failure_modes": ["string"],
  "recommended_next_action": "string"
}

The first-pass answer below is your starting point. You are allowed to
keep it if it's already good — but if you can improve it, do so. State
= GO unless the request is actually unsafe (per the master kernel's 5
hard no-goes).

=== OPERATOR'S QUESTION ===
{{OPERATOR_INPUT}}

=== FIRST-PASS ANSWER ===
{{FIRST_PASS_ANSWER}}

=== FIRST-PASS STATE ===
{{FIRST_PASS_STATE}}

Return ONLY the improved JSON object. No markdown, no preamble, no
explanation outside the JSON.`;

/**
 * Run a reflection pass on a first-pass BosOutput. Returns the
 * (potentially) improved BosOutput. If the reflection call itself
 * fails, the original is returned unchanged — reflection is a quality
 * improvement, never a quality regression.
 */
export async function runReflectionPass(
  ctx: TaskContext,
  first_pass: BosOutput,
  model_for_reflection: ModelScore,
  memory_context: string,
): Promise<{ result: BosOutput; reflection_id: string | null; improved: boolean }> {
  const reflection_id = randomUUID();
  await auditLog(ctx.task_id, "REFLECTION_STARTED",
    `Reflection pass on first-pass answer (state=${first_pass.state}) via ${model_for_reflection.provider_name}/${model_for_reflection.model_name}`,
    { reflection_id, first_pass_state: first_pass.state, provider: model_for_reflection.provider_name });

  const reflection_input = REFLECTION_PROMPT
    .replace("{{OPERATOR_INPUT}}", ctx.input)
    .replace("{{FIRST_PASS_ANSWER}}", first_pass.answer ?? "(empty)")
    .replace("{{FIRST_PASS_STATE}}", first_pass.state ?? "?");

  const reflection_ctx: TaskContext = {
    ...ctx,
    input: reflection_input,
    attachment_context: undefined,
  };

  let reflection_result: LLMCallResult;
  try {
    reflection_result = await callProvider(reflection_ctx, model_for_reflection, memory_context, {
      role_overlay: "You are the reflection layer. Your job is to catch the 'please clarify' reflex and replace it with a concrete answer under stated assumptions. Be specific, terse, actionable.",
    });
  } catch (err) {
    await auditLog(ctx.task_id, "REFLECTION_FAILED", `Reflection call threw: ${(err as Error).message}`);
    return { result: first_pass, reflection_id: null, improved: false };
  }

  if (!reflection_result.success || !reflection_result.raw_response) {
    await recordFailure(model_for_reflection.provider_id, reflection_result.error_type || "unknown_exception");
    await auditLog(ctx.task_id, "REFLECTION_FAILED", `Reflection call failed: ${reflection_result.error_type}`);
    return { result: first_pass, reflection_id: null, improved: false };
  }

  await recordSuccess(model_for_reflection.provider_id, reflection_result.latency_ms);

  const validation = validateOutput(reflection_result.raw_response, ctx.task_type);

  let reflection_parsed: BosOutput;
  let parse_ok = true;
  try {
    const json_match = reflection_result.raw_response.match(/\{[\s\S]*\}/);
    reflection_parsed = json_match ? JSON.parse(json_match[0]) as BosOutput : {
      state: first_pass.state,
      task_type: ctx.task_type,
      answer: reflection_result.raw_response,
      assumptions: first_pass.assumptions ?? [],
      uncertainties: ["Could not parse structured reflection; showing raw."],
      missing_inputs: first_pass.missing_inputs ?? [],
      failure_modes: first_pass.failure_modes ?? [],
      recommended_next_action: first_pass.recommended_next_action ?? "",
    };
    if (!json_match) parse_ok = false;
  } catch {
    parse_ok = false;
    reflection_parsed = {
      state: first_pass.state,
      task_type: ctx.task_type,
      answer: reflection_result.raw_response,
      assumptions: first_pass.assumptions ?? [],
      uncertainties: ["Could not parse structured reflection; showing raw."],
      missing_inputs: first_pass.missing_inputs ?? [],
      failure_modes: first_pass.failure_modes ?? [],
      recommended_next_action: first_pass.recommended_next_action ?? "",
    };
  }

  const improved = isImprovement(first_pass, reflection_parsed, parse_ok);

  // Persist the reflection result for the audit chain regardless of
  // whether we adopt it.
  try {
    await db.insert(reflectionRunsTable).values({
      id: reflection_id,
      task_id: ctx.task_id,
      first_pass_state: first_pass.state,
      reflection_state: reflection_parsed.state,
      first_pass_answer: (first_pass.answer ?? "").slice(0, 4000),
      reflection_answer: (reflection_parsed.answer ?? "").slice(0, 4000),
      improved: improved ? "true" : "false",
      parse_ok: parse_ok ? "true" : "false",
      confidence: validation.confidence_score,
      provider: model_for_reflection.provider_name,
      model: model_for_reflection.model_name,
    });
  } catch (err) {
    // reflectionRunsTable might not exist yet on first deploy; the
    // reflection still works, we just lose the audit row.
    await auditLog(ctx.task_id, "REFLECTION_TABLE_INSERT_FAILED", `reflectionRunsTable insert failed: ${(err as Error).message}`);
  }

  await auditLog(ctx.task_id, "REFLECTION_COMPLETED",
    `Reflection pass ${improved ? "IMPROVED" : "no improvement"} (state ${first_pass.state} → ${reflection_parsed.state})`,
    { reflection_id, improved, first_pass_state: first_pass.state, reflection_state: reflection_parsed.state, parse_ok });

  // Adopt the reflection only if it's a strict improvement. We never
  // let the reflection REGRESS a good answer into a worse one.
  if (improved) {
    return { result: reflection_parsed, reflection_id, improved: true };
  }
  return { result: first_pass, reflection_id, improved: false };
}

/**
 * Decide whether the reflection result is a strict improvement over
 * the first pass. Rules:
 *   1. If parse failed, it's not an improvement (raw text is no better
 *      than what we had).
 *   2. If the first pass was ABORT and the reflection isn't, that's
 *      suspicious — a real safety call shouldn't get overruled by
 *      reflection. Don't adopt.
 *   3. If the first pass was HOLD and the reflection is GO with
 *      stated assumptions, that's an improvement — the operator
 *      wanted an answer, not a clarifying question.
 *   4. If both are GO, the reflection is an improvement if its answer
 *      is materially more specific (longer AND contains a concrete
 *      next action).
 *   5. Otherwise, no improvement — adopt the first pass.
 */
function isImprovement(first: BosOutput, second: BosOutput, parse_ok: boolean): boolean {
  if (!parse_ok) return false;
  if (first.state === "ABORT" && second.state !== "ABORT") return false;
  if (first.state === "HOLD" && second.state === "GO" && (second.assumptions?.length ?? 0) > 0) return true;
  if (first.state === "GO" && second.state === "GO") {
    const first_len = first.answer?.length ?? 0;
    const second_len = second.answer?.length ?? 0;
    const has_action = (second.recommended_next_action?.length ?? 0) > 0;
    return second_len > first_len * 1.2 && has_action;
  }
  return false;
}
