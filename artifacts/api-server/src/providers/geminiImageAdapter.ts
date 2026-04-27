/**
 * Task #83 — Gemini gemini-2.5-flash-image (nano banana) image-generation adapter.
 *
 * Direct fetch against `${base_url}/models/<model>:generateContent`.
 * Same envelope as the chat path used by `geminiAdapter.ts`, but with
 * `responseModalities: ["IMAGE"]` so the API returns base64 image
 * payload(s) inside `candidates[].content.parts[].inline_data` instead of
 * a `text` part.
 *
 * Default model is `gemini-2.5-flash-image` (the cost-efficient nano
 * banana). The pro variant `gemini-3-pro-image-preview` is opt-in only
 * (caller passes it explicitly) per the AI integrations skill — this
 * matches the "do not eagerly upgrade model" guideline.
 *
 * Failure modes are normalised to the same `ImageErrorType` taxonomy as
 * the OpenAI adapter so the bridge can branch identically.
 */
import { logger } from "../lib/logger.js";
import type { GenerationSize } from "../bos/imageIntent.js";
import type { ImageErrorType, ImageGenResult } from "./openaiImageAdapter.js";

const REQUEST_TIMEOUT_MS = 90_000;

// Gemini's native image generation does not (yet) accept a `size`
// parameter the way OpenAI does — the model picks the resolution.
// We pass the requested size as a soft hint in the prompt so the model
// at least biases toward the user's intent, then return the requested
// dimensions as the carry-through value (the actual decoded bytes will
// be the model's chosen resolution; the chat UI lays out via the
// thumbnail's intrinsic size, so this only affects pre-decode hints).
function buildPromptWithSizeHint(prompt: string, size: GenerationSize): string {
  if (size === "1536x1024") return `${prompt}\n\n(Aspect ratio hint: 16:9 widescreen / landscape.)`;
  if (size === "1024x1536") return `${prompt}\n\n(Aspect ratio hint: 9:16 portrait / vertical.)`;
  return `${prompt}\n\n(Aspect ratio hint: 1:1 square.)`;
}

export async function callGeminiImage(
  prompt: string,
  api_key: string,
  base_url: string,
  size: GenerationSize = "1024x1024",
  model: string = "gemini-2.5-flash-image",
): Promise<ImageGenResult> {
  const start = Date.now();
  const provider = "gemini";

  try {
    const trimmed = base_url.replace(/\/$/, "");
    const url = `${trimmed}/models/${model}:generateContent`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": api_key,
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: buildPromptWithSizeHint(prompt, size) }],
          },
        ],
        generationConfig: {
          responseModalities: ["IMAGE"],
        },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (response.status === 401 || response.status === 403) {
      return errResult(provider, model, start, "auth_failure", `Gemini image auth failure: ${response.status}`);
    }
    if (response.status === 429) {
      return errResult(provider, model, start, "rate_limit", "Gemini image rate limit");
    }
    if (response.status === 503) {
      return errResult(provider, model, start, "provider_outage", "Gemini image service unavailable");
    }
    if (response.status === 400) {
      const body_text = await response.text().catch(() => "");
      if (/safety|harm|blocked|policy/i.test(body_text)) {
        return errResult(provider, model, start, "content_policy", `Gemini refused for content policy: ${body_text.slice(0, 200)}`);
      }
      return errResult(provider, model, start, "malformed_response", `Gemini 400: ${body_text.slice(0, 200)}`);
    }
    if (!response.ok) {
      const body_text = await response.text().catch(() => "");
      return errResult(provider, model, start, "malformed_response", `Gemini error ${response.status}: ${body_text.slice(0, 200)}`);
    }

    const data = (await response.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{
            inline_data?: { mime_type?: string; data?: string };
            inlineData?: { mimeType?: string; data?: string };
            text?: string;
          }>;
        };
        finishReason?: string;
      }>;
      promptFeedback?: { blockReason?: string };
    };

    // Hard-block the prompt-feedback path: when Gemini refuses outright
    // it returns no candidates and a `promptFeedback.blockReason` instead.
    if (data.promptFeedback?.blockReason) {
      return errResult(
        provider,
        model,
        start,
        "content_policy",
        `Gemini refused: ${data.promptFeedback.blockReason}`,
      );
    }

    // Walk every part of every candidate looking for a `inline_data` (or
    // camelCase `inlineData`) image payload. Gemini occasionally returns
    // a leading text part ("Here is the image you asked for...") which
    // we skip silently — only the bytes matter for our use case.
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
      const snake = part.inline_data;
      const camel = part.inlineData;
      const data_b64 = snake?.data ?? camel?.data;
      const mime = snake?.mime_type ?? camel?.mimeType ?? "image/png";
      if (data_b64) {
        const [w, h] = size.split("x").map((n) => Number(n));
        const result: ImageGenResult = {
          success: true,
          b64: data_b64,
          mime,
          latency_ms: Date.now() - start,
          provider,
          model,
        };
        if (Number.isFinite(w)) result.width = w;
        if (Number.isFinite(h)) result.height = h;
        return result;
      }
    }

    return errResult(
      provider,
      model,
      start,
      "malformed_response",
      "Gemini response contained no inline_data image payload",
    );
  } catch (err: unknown) {
    const error = err as Error;
    logger.error({ err, provider, model }, "Gemini image call failed");
    if (error?.name === "TimeoutError") {
      return errResult(provider, model, start, "timeout", "Gemini image request timed out");
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

// =====================================================================
// Task #84 — Gemini gemini-2.5-flash-image image-EDIT adapter.
//
// Same generateContent envelope as `callGeminiImage`, but the user-role
// `parts` array carries TWO entries: an `inline_data` part containing
// the source image (base64, with its real mime_type) plus the text
// instruction. With `responseModalities: ["IMAGE"]` the model returns
// the edited image as a fresh `inline_data` payload on the candidate
// content — same parsing path as the generation adapter.
// =====================================================================

export async function callGeminiImageEdit(
  prompt: string,
  image_bytes: Buffer,
  image_mime: string,
  api_key: string,
  base_url: string,
  size: GenerationSize = "1024x1024",
  model: string = "gemini-2.5-flash-image",
): Promise<ImageGenResult> {
  const start = Date.now();
  const provider = "gemini";

  try {
    const trimmed = base_url.replace(/\/$/, "");
    const url = `${trimmed}/models/${model}:generateContent`;
    const source_b64 = image_bytes.toString("base64");
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": api_key,
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { inline_data: { mime_type: image_mime, data: source_b64 } },
              { text: buildPromptWithSizeHint(prompt, size) },
            ],
          },
        ],
        generationConfig: {
          responseModalities: ["IMAGE"],
        },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (response.status === 401 || response.status === 403) {
      return errResult(provider, model, start, "auth_failure", `Gemini image-edit auth failure: ${response.status}`);
    }
    if (response.status === 429) {
      return errResult(provider, model, start, "rate_limit", "Gemini image-edit rate limit");
    }
    if (response.status === 503) {
      return errResult(provider, model, start, "provider_outage", "Gemini image-edit service unavailable");
    }
    if (response.status === 400) {
      const body_text = await response.text().catch(() => "");
      if (/safety|harm|blocked|policy/i.test(body_text)) {
        return errResult(provider, model, start, "content_policy", `Gemini refused for content policy: ${body_text.slice(0, 200)}`);
      }
      return errResult(provider, model, start, "malformed_response", `Gemini 400: ${body_text.slice(0, 200)}`);
    }
    if (!response.ok) {
      const body_text = await response.text().catch(() => "");
      return errResult(provider, model, start, "malformed_response", `Gemini error ${response.status}: ${body_text.slice(0, 200)}`);
    }

    const data = (await response.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{
            inline_data?: { mime_type?: string; data?: string };
            inlineData?: { mimeType?: string; data?: string };
            text?: string;
          }>;
        };
      }>;
      promptFeedback?: { blockReason?: string };
    };

    if (data.promptFeedback?.blockReason) {
      return errResult(
        provider,
        model,
        start,
        "content_policy",
        `Gemini refused: ${data.promptFeedback.blockReason}`,
      );
    }

    const parts = data.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
      const snake = part.inline_data;
      const camel = part.inlineData;
      const data_b64 = snake?.data ?? camel?.data;
      const mime = snake?.mime_type ?? camel?.mimeType ?? "image/png";
      if (data_b64) {
        const [w, h] = size.split("x").map((n) => Number(n));
        const result: ImageGenResult = {
          success: true,
          b64: data_b64,
          mime,
          latency_ms: Date.now() - start,
          provider,
          model,
        };
        if (Number.isFinite(w)) result.width = w;
        if (Number.isFinite(h)) result.height = h;
        return result;
      }
    }
    return errResult(
      provider,
      model,
      start,
      "malformed_response",
      "Gemini image-edit response contained no inline_data payload",
    );
  } catch (err: unknown) {
    const error = err as Error;
    logger.error({ err, provider, model }, "Gemini image-edit call failed");
    if (error?.name === "TimeoutError") {
      return errResult(provider, model, start, "timeout", "Gemini image-edit request timed out");
    }
    return errResult(provider, model, start, "unknown_exception", error?.message ?? String(err));
  }
}
