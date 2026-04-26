import type { BosOutput, LLMCallResult } from "../bos/types.js";
import { MASTER_PROMPT_KERNEL } from "./prompts.js";
import { logger } from "../lib/logger.js";

export async function callOpenAI(
  input: string,
  task_type: string,
  model: string = "gpt-4o",
  api_key: string,
  memory_context?: string
): Promise<LLMCallResult> {
  const start = Date.now();
  const provider = "openai";

  try {
    const messages = buildMessages(input, task_type, memory_context);

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${api_key}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: 4096,
        temperature: 0.3,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (response.status === 401) {
      return errResult(provider, model, start, "auth_failure", "OpenAI auth failure");
    }
    if (response.status === 429) {
      return errResult(provider, model, start, "rate_limit", "OpenAI rate limit");
    }
    if (response.status === 503) {
      return errResult(provider, model, start, "provider_outage", "OpenAI outage");
    }

    if (!response.ok) {
      return errResult(provider, model, start, "malformed_response", `OpenAI error: ${response.status}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    const raw = data.choices?.[0]?.message?.content || "";
    const token_input = data.usage?.prompt_tokens;
    const token_output = data.usage?.completion_tokens;
    const cost = computeCost(token_input, token_output, model);

    return {
      success: true,
      raw_response: raw,
      latency_ms: Date.now() - start,
      token_input,
      token_output,
      cost_estimate: cost,
      provider,
      model,
    };
  } catch (err: unknown) {
    const error = err as Error;
    logger.error({ err, provider, model }, "OpenAI call failed");
    if (error.name === "TimeoutError") {
      return errResult(provider, model, start, "timeout", "Request timed out");
    }
    return errResult(provider, model, start, "unknown_exception", error.message);
  }
}

function buildMessages(input: string, task_type: string, memory_context?: string) {
  const system = MASTER_PROMPT_KERNEL + (memory_context ? `\n\n${memory_context}` : "");
  return [
    { role: "system", content: system },
    { role: "user", content: `Task type: ${task_type}\n\nInput: ${input}` },
  ];
}

function computeCost(input_tokens?: number, output_tokens?: number, model?: string): number {
  if (!input_tokens || !output_tokens) return 0;
  const rates: Record<string, [number, number]> = {
    "gpt-4o": [0.0025, 0.01],
    "gpt-4o-mini": [0.00015, 0.0006],
    "gpt-4-turbo": [0.01, 0.03],
    "gpt-3.5-turbo": [0.0005, 0.0015],
  };
  const [in_rate, out_rate] = rates[model || ""] || [0.002, 0.002];
  return (input_tokens / 1000) * in_rate + (output_tokens / 1000) * out_rate;
}

function errResult(provider: string, model: string, start: number, error_type: string, msg: string): LLMCallResult {
  return {
    success: false,
    latency_ms: Date.now() - start,
    error_type: error_type as LLMCallResult["error_type"],
    error_message: msg,
    provider,
    model,
  };
}
