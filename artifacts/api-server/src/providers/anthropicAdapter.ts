import type { LLMCallResult, VisionImage } from "../bos/types.js";
import { MASTER_PROMPT_KERNEL } from "./prompts.js";
import { logger } from "../lib/logger.js";

export interface CallOptions {
  memory_context?: string;
  attachment_context?: string;
  images?: VisionImage[];
}

export async function callAnthropic(
  input: string,
  task_type: string,
  model: string = "claude-3-5-sonnet-20241022",
  api_key: string,
  options: CallOptions = {},
  base_url: string = "https://api.anthropic.com",
): Promise<LLMCallResult> {
  const start = Date.now();
  const provider = "anthropic";

  try {
    const system_prompt =
      MASTER_PROMPT_KERNEL +
      (options.memory_context ? `\n\n${options.memory_context}` : "") +
      "\n\nIMPORTANT: Return ONLY valid JSON matching the BOS output schema. Do not include any other text.";

    const user_text =
      (options.attachment_context ? `${options.attachment_context}\n\n` : "") +
      `Task type: ${task_type}\n\nInput: ${input}`;

    let user_message: { role: string; content: unknown };
    if (options.images && options.images.length > 0) {
      const content: Array<Record<string, unknown>> = [];
      // Anthropic recommends images BEFORE text for best attention.
      for (const img of options.images) {
        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: img.mime,
            data: img.base64,
          },
        });
      }
      content.push({ type: "text", text: user_text });
      user_message = { role: "user", content };
    } else {
      user_message = { role: "user", content: user_text };
    }

    const response = await fetch(`${base_url.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system: system_prompt,
        messages: [user_message],
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (response.status === 401) return errResult(provider, model, start, "auth_failure", "Anthropic auth failure");
    if (response.status === 429) return errResult(provider, model, start, "rate_limit", "Anthropic rate limit");
    if (response.status === 529) return errResult(provider, model, start, "provider_outage", "Anthropic overloaded");
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return errResult(provider, model, start, "malformed_response", `Anthropic error: ${response.status} ${body.slice(0, 200)}`);
    }

    const data = await response.json() as {
      content: Array<{ type: string; text: string }>;
      usage?: { input_tokens: number; output_tokens: number };
    };

    const raw = data.content?.find((c) => c.type === "text")?.text || "";
    const token_input = data.usage?.input_tokens;
    const token_output = data.usage?.output_tokens;
    const cost = computeCost(token_input, token_output, model);

    return { success: true, raw_response: raw, latency_ms: Date.now() - start, token_input, token_output, cost_estimate: cost, provider, model };
  } catch (err: unknown) {
    const error = err as Error;
    logger.error({ err, provider, model }, "Anthropic call failed");
    if (error.name === "TimeoutError") return errResult(provider, model, start, "timeout", "Request timed out");
    return errResult(provider, model, start, "unknown_exception", error.message);
  }
}

function computeCost(input_tokens?: number, output_tokens?: number, model?: string): number {
  if (!input_tokens || !output_tokens) return 0;
  const rates: Record<string, [number, number]> = {
    "claude-3-5-sonnet-20241022": [0.003, 0.015],
    "claude-3-5-haiku-20241022": [0.001, 0.005],
    "claude-3-opus-20240229": [0.015, 0.075],
  };
  const [in_rate, out_rate] = rates[model || ""] || [0.003, 0.015];
  return (input_tokens / 1000) * in_rate + (output_tokens / 1000) * out_rate;
}

function errResult(provider: string, model: string, start: number, error_type: string, msg: string): LLMCallResult {
  return { success: false, latency_ms: Date.now() - start, error_type: error_type as LLMCallResult["error_type"], error_message: msg, provider, model };
}
