import type { LLMCallResult } from "../bos/types.js";
import { MASTER_PROMPT_KERNEL } from "./prompts.js";
import { logger } from "../lib/logger.js";

export interface CallOptions {
  memory_context?: string;
  attachment_context?: string;
  /** R-1: per-call role overlay (ARCHITECT/CRITIC/etc.) appended between persona and memory. */
  role_overlay?: string;
  persona_prompt?: string;
}

export async function callOllama(
  input: string,
  task_type: string,
  model: string = "llama3",
  base_url: string = "http://localhost:11434",
  options: CallOptions = {},
): Promise<LLMCallResult> {
  const start = Date.now();
  const provider = "ollama";

  try {
    const system_prompt =
      MASTER_PROMPT_KERNEL +
      (options.persona_prompt ? `\n\n${options.persona_prompt}` : "") +
      (options.role_overlay ? `\n\n${options.role_overlay}` : "") +
      (options.memory_context ? `\n\n${options.memory_context}` : "");

    const user_text =
      (options.attachment_context ? `${options.attachment_context}\n\n` : "") +
      `Task type: ${task_type}\n\nInput: ${input}`;

    const response = await fetch(`${base_url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system_prompt },
          { role: "user", content: user_text },
        ],
        stream: false,
        format: "json",
        options: { temperature: 0.3 },
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      return errResult(provider, model, start, "provider_outage", `Ollama error: ${response.status}`);
    }

    const data = await response.json() as {
      message?: { content: string };
      eval_count?: number;
      prompt_eval_count?: number;
    };

    const raw = data.message?.content || "";

    return {
      success: true,
      raw_response: raw,
      latency_ms: Date.now() - start,
      token_input: data.prompt_eval_count,
      token_output: data.eval_count,
      cost_estimate: 0,
      provider,
      model,
    };
  } catch (err: unknown) {
    const error = err as Error;
    logger.error({ err, provider, model }, "Ollama call failed");
    if (error.name === "TimeoutError") return errResult(provider, model, start, "timeout", "Request timed out");
    return errResult(provider, model, start, "provider_outage", `Ollama not reachable: ${error.message}`);
  }
}

function errResult(provider: string, model: string, start: number, error_type: string, msg: string): LLMCallResult {
  return { success: false, latency_ms: Date.now() - start, error_type: error_type as LLMCallResult["error_type"], error_message: msg, provider, model };
}
