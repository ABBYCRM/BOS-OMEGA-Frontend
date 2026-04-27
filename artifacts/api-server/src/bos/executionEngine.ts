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
// #43: pure consensus/parallel merge logic lives in a no-deps module so
// the unit-test harness can import it without dragging @workspace/db
// (the strip-types loader cannot resolve the deep schema directory import).
import { mergeParallelResponses, buildAbortOutput } from "./consensusMerge.js";
export { mergeParallelResponses } from "./consensusMerge.js";
import { validateOutput, extractJsonCandidate } from "./validationEngine.js";
import { repairOutput } from "./repairEngine.js";
import { recordSuccess, recordFailure, ensureProviderHealth } from "./circuitBreaker.js";
import { auditLog } from "./auditEngine.js";
import { resolveProviderKey } from "../lib/keyResolver.js";
import { callOpenAI } from "../providers/openaiAdapter.js";
import { callAnthropic } from "../providers/anthropicAdapter.js";
import { callGemini } from "../providers/geminiAdapter.js";
import { callOllama } from "../providers/ollamaAdapter.js";
import { callGenericOpenAI } from "../providers/genericAdapter.js";
import { logger } from "../lib/logger.js";
import { MOCK_MODE_NOTICE, buildPersonaSystemSuffix } from "../providers/prompts.js";
import { assignRoles, buildRoleOverlay, type ParallelRole } from "./parallelRoles.js";

const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = [1000, 2000, 4000];

export async function executePipeline(
  ctx: TaskContext,
  selected_models: ModelScore[]
): Promise<{ result: BosOutput; attempts_saved: string[] }> {
  // Task #46: memory_context is built once by runBosPipeline (covering all
  // four memory layers) and threaded through TaskContext. Engines must not
  // refetch — partial in-engine fetches were the bug that dropped continuity
  // and patches and skipped memory entirely for series_pass / boil_the_ocean.
  const memory_context = ctx.memory_context ?? "";

  if (ctx.mode === "parallel" || ctx.mode === "consensus") {
    return executeParallel(ctx, selected_models, memory_context);
  }

  return executeSingle(ctx, selected_models, memory_context);
}

function buildOptions(
  ctx: TaskContext,
  memory_context: string,
  supports_vision: boolean,
  extras?: { role_overlay?: string },
) {
  return {
    memory_context,
    attachment_context: ctx.attachment_context,
    images: supports_vision ? ctx.attachment_images : undefined,
    // Prefer the resolved persona-slot overlay text (already wrapped with
    // its DOMAIN PERSONA header) over the legacy hardcoded persona id.
    persona_prompt: ctx.persona_prompt_text || buildPersonaSystemSuffix(ctx.persona) || undefined,
    // R-1: per-call role overlay used by parallel/consensus modes to
    // differentiate the perspective each model takes on the task.
    role_overlay: extras?.role_overlay,
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

        // BOP.CANON_GOVERNANCE.v1: removed the `confidence_score < 0.3`
        // fallback gate. Confidence is an advisory display score, not a
        // runtime routing decision. If the model returns something the
        // repair engine cannot fix, we still take its output — Canon
        // governs how the model labels its own uncertainty in the
        // response (HOLD / GO with caveats / etc.).
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
  // R-1: assign each model a different role (ARCHITECT/CRITIC/RESEARCHER/...)
  // so the parallel batch produces genuinely differentiated answers instead
  // of N near-identical takes. Role is stable for a given model order.
  const roles: ParallelRole[] = assignRoles(models.length);
  const role_summary = models
    .map((m, i) => `${roles[i]}=${m.provider_name}/${m.model_name}`)
    .join(", ");
  await auditLog(
    ctx.task_id,
    "PARALLEL_EXECUTION_STARTED",
    `Running ${models.length} models in parallel with role-differentiated prompts: ${role_summary}`,
    { roles: models.map((m, i) => ({ provider: m.provider_name, model: m.model_name, role: roles[i] })) },
  );

  const parallel_group = randomUUID();
  const calls = models.map((m, i) => callProvider(ctx, m, memory_context, { role_overlay: buildRoleOverlay(roles[i]!) }));
  const results = await Promise.allSettled(calls);

  const attempts_saved: string[] = [];
  const parallel_responses: ParallelResponse[] = [];

  for (let i = 0; i < results.length; i++) {
    const res = results[i];
    const model_info = models[i];
    const role = roles[i];
    if (!model_info || !role) continue;

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
        // R-1: suffix model with role so the UI/audit/logs immediately show
        // which model produced which role's output. Existing consumers that
        // only display model strings get the role attribution for free.
        model: `${model_info.model_name} (${role})`,
        state: parsed.state,
        answer: parsed.answer,
        confidence_score: validation.confidence_score,
        latency_ms: result.latency_ms,
        selected: false,
      });

      await auditLog(ctx.task_id, "PARALLEL_RESPONSE_RECEIVED",
        `${role} via ${model_info.provider_name}/${model_info.model_name} → state=${parsed.state}, confidence=${validation.confidence_score.toFixed(2)}`,
        { role, provider: model_info.provider_name, model: model_info.model_name, state: parsed.state, confidence: validation.confidence_score });

      await recordSuccess(model_info.provider_id, result.latency_ms);
    } else {
      await auditLog(ctx.task_id, "PARALLEL_RESPONSE_FAILED",
        `${role} via ${model_info.provider_name}/${model_info.model_name} → ${result.error_type || "unknown_exception"}`,
        { role, provider: model_info.provider_name, model: model_info.model_name, error_type: result.error_type });
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

// #43: mergeParallelResponses + synthesizeAnswers + buildAbortOutput moved
// to ./consensusMerge.ts so they can be unit-tested without dragging the
// @workspace/db import chain into the test harness. mergeParallelResponses
// is re-exported above for backwards compatibility; buildAbortOutput is
// imported above and used in executePipeline below.

async function callProvider(
  ctx: TaskContext,
  model_info: ModelScore,
  memory_context: string,
  extras?: { role_overlay?: string },
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

  // Vision is only safe to send when the model itself is multimodal.
  // Sending image content to text-only models on a vision-capable provider
  // (e.g. gpt-3.5 on OpenAI) will produce 400s or silently misbehave.
  const supports_vision = (model_info.capability_tags ?? []).includes("multimodal");

  // Task #46: per-call evidence that ctx.memory_context (built once by the
  // orchestrator) was actually threaded through to every adapter dispatch
  // in single/parallel/consensus modes. Mirrors the LLM_INPUT_PREPARED
  // event emitted by providerBridge.callProviderDirect for the
  // series_pass and boil_the_ocean code paths so the regression test can
  // assert on a uniform per-call payload across all 5 modes.
  const memory_chars = memory_context.length;
  await auditLog(ctx.task_id, "LLM_INPUT_PREPARED",
    `Prepared input for ${model_info.provider_name}/${model_info.model_name}`,
    {
      provider_name: model_info.provider_name,
      model: model_info.model_name,
      task_type,
      prompt_chars: input.length,
      memory_context_chars: memory_chars,
      // 32 KB preview is large enough to capture all four section bodies
      // (sum of per-layer token budgets ≈ 6250 tokens ≈ 25 KB at 4
      // chars/token) so the regression test can assert on the full
      // rendered context, not a header-truncated slice.
      memory_context_preview: memory_chars > 0 ? memory_context.slice(0, 32000) : "",
      attachment_context_chars: ctx.attachment_context?.length ?? 0,
      has_images: supports_vision && (ctx.attachment_images?.length ?? 0) > 0,
      persona_prompt_chars: (ctx.persona_prompt_text || buildPersonaSystemSuffix(ctx.persona) || "").length,
      role_overlay_chars: extras?.role_overlay?.length ?? 0,
    },
  );

  // R-5.5: Ollama bypasses resolveProviderKey entirely — emit a synthetic
  // KEY_RESOLVED so the audit chain still records the routing decision
  // for every model call regardless of provider type.
  if (provider_name === "ollama") {
    const base_url = provider?.base_url || process.env["OLLAMA_BASE_URL"] || "http://localhost:11434";
    await auditLog(ctx.task_id, "KEY_RESOLVED",
      `Ollama: no key required, base_url=${base_url}`,
      {
        provider_id: model_info.provider_id,
        provider_name: model_info.provider_name,
        model: model_info.model_name,
        source: "env",
        base_url,
        is_proxy: false,
        key_fingerprint: null,
        has_key: false,
      },
    );
    return callOllama(input, task_type, model_info.model_name, base_url, buildOptions(ctx, memory_context, false, extras));
  }

  const resolved = await resolveProviderKey(model_info.provider_id, model_info.provider_name);
  const { key, source, key_fingerprint } = resolved;
  const proxy_base_url = resolved.base_url ?? undefined;

  // R-5.3: every call records its routing decision before dispatch.
  await auditLog(ctx.task_id, "KEY_RESOLVED",
    `Resolved ${model_info.provider_name} key from source=${source}`,
    {
      provider_id: model_info.provider_id,
      provider_name: model_info.provider_name,
      model: model_info.model_name,
      source,
      base_url: proxy_base_url ?? null,
      is_proxy: source === "proxy",
      key_fingerprint: key_fingerprint || null,
      has_key: !!key,
    },
  );

  if (source === "proxy") {
    await auditLog(ctx.task_id, "PROXY_CALL",
      `Routing ${model_info.provider_name} via Replit AI Integrations proxy`,
      {
        provider_name: model_info.provider_name,
        model: model_info.model_name,
        base_url: proxy_base_url,
      },
    );
  }

  if (provider_name === "openai") {
    if (!key) {
      await auditLog(ctx.task_id, "MOCK_MODE_USED",
        `No key for ${model_info.provider_name} — returning failed mock`,
        { provider_id: model_info.provider_id, model: model_info.model_name });
      return mockResult(model_info, input, task_type);
    }
    return callOpenAI(input, task_type, model_info.model_name, key, buildOptions(ctx, memory_context, supports_vision, extras), proxy_base_url);
  }

  if (provider_name === "anthropic") {
    if (!key) {
      await auditLog(ctx.task_id, "MOCK_MODE_USED",
        `No key for ${model_info.provider_name} — returning failed mock`,
        { provider_id: model_info.provider_id, model: model_info.model_name });
      return mockResult(model_info, input, task_type);
    }
    return callAnthropic(input, task_type, model_info.model_name, key, buildOptions(ctx, memory_context, supports_vision, extras), proxy_base_url);
  }

  if (provider_name === "gemini" || provider_name === "google gemini") {
    if (!key) {
      await auditLog(ctx.task_id, "MOCK_MODE_USED",
        `No key for ${model_info.provider_name} — returning failed mock`,
        { provider_id: model_info.provider_id, model: model_info.model_name });
      return mockResult(model_info, input, task_type);
    }
    return callGemini(input, task_type, model_info.model_name, key, buildOptions(ctx, memory_context, supports_vision, extras), proxy_base_url);
  }

  const base_url = provider?.base_url || "";
  if (!key || !base_url) {
    await auditLog(ctx.task_id, "MOCK_MODE_USED",
      `No key/base_url for ${model_info.provider_name} (generic) — returning failed mock`,
      { provider_id: model_info.provider_id, model: model_info.model_name });
    return mockResult(model_info, input, task_type);
  }
  return callGenericOpenAI(input, task_type, model_info.model_name, base_url, key, buildOptions(ctx, memory_context, false, extras));
}

/**
 * R-5.4: mock-mode is now an honest failure. Previously this returned
 * `success: true` with fabricated latency and token counts, which made
 * mocked responses indistinguishable from real successful calls in the
 * audit chain and downstream provider_health stats. The raw_response
 * envelope is preserved so the UI can still render an explanation, but
 * the call is reported as a failure (`success: false`,
 * `error_type: "unknown_exception"`) so the existing fallback path,
 * circuit breaker, and parallel-merge logic all treat it as a real
 * failure rather than a successful answer.
 */
function mockResult(model_info: ModelScore, input: string, task_type: string): LLMCallResult {
  const mock: BosOutput = {
    state: "HOLD",
    task_type,
    answer: `${MOCK_MODE_NOTICE}\n\nNo API key was resolvable for ${model_info.provider_name}/${model_info.model_name}, so no real model call was made. This is a placeholder, not a real answer.\n\nYour input was: "${input.slice(0, 200)}${input.length > 200 ? "..." : ""}"\n\nTo receive real responses, configure API keys via environment variables (OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY) or via the Settings tab.`,
    assumptions: ["Mock mode active — no real API key configured"],
    uncertainties: ["This response is simulated; the underlying provider was never contacted"],
    missing_inputs: [`API key for ${model_info.provider_name}`],
    failure_modes: ["Real API call not made — no key resolvable"],
    recommended_next_action: "Configure provider API keys to enable live responses",
  };
  return {
    success: false,
    error_type: "unknown_exception",
    error_message: `No API key configured for ${model_info.provider_name}; mock response returned`,
    raw_response: JSON.stringify(mock),
    latency_ms: 0,
    token_input: 0,
    token_output: 0,
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
    // Reuse the hardened JSON extractor from validationEngine so prose-mixed
    // and fenced model outputs don't silently default to GO.
    const candidate = extractJsonCandidate(raw);
    if (candidate) {
      const parsed = JSON.parse(candidate) as Partial<BosOutput>;
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

// #43: buildAbortOutput moved to ./consensusMerge.ts (re-exported via the
// import at the top of this file). Keeping a single source-of-truth
// prevents drift between the consensus path and the executePipeline path.

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
