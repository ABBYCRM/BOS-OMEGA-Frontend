import type { LLMCallResult } from "../bos/types.js";
import { MASTER_PROMPT_KERNEL } from "./prompts.js";
import { logger } from "../lib/logger.js";

export interface CallOptions {
  memory_context?: string;
  attachment_context?: string;
  persona_prompt?: string;
}

export async function callGenericOpenAI(
  input: string,
  task_type: string,
  model: string,
  base_url: string,
  api_key: string,
  options: CallOptions = {},
): Promise<LLMCallResult> {
  const start = Date.now();
  const provider = "generic";

  try {
    const system_prompt =
      MASTER_PROMPT_KERNEL +
      (options.persona_prompt ? `\n\n${options.persona_prompt}` : "") +
      (options.memory_context ? `\n\n${options.memory_context}` : "");

    const user_text =
      (options.attachment_context ? `${options.attachment_context}\n\n` : "") +
      `Task type: ${task_type}\n\nInput: ${input}`;

    const response = await fetch(`${base_url}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${api_key}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system_prompt },
          { role: "user", content: user_text },
        ],
        max_tokens: 4096,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (response.status === 401) return errResult(provider, model, start, "auth_failure", "Auth failure");
    if (response.status === 429) return errResult(provider, model, start, "rate_limit", "Rate limited");
    if (!response.ok) return errResult(provider, model, start, "malformed_response", `HTTP ${response.status}`);

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    const raw = data.choices?.[0]?.message?.content || "";
    return {
      success: true,
      raw_response: raw,
      latency_ms: Date.now() - start,
      token_input: data.usage?.prompt_tokens,
      token_output: data.usage?.completion_tokens,
      cost_estimate: 0,
      provider,
      model,
    };
  } catch (err: unknown) {
    const error = err as Error;
    logger.error({ err, provider, model }, "Generic API call failed");
    if (error.name === "TimeoutError") return errResult(provider, model, start, "timeout", "Request timed out");
    return errResult(provider, model, start, "unknown_exception", error.message);
  }
}

function errResult(provider: string, model: string, start: number, error_type: string, msg: string): LLMCallResult {
  return { success: false, latency_ms: Date.now() - start, error_type: error_type as LLMCallResult["error_type"], error_message: msg, provider, model };
}
