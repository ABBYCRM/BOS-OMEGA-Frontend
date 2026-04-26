import type { LLMCallResult } from "../bos/types.js";
import { MASTER_PROMPT_KERNEL } from "./prompts.js";
import { logger } from "../lib/logger.js";

export async function callGemini(
  input: string,
  task_type: string,
  model: string = "gemini-1.5-flash",
  api_key: string,
  memory_context?: string
): Promise<LLMCallResult> {
  const start = Date.now();
  const provider = "gemini";

  try {
    const system_prompt = MASTER_PROMPT_KERNEL + (memory_context ? `\n\n${memory_context}` : "") +
      "\n\nIMPORTANT: Return ONLY valid JSON matching the BOS output schema.";

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${api_key}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system_prompt }] },
        contents: [{ role: "user", parts: [{ text: `Task type: ${task_type}\n\nInput: ${input}` }] }],
        generationConfig: { responseMimeType: "application/json", maxOutputTokens: 4096, temperature: 0.3 },
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (response.status === 401 || response.status === 403) return errResult(provider, model, start, "auth_failure", "Gemini auth failure");
    if (response.status === 429) return errResult(provider, model, start, "rate_limit", "Gemini rate limit");
    if (response.status === 503) return errResult(provider, model, start, "provider_outage", "Gemini unavailable");
    if (!response.ok) return errResult(provider, model, start, "malformed_response", `Gemini error: ${response.status}`);

    const data = await response.json() as {
      candidates?: Array<{ content: { parts: Array<{ text: string }> } }>;
      usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
    };

    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const token_input = data.usageMetadata?.promptTokenCount;
    const token_output = data.usageMetadata?.candidatesTokenCount;

    return { success: true, raw_response: raw, latency_ms: Date.now() - start, token_input, token_output, cost_estimate: 0, provider, model };
  } catch (err: unknown) {
    const error = err as Error;
    logger.error({ err, provider, model }, "Gemini call failed");
    if (error.name === "TimeoutError") return errResult(provider, model, start, "timeout", "Request timed out");
    return errResult(provider, model, start, "unknown_exception", error.message);
  }
}

function errResult(provider: string, model: string, start: number, error_type: string, msg: string): LLMCallResult {
  return { success: false, latency_ms: Date.now() - start, error_type: error_type as LLMCallResult["error_type"], error_message: msg, provider, model };
}
