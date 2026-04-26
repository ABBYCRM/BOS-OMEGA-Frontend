import type { LLMCallResult, VisionImage } from "../bos/types.js";
import { MASTER_PROMPT_KERNEL } from "./prompts.js";
import { logger } from "../lib/logger.js";

export interface CallOptions {
  memory_context?: string;
  attachment_context?: string;
  images?: VisionImage[];
}

export async function callGemini(
  input: string,
  task_type: string,
  model: string = "gemini-2.5-flash",
  api_key: string,
  options: CallOptions = {},
  base_url: string = "https://generativelanguage.googleapis.com/v1beta",
): Promise<LLMCallResult> {
  const start = Date.now();
  const provider = "gemini";

  try {
    const system_prompt =
      MASTER_PROMPT_KERNEL +
      (options.memory_context ? `\n\n${options.memory_context}` : "") +
      "\n\nIMPORTANT: Return ONLY valid JSON matching the BOS output schema.";

    // The caller-supplied base_url IS the full API prefix (vendor URL ends in
    // `/v1beta`; the Replit proxy URL has no version segment because the SDK
    // is configured with apiVersion=""). We always append the model+method.
    const trimmed = base_url.replace(/\/$/, "");
    const url = `${trimmed}/models/${model}:generateContent`;

    const user_text =
      (options.attachment_context ? `${options.attachment_context}\n\n` : "") +
      `Task type: ${task_type}\n\nInput: ${input}`;

    const parts: Array<Record<string, unknown>> = [{ text: user_text }];
    if (options.images && options.images.length > 0) {
      for (const img of options.images) {
        parts.push({
          inline_data: {
            mime_type: img.mime,
            data: img.base64,
          },
        });
      }
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": api_key,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system_prompt }] },
        contents: [{ role: "user", parts }],
        generationConfig: { responseMimeType: "application/json", maxOutputTokens: 4096, temperature: 0.3 },
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (response.status === 401 || response.status === 403) return errResult(provider, model, start, "auth_failure", "Gemini auth failure");
    if (response.status === 429) return errResult(provider, model, start, "rate_limit", "Gemini rate limit");
    if (response.status === 503) return errResult(provider, model, start, "provider_outage", "Gemini unavailable");
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return errResult(provider, model, start, "malformed_response", `Gemini error: ${response.status} ${body.slice(0, 200)}`);
    }

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
