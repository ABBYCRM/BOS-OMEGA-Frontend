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
  const resolved = await resolveProviderKey(
    model_info.provider_id,
    model_info.provider_name,
  );
  const { key } = resolved;
  // Coerce a possibly-omitted base_url to undefined so the adapter's
  // default-parameter (vendor URL) kicks in. JS only applies default params
  // when the argument is literally `undefined` — passing `null` would crash.
  const proxy_base_url = resolved.base_url ?? undefined;

  // Vision-gate: only forward base64 image data to models that advertise
  // multimodal support, mirroring the policy in executionEngine.buildOptions.
  const supports_vision = (model_info.capability_tags ?? []).includes("multimodal");
  const adapter_options = {
    memory_context: options.memory_context,
    attachment_context: options.attachment_context,
    images: supports_vision ? options.attachment_images : undefined,
    persona_prompt: options.persona_prompt,
  };

  if (provider_name === "openai") {
    if (!key) return mockResult(model_info, prompt, task_type);
    return callOpenAI(prompt, task_type, model_info.model_name, key, adapter_options, proxy_base_url);
  }

  if (provider_name === "anthropic") {
    if (!key) return mockResult(model_info, prompt, task_type);
    return callAnthropic(prompt, task_type, model_info.model_name, key, adapter_options, proxy_base_url);
  }

  if (provider_name === "gemini" || provider_name === "google gemini") {
    if (!key) return mockResult(model_info, prompt, task_type);
    return callGemini(prompt, task_type, model_info.model_name, key, adapter_options, proxy_base_url);
  }

  if (provider_name === "ollama") {
    const base_url = provider?.base_url || process.env["OLLAMA_BASE_URL"] || "http://localhost:11434";
    return callOllama(prompt, task_type, model_info.model_name, base_url, adapter_options);
  }

  const base_url = provider?.base_url || "";
  if (!key || !base_url) return mockResult(model_info, prompt, task_type);
  return callGenericOpenAI(prompt, task_type, model_info.model_name, base_url, key, adapter_options);
}

function mockResult(model_info: ModelScore, prompt: string, task_type: string): LLMCallResult {
  const preview = prompt.slice(0, 300);
  const role_match = prompt.match(/ROLE: (\w+)/);
  const agent_match = prompt.match(/AGENT: (\w+)/);
  const role = role_match?.[1] || agent_match?.[1] || "PROCESSOR";

  const mock: BosOutput = {
    state: "GO",
    task_type,
    answer: `${MOCK_MODE_NOTICE}\n\n[${role} via ${model_info.provider_name}/${model_info.model_name}]\n\nThis agent processed the task in mock mode (no API key configured).\n\nTask preview: "${preview.slice(0, 200)}..."\n\nPaste an API key in Settings to enable live agent responses.`,
    assumptions: ["Mock mode active — no real API key configured", `Role: ${role}`],
    uncertainties: ["This response is simulated"],
    missing_inputs: [],
    failure_modes: ["Real API call not made"],
    recommended_next_action: "Paste a provider API key in the Settings tab to enable live agent responses",
  };

  const extra: Record<string, unknown> = {
    agent_role: role,
    key_points: [`[MOCK] ${role} perspective not available without API key`],
    errors_found: role === "CRITIC" ? ["[MOCK] Critique not available without API key"] : [],
    pass_role: role,
    adversarial_findings: role === "ADVERSARY" ? ["[MOCK] Adversarial findings not available without API key"] : [],
  };

  return {
    success: true,
    raw_response: JSON.stringify({ ...mock, ...extra }),
    latency_ms: Math.floor(Math.random() * 300) + 80,
    token_input: Math.floor(prompt.length / 4),
    token_output: 200,
    cost_estimate: 0,
    provider: model_info.provider_name,
    model: model_info.model_name,
  };
}
