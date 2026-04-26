import { db } from "@workspace/db";
import {
  modelAttemptsTable,
  validationResultsTable,
  fallbackEventsTable,
  llmProvidersTable,
  llmModelsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import type { BosOutput, LLMCallResult, ModelScore, TaskContext, ParallelResponse } from "./types.js";
import { validateOutput } from "./validationEngine.js";
import { repairOutput } from "./repairEngine.js";
import { recordSuccess, recordFailure, ensureProviderHealth } from "./circuitBreaker.js";
import { auditLog } from "./auditEngine.js";
import { getCanonMemory, getScratchpad, buildContextFromMemory } from "./memoryEngine.js";
import { resolveProviderKey } from "../lib/keyResolver.js";
import { callOpenAI } from "../providers/openaiAdapter.js";
import { callAnthropic } from "../providers/anthropicAdapter.js";
import { callGemini } from "../providers/geminiAdapter.js";
import { callOllama } from "../providers/ollamaAdapter.js";
import { callGenericOpenAI } from "../providers/genericAdapter.js";
import { logger } from "../lib/logger.js";
import { MOCK_MODE_NOTICE } from "../providers/prompts.js";

const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = [1000, 2000, 4000];

export async function executePipeline(
  ctx: TaskContext,
  selected_models: ModelScore[]
): Promise<{ result: BosOutput; attempts_saved: string[] }> {
  const [canon, scratchpad] = await Promise.all([
    getCanonMemory(),
    getScratchpad(),
  ]);
  const memory_context = buildContextFromMemory(canon, scratchpad);

  if (ctx.mode === "parallel" || ctx.mode === "consensus") {
    return executeParallel(ctx, selected_models, memory_context);
  }

  return executeSingle(ctx, selected_models, memory_context);
}

function buildOptions(ctx: TaskContext, memory_context: string, supports_vision: boolean) {
  return {
    memory_context,
    attachment_context: ctx.attachment_context,
    images: supports_vision ? ctx.attachment_images : undefined,
  };
}

async function executeSingle(
  ctx: TaskContext,
  models: ModelScore[],
  memory_context: string
): Promise<{ result: BosOutput; attempts_saved: string[] }> {
  const attempts_saved: string[] = [];

  for (let i = 0; i < models.length; i++) {
    const model_info = models[i];
    if (!model_info) continue;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      await ensureProviderHealth(model_info.provider_id);
      await auditLog(ctx.task_id, "LLM_CALL_STARTED", `Calling ${model_info.provider_name}/${model_info.model_name}`, { attempt });

      const result = await callProvider(ctx, model_info, memory_context);
      const attempt_id = await saveAttempt(ctx.task_id, model_info, result, attempt + 1, false, undefined);
      attempts_saved.push(attempt_id);

      if (!result.success) {
        await recordFailure(model_info.provider_id, result.error_type || "unknown_exception");
        await auditLog(ctx.task_id, "LLM_CALL_FAILED", `Provider ${model_info.provider_name} failed: ${result.error_type}`, { error_type: result.error_type });

        if (result.error_type === "auth_failure") break;
        if (result.error_type === "timeout" || result.error_type === "rate_limit") {
          if (attempt < MAX_RETRIES - 1) {
            await sleep(RETRY_BACKOFF_MS[attempt] || 4000);
            continue;
          }
        }
        if (i + 1 < models.length) {
          await logFallback(ctx.task_id, model_info, models[i + 1]!, `Provider error: ${result.error_type}`);
        }
        break;
      }

      await recordSuccess(model_info.provider_id, result.latency_ms);
      await auditLog(ctx.task_id, "LLM_CALL_COMPLETED", `Got response from ${model_info.provider_name}`, { latency_ms: result.latency_ms });

      const raw = result.raw_response!;
      let validation = validateOutput(raw, ctx.task_type);
      await saveValidation(ctx.task_id, attempt_id, validation);

      if (!validation.passed) {
        if (validation.notes.includes("unsafe_output")) {
          await auditLog(ctx.task_id, "TASK_ABORTED", "Unsafe output detected");
          return { result: buildAbortOutput("Unsafe output detected"), attempts_saved };
        }

        await auditLog(ctx.task_id, "REPAIR_APPLIED", "Attempting output repair");
        const { repaired } = repairOutput(raw, validation);
        validation = validateOutput(repaired, ctx.task_type);

        if (!validation.passed && validation.confidence_score < 0.3 && i + 1 < models.length) {
          await logFallback(ctx.task_id, model_info, models[i + 1]!, "Low confidence after repair");
          break;
        }
      }

      const parsed = parseOutput(validation.passed ? raw : (repairOutput(raw, validation)).repaired, ctx.input);
      await auditLog(ctx.task_id, "TASK_COMPLETED", `Task completed with state ${parsed.state}`);
      return { result: parsed, attempts_saved };
    }
  }

  await auditLog(ctx.task_id, "TASK_HELD", "All models failed, returning safe failure");
  return { result: buildSafeFailure(), attempts_saved };
}

async function executeParallel(
  ctx: TaskContext,
  models: ModelScore[],
  memory_context: string
): Promise<{ result: BosOutput; attempts_saved: string[] }> {
  await auditLog(ctx.task_id, "PARALLEL_EXECUTION_STARTED", `Running ${models.length} models in parallel`);

  const parallel_group = randomUUID();
  const calls = models.map((m) => callProvider(ctx, m, memory_context));
  const results = await Promise.allSettled(calls);

  const attempts_saved: string[] = [];
  const parallel_responses: ParallelResponse[] = [];

  for (let i = 0; i < results.length; i++) {
    const res = results[i];
    const model_info = models[i];
    if (!model_info) continue;

    const result: LLMCallResult = res.status === "fulfilled"
      ? res.value
      : { success: false, latency_ms: 0, error_type: "unknown_exception", error_message: "Promise rejected", provider: model_info.provider_name, model: model_info.model_name };

    const attempt_id = await saveAttempt(ctx.task_id, model_info, result, 1, true, parallel_group);
    attempts_saved.push(attempt_id);

    if (result.success && result.raw_response) {
      const validation = validateOutput(result.raw_response, ctx.task_type);
      await saveValidation(ctx.task_id, attempt_id, validation);
      const parsed = parseOutput(result.raw_response, ctx.input);

      parallel_responses.push({
        provider: model_info.provider_name,
        model: model_info.model_name,
        state: parsed.state,
        answer: parsed.answer,
        confidence_score: validation.confidence_score,
        latency_ms: result.latency_ms,
        selected: false,
      });

      if (result.success) await recordSuccess(model_info.provider_id, result.latency_ms);
    } else {
      await recordFailure(model_info.provider_id, result.error_type || "unknown_exception");
    }
  }

  if (parallel_responses.length === 0) {
    await auditLog(ctx.task_id, "TASK_HELD", "All parallel calls failed");
    return { result: buildSafeFailure(), attempts_saved };
  }

  const merged = mergeParallelResponses(parallel_responses, ctx.mode);
  await auditLog(ctx.task_id, "MERGE_COMPLETED", `Merged ${parallel_responses.length} responses using ${ctx.mode} strategy`);

  return { result: merged, attempts_saved };
}

function mergeParallelResponses(responses: ParallelResponse[], mode: string): BosOutput {
  responses.sort((a, b) => b.confidence_score - a.confidence_score);

  if (mode === "consensus") {
    const go_count = responses.filter((r) => r.state === "GO").length;
    const abort_count = responses.filter((r) => r.state === "ABORT").length;
    const majority = Math.ceil(responses.length / 2);

    if (abort_count > 0) {
      responses[responses.length - 1]!.selected = true;
      return buildAbortOutput("Consensus: at least one model flagged ABORT");
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

function synthesizeAnswers(answers: string[]): string {
  if (answers.length === 1) return answers[0]!;
  const unique = [...new Set(answers)];
  if (unique.length === 1) return unique[0]!;

  return answers
    .map((a, i) => `[Model ${i + 1}]:\n${a}`)
    .join("\n\n---\n\n") +
    "\n\n---\n\n[MERGED SYNTHESIS]: The above responses converge on the answer provided by the highest-confidence model.";
}

async function callProvider(
  ctx: TaskContext,
  model_info: ModelScore,
  memory_context: string,
): Promise<LLMCallResult> {
  const provider_name = model_info.provider_name.toLowerCase();
  const input = ctx.input;
  const task_type = ctx.task_type;
  const provider_row = await db
    .select()
    .from(llmProvidersTable)
    .where(eq(llmProvidersTable.id, model_info.provider_id))
    .limit(1);

  const provider = provider_row[0];
  const { key, base_url: proxy_base_url } = await resolveProviderKey(model_info.provider_id, model_info.provider_name);

  // Vision is only safe to send when the model itself is multimodal.
  // Sending image content to text-only models on a vision-capable provider
  // (e.g. gpt-3.5 on OpenAI) will produce 400s or silently misbehave.
  const supports_vision = (model_info.capability_tags ?? []).includes("multimodal");

  if (provider_name === "openai") {
    if (!key) return mockResult(model_info, input, task_type);
    return callOpenAI(input, task_type, model_info.model_name, key, buildOptions(ctx, memory_context, supports_vision), proxy_base_url);
  }

  if (provider_name === "anthropic") {
    if (!key) return mockResult(model_info, input, task_type);
    return callAnthropic(input, task_type, model_info.model_name, key, buildOptions(ctx, memory_context, supports_vision), proxy_base_url);
  }

  if (provider_name === "gemini" || provider_name === "google gemini") {
    if (!key) return mockResult(model_info, input, task_type);
    return callGemini(input, task_type, model_info.model_name, key, buildOptions(ctx, memory_context, supports_vision), proxy_base_url);
  }

  if (provider_name === "ollama") {
    const base_url = provider?.base_url || process.env["OLLAMA_BASE_URL"] || "http://localhost:11434";
    return callOllama(input, task_type, model_info.model_name, base_url, buildOptions(ctx, memory_context, false));
  }

  const base_url = provider?.base_url || "";
  if (!key || !base_url) return mockResult(model_info, input, task_type);
  return callGenericOpenAI(input, task_type, model_info.model_name, base_url, key, buildOptions(ctx, memory_context, false));
}

function mockResult(model_info: ModelScore, input: string, task_type: string): LLMCallResult {
  const mock: BosOutput = {
    state: "GO",
    task_type,
    answer: `${MOCK_MODE_NOTICE}\n\nThis is a mock response from ${model_info.provider_name}/${model_info.model_name}.\n\nYour input was: "${input.slice(0, 200)}${input.length > 200 ? "..." : ""}"\n\nTo receive real responses, configure API keys via environment variables (OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY).`,
    assumptions: ["Mock mode active — no real API key configured"],
    uncertainties: ["This response is simulated"],
    missing_inputs: [],
    failure_modes: ["Real API call not made"],
    recommended_next_action: "Configure provider API keys to enable live responses",
  };
  return {
    success: true,
    raw_response: JSON.stringify(mock),
    latency_ms: Math.floor(Math.random() * 200) + 50,
    token_input: Math.floor(input.length / 4),
    token_output: 150,
    cost_estimate: 0,
    provider: model_info.provider_name,
    model: model_info.model_name,
  };
}

async function saveAttempt(
  task_id: string,
  model_info: ModelScore,
  result: LLMCallResult,
  attempt_number: number,
  is_parallel: boolean,
  parallel_group: string | undefined
): Promise<string> {
  const id = randomUUID();
  await db.insert(modelAttemptsTable).values({
    id,
    task_id,
    provider: model_info.provider_name,
    model: model_info.model_name,
    attempt_number,
    status: result.success ? "success" : "failed",
    error_type: result.error_type || null,
    latency_ms: result.latency_ms,
    token_input: result.token_input || null,
    token_output: result.token_output || null,
    cost_estimate: result.cost_estimate || null,
    raw_response: result.raw_response || result.error_message || null,
    is_parallel,
    parallel_group: parallel_group || null,
  });
  return id;
}

async function saveValidation(task_id: string, attempt_id: string, v: ReturnType<typeof validateOutput>): Promise<void> {
  await db.insert(validationResultsTable).values({
    id: randomUUID(),
    task_id,
    attempt_id,
    schema_pass: v.schema_pass,
    safety_pass: v.safety_pass,
    instruction_pass: v.instruction_pass,
    completeness_pass: v.completeness_pass,
    confidence_score: v.confidence_score,
    notes: v.notes,
  });
}

async function logFallback(task_id: string, from: ModelScore, to: ModelScore, reason: string): Promise<void> {
  await db.insert(fallbackEventsTable).values({
    id: randomUUID(),
    task_id,
    from_provider: from.provider_name,
    from_model: from.model_name,
    to_provider: to.provider_name,
    to_model: to.model_name,
    reason,
  });
  await auditLog(task_id, "FALLBACK_TRIGGERED", `Falling back from ${from.provider_name} to ${to.provider_name}: ${reason}`);
}

function parseOutput(raw: string, input: string): BosOutput {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]) as Partial<BosOutput>;
      return {
        state: (["GO", "HOLD", "ABORT"].includes(parsed.state as string) ? parsed.state : "GO") as BosOutput["state"],
        task_type: parsed.task_type || "general",
        answer: parsed.answer || raw.slice(0, 2000),
        assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions : [],
        uncertainties: Array.isArray(parsed.uncertainties) ? parsed.uncertainties : [],
        missing_inputs: Array.isArray(parsed.missing_inputs) ? parsed.missing_inputs : [],
        failure_modes: Array.isArray(parsed.failure_modes) ? parsed.failure_modes : [],
        recommended_next_action: parsed.recommended_next_action || "Review the answer above",
        parallel_responses: parsed.parallel_responses,
        merge_strategy: parsed.merge_strategy,
      };
    }
  } catch {}
  return {
    state: "GO",
    task_type: "general",
    answer: raw.slice(0, 2000),
    assumptions: [],
    uncertainties: ["Response could not be fully parsed"],
    missing_inputs: [],
    failure_modes: [],
    recommended_next_action: "Review the raw answer above",
  };
}

function buildAbortOutput(reason: string): BosOutput {
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

function buildSafeFailure(): BosOutput {
  return {
    state: "HOLD",
    task_type: "general",
    answer: "BOS-OMEGA could not complete this task. All available LLM providers have been exhausted or are unavailable.",
    assumptions: [],
    uncertainties: ["Provider availability issue"],
    missing_inputs: [],
    failure_modes: ["All providers failed"],
    recommended_next_action: "Check provider health dashboard and verify API keys are configured",
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
