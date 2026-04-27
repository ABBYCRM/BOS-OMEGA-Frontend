/**
 * Task #83 — OpenAI gpt-image-1 image-generation adapter.
 *
 * Direct fetch against `${base_url}/images/generations`. The same
 * endpoint shape works for both the vendor URL (api.openai.com/v1) and
 * the Replit AI Integrations proxy URL (forwarded by `resolveProviderKey`
 * with `source==="proxy"`); only the Authorization header value differs.
 *
 * gpt-image-1 specifics (per the AI integrations skill):
 *   - `response_format` is NOT supported — response is always base64.
 *   - Supported sizes: 1024x1024 (square), 1536x1024 (landscape),
 *     1024x1536 (portrait), "auto".
 *
 * Failure modes are normalised to the same `error_type` taxonomy used by
 * the text adapters so the audit chain and the retry/fallback logic in
 * `imageProviderBridge.ts` can reason about them uniformly.
 */
import { logger } from "../lib/logger.js";
import type { GenerationSize } from "../bos/imageIntent.js";

export type ImageErrorType =
  | "auth_failure"
  | "rate_limit"
  | "provider_outage"
  | "timeout"
  | "malformed_response"
  | "content_policy"
  | "unknown_exception";

export interface ImageGenResult {
  success: boolean;
  /** base64-encoded bytes (no `data:` prefix) when success === true. */
  b64?: string;
  /** Always "image/png" — gpt-image-1 returns PNG; Gemini Native may return PNG/JPEG. */
  mime?: string;
  width?: number;
  height?: number;
  latency_ms: number;
  provider: string;
  model: string;
  error_type?: ImageErrorType;
  error_message?: string;
}

const REQUEST_TIMEOUT_MS = 90_000; // image generation is slower than text

export async function callOpenAIImage(
  prompt: string,
  api_key: string,
  base_url: string,
  size: GenerationSize = "1024x1024",
  model: string = "gpt-image-1",
): Promise<ImageGenResult> {
  const start = Date.now();
  const provider = "openai";

  try {
    const url = `${base_url.replace(/\/$/, "")}/images/generations`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${api_key}`,
      },
      body: JSON.stringify({
        model,
        prompt,
        size,
        n: 1,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (response.status === 401 || response.status === 403) {
      return errResult(provider, model, start, "auth_failure", `OpenAI image auth failure: ${response.status}`);
    }
    if (response.status === 429) {
      return errResult(provider, model, start, "rate_limit", "OpenAI image rate limit");
    }
    if (response.status === 503) {
      return errResult(provider, model, start, "provider_outage", "OpenAI image service unavailable");
    }
    if (response.status === 400) {
      const body_text = await response.text().catch(() => "");
      // OpenAI returns HTTP 400 for content policy violations (key string
      // varies: "safety_violation", "content_policy_violation"). Surface
      // these as their own class so the bridge can fall back to a
      // friendlier "I cannot generate that image" answer rather than a
      // generic "malformed response".
      if (/safety|content[_ ]?policy|moderation/i.test(body_text)) {
        return errResult(provider, model, start, "content_policy", `OpenAI refused for content policy: ${body_text.slice(0, 200)}`);
      }
      return errResult(provider, model, start, "malformed_response", `OpenAI 400: ${body_text.slice(0, 200)}`);
    }

    if (!response.ok) {
      const body_text = await response.text().catch(() => "");
      return errResult(provider, model, start, "malformed_response", `OpenAI error ${response.status}: ${body_text.slice(0, 200)}`);
    }

    const data = (await response.json()) as {
      data?: Array<{ b64_json?: string; revised_prompt?: string }>;
    };

    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) {
      return errResult(provider, model, start, "malformed_response", "OpenAI response missing b64_json payload");
    }

    const [w, h] = size.split("x").map((n) => Number(n));
    const result: ImageGenResult = {
      success: true,
      b64,
      mime: "image/png",
      latency_ms: Date.now() - start,
      provider,
      model,
    };
    if (Number.isFinite(w)) result.width = w;
    if (Number.isFinite(h)) result.height = h;
    return result;
  } catch (err: unknown) {
    const error = err as Error;
    logger.error({ err, provider, model }, "OpenAI image call failed");
    if (error?.name === "TimeoutError") {
      return errResult(provider, model, start, "timeout", "OpenAI image request timed out");
    }
    return errResult(provider, model, start, "unknown_exception", error?.message ?? String(err));
  }
}

function errResult(
  provider: string,
  model: string,
  start: number,
  error_type: ImageErrorType,
  error_message: string,
): ImageGenResult {
  return {
    success: false,
    latency_ms: Date.now() - start,
    provider,
    model,
    error_type,
    error_message,
  };
}
