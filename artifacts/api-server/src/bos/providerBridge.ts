import { db } from "@workspace/db";
import { llmProvidersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { LLMCallResult, ModelScore, VisionImage } from "./types.js";
import { callOpenAI } from "../providers/openaiAdapter.js";
import { callAnthropic } from "../providers/anthropicAdapter.js";
import { callGemini } from "../providers/geminiAdapter.js";
import { callOllama } from "../providers/ollamaAdapter.js";
import { callGenericOpenAI } from "../providers/genericAdapter.js";
import { MOCK_MODE_NOTICE } from "../providers/prompts.js";
import { resolveProviderKey } from "../lib/keyResolver.js";
import { auditLog } from "./auditEngine.js";
import type { BosOutput } from "./types.js";

/**
 * Context that callers (series_pass, boil_the_ocean) can thread to per-agent
 * provider invocations. Image routing is gated on `model_info.capability_tags`
 * including "multimodal" so non-vision models do not receive base64 frames.
 */
export interface CallProviderOptions {
  attachment_context?: string;
  attachment_images?: VisionImage[];
  memory_context?: string;
  persona_prompt?: string;
  /**
   * R-5: optional task id used to attach KEY_RESOLVED / PROXY_CALL /
   * MOCK_MODE_USED audit events to a specific task. Callers in BTO and
   * series_pass already have ctx.task_id available; passing it here makes
   * the resolver/proxy decisions show up in the per-task audit pane.
   */
  task_id?: string;
  /**
   * R-1: optional per-call role overlay appended to the system prompt,
   * after persona and before memory. Used by parallel/consensus modes to
   * make each model approach the task from a different perspective
   * (ARCHITECT / CRITIC / RESEARCHER / BUILDER / VALIDATOR).
   */
  role_overlay?: string;
}

/**
 * Shared provider calling utility for all BOS engine modules.
 * Resolves keys via the agentic resolver: DB-stored encrypted key → env var
 * → legacy → Replit AI Integrations proxy. When the resolver returns
 * `source==="proxy"`, the returned `base_url` is forwarded to the adapter so
 * the request is routed through the proxy (NOT the hardcoded vendor URL).
 *
 * Without that base_url forwarding, proxy-issued credentials would be sent
 * to api.openai.com / api.anthropic.com / generativelanguage.googleapis.com
 * directly and would all 401 — exactly the BOIL_THE_OCEAN "auth_failure" and
 * SERIES_PASS empty-output regression we saw in production.
 */
export async function callProviderDirect(
  prompt: string,
  task_type: string,
  model_info: ModelScore,
  options: CallProviderOptions = {},
): Promise<LLMCallResult> {
  const provider_name = model_info.provider_name.toLowerCase();

  const provider_rows = await db
    .select()
    .from(llmProvidersTable)
    .where(eq(llmProvidersTable.id, model_info.provider_id))
    .limit(1);

  const provider = provider_rows[0];

  // Vision-gate: only forward base64 image data to models that advertise
  // multimodal support, mirroring the policy in executionEngine.buildOptions.
  const supports_vision = (model_info.capability_tags ?? []).includes("multimodal");
  const adapter_options = {
    memory_context: options.memory_context,
    attachment_context: options.attachment_context,
    images: supports_vision ? options.attachment_images : undefined,
    persona_prompt: options.persona_prompt,
    role_overlay: options.role_overlay,
  };

  // Task #46: per-call evidence that the orchestrator-built memory_context
  // actually reached the provider invocation. The MEMORY_INJECTED event
  // proves the orchestrator BUILT the context; this LLM_INPUT_PREPARED
  // event proves each engine THREADED it through to every model call
  // (including BTO synthesis/adversarial and series_pass per-step calls).
  // Without this, the e2e regression can only assert what was built, not
  // what was passed to providers.
  const memory_chars = options.memory_context?.length ?? 0;
  await auditLog(options.task_id, "LLM_INPUT_PREPARED",
    `Prepared input for ${model_info.provider_name}/${model_info.model_name}`,
    {
      provider_name: model_info.provider_name,
      model: model_info.model_name,
      task_type,
      prompt_chars: prompt.length,
      memory_context_chars: memory_chars,
      // 32 KB preview is enough to capture the full rendered context across
      // all four layers (sum of per-layer token budgets ≈ 6250 tokens ≈ 25 KB
      // at 4 chars/token) so the regression test can assert on the full
      // payload that reached the adapter, not a header-truncated slice.
      memory_context_preview: memory_chars > 0 ? options.memory_context!.slice(0, 32000) : "",
      attachment_context_chars: options.attachment_context?.length ?? 0,
      has_images: supports_vision && (options.attachment_images?.length ?? 0) > 0,
      persona_prompt_chars: options.persona_prompt?.length ?? 0,
      role_overlay_chars: options.role_overlay?.length ?? 0,
    },
  );

  // Ollama bypasses resolveProviderKey entirely (no key required), so emit
  // a synthetic KEY_RESOLVED with source="env" so the audit chain still has
  // a uniform per-call routing record. R-5.5.
  if (provider_name === "ollama") {
    const base_url = provider?.base_url || process.env["OLLAMA_BASE_URL"] || "http://localhost:11434";
    await auditLog(options.task_id, "KEY_RESOLVED",
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
    return callOllama(prompt, task_type, model_info.model_name, base_url, adapter_options);
  }

  const resolved = await resolveProviderKey(
    model_info.provider_id,
    model_info.provider_name,
  );
  const { key, source, key_fingerprint } = resolved;
  // Coerce a possibly-omitted base_url to undefined so the adapter's
  // default-parameter (vendor URL) kicks in. JS only applies default params
  // when the argument is literally `undefined` — passing `null` would crash.
  const proxy_base_url = resolved.base_url ?? undefined;

  // R-5.3: every call records its routing decision before dispatch.
  await auditLog(options.task_id, "KEY_RESOLVED",
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
    await auditLog(options.task_id, "PROXY_CALL",
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
      await auditLog(options.task_id, "MOCK_MODE_USED",
        `No key for ${model_info.provider_name} — returning failed mock`,
        { provider_id: model_info.provider_id, model: model_info.model_name });
      return mockResult(model_info, prompt, task_type);
    }
    return callOpenAI(prompt, task_type, model_info.model_name, key, adapter_options, proxy_base_url);
  }

  if (provider_name === "anthropic") {
    if (!key) {
      await auditLog(options.task_id, "MOCK_MODE_USED",
        `No key for ${model_info.provider_name} — returning failed mock`,
        { provider_id: model_info.provider_id, model: model_info.model_name });
      return mockResult(model_info, prompt, task_type);
    }
    return callAnthropic(prompt, task_type, model_info.model_name, key, adapter_options, proxy_base_url);
  }

  if (provider_name === "gemini" || provider_name === "google gemini") {
    if (!key) {
      await auditLog(options.task_id, "MOCK_MODE_USED",
        `No key for ${model_info.provider_name} — returning failed mock`,
        { provider_id: model_info.provider_id, model: model_info.model_name });
      return mockResult(model_info, prompt, task_type);
    }
    return callGemini(prompt, task_type, model_info.model_name, key, adapter_options, proxy_base_url);
  }

  const base_url = provider?.base_url || "";
  if (!key || !base_url) {
    await auditLog(options.task_id, "MOCK_MODE_USED",
      `No key/base_url for ${model_info.provider_name} (generic) — returning failed mock`,
      { provider_id: model_info.provider_id, model: model_info.model_name });
    return mockResult(model_info, prompt, task_type);
  }
  return callGenericOpenAI(prompt, task_type, model_info.model_name, base_url, key, adapter_options);
}

/**
 * R-5.4: mock-mode is now an honest failure. Previously this returned
 * `success: true` with fabricated latency and token counts, which made
 * mocked responses indistinguishable from real successful calls in the
 * audit chain and downstream provider_health stats. The raw_response
 * envelope is preserved so the UI can still render an explanation, but
 * the call is reported as a failure (`success: false`,
 * `error_type: "unknown_exception"`) so:
 *   - executePipeline takes the existing fallback path
 *   - the no-key provider's circuit breaker correctly accrues failure
 *   - parallel mode treats mocked calls as failed parallel calls
 *   - the final response degrades to HOLD with a clear failure mode
 */
function mockResult(model_info: ModelScore, prompt: string, task_type: string): LLMCallResult {
  const preview = prompt.slice(0, 300);
  const role_match = prompt.match(/ROLE: (\w+)/);
  const agent_match = prompt.match(/AGENT: (\w+)/);
  const role = role_match?.[1] || agent_match?.[1] || "PROCESSOR";

  const mock: BosOutput = {
    state: "HOLD",
    task_type,
    answer: `${MOCK_MODE_NOTICE}\n\n[${role} via ${model_info.provider_name}/${model_info.model_name}]\n\nNo API key was resolvable for this provider, so no real model call was made. This is a placeholder, not a real answer.\n\nTask preview: "${preview.slice(0, 200)}..."\n\nPaste an API key in Settings to enable live responses.`,
    assumptions: ["Mock mode active — no real API key configured", `Role: ${role}`],
    uncertainties: ["This response is simulated; the underlying provider was never contacted"],
    missing_inputs: [`API key for ${model_info.provider_name}`],
    failure_modes: ["Real API call not made — no key resolvable"],
    recommended_next_action: "Configure the provider key in Settings or set the appropriate environment variable.",
  };

  const extra: Record<string, unknown> = {
    agent_role: role,
    key_points: [`[MOCK] ${role} perspective not available without API key`],
    errors_found: role === "CRITIC" ? ["[MOCK] Critique not available without API key"] : [],
    pass_role: role,
    adversarial_findings: role === "ADVERSARY" ? ["[MOCK] Adversarial findings not available without API key"] : [],
  };

  return {
    success: false,
    error_type: "unknown_exception",
    error_message: `No API key configured for ${model_info.provider_name}; mock response returned`,
    raw_response: JSON.stringify({ ...mock, ...extra }),
    latency_ms: 0,
    token_input: 0,
    token_output: 0,
    cost_estimate: 0,
    provider: model_info.provider_name,
    model: model_info.model_name,
  };
}
