/**
 * Task #83 — image-generation provider bridge.
 *
 * Orchestrates one image-generation request end to end:
 *   1. Audit-log IMAGE_REQUESTED with the provider order, mock flag,
 *      prompt sha256, and requested size so the audit chain explains
 *      WHY we are calling out to a generative model.
 *   2. Either generate deterministic mock bytes (the default — gated
 *      by `IMAGE_GENERATION_LIVE=1`) OR fan out to the live providers
 *      in priority order (OpenAI gpt-image-1 → Gemini gemini-2.5-flash-image).
 *   3. Persist the resulting bytes via the existing uploads pipeline so
 *      the chat UI can render them via `/api/uploads/<id>/raw` with the
 *      same access-control checks (owner / super_admin) as user uploads.
 *   4. Audit-log IMAGE_GENERATED on success or IMAGE_GENERATION_FAILED
 *      with per-provider error classes when every attempt fails.
 *
 * Mock mode is the safe default so the integration is testable in CI and
 * local dev without burning credits or requiring keys. Mock bytes are a
 * deterministic 8×8 PNG derived from sha256(prompt) — different prompts
 * produce visibly different mock outputs which makes the round-trip test
 * meaningful even without live calls.
 */
import { createHash, randomUUID } from "node:crypto";
import { db, llmProvidersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { resolveProviderKey } from "../lib/keyResolver.js";
import { ingestUpload } from "../lib/uploads/index.js";
import { auditLog } from "./auditEngine.js";
import { logger } from "../lib/logger.js";
import { callOpenAIImage } from "../providers/openaiImageAdapter.js";
import { callGeminiImage } from "../providers/geminiImageAdapter.js";
import type { ImageGenResult } from "../providers/openaiImageAdapter.js";
import type { GenerationSize } from "./imageIntent.js";
import type { GeneratedImageRef } from "./types.js";
import { generateMockPng, MOCK_PNG_DIMENSIONS } from "./imageMockPng.js";
import { validateImageBytes } from "./imageBytesValidator.js";

export interface ImageGenerationOptions {
  prompt: string;
  size: GenerationSize;
  user_id: string | null;
  task_id: string;
  /** Audit-only: the matched verb+noun phrase that routed this request here. */
  matched_phrase?: string;
}

export interface ImageGenerationOutcome {
  success: boolean;
  attachments: GeneratedImageRef[];
  /** Friendly summary the caller can surface in the chat answer. */
  summary: string;
  /** Per-provider attempts in order, for debugging / logging. */
  attempts: Array<{
    provider: string;
    model: string;
    success: boolean;
    latency_ms: number;
    error_type?: string;
    error_message?: string;
    mocked?: boolean;
  }>;
  /** True when the image came from the deterministic mock fallback. */
  mocked: boolean;
}

const PROMPT_HASH_PREVIEW_BYTES = 8;

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function isLiveMode(): boolean {
  return process.env["IMAGE_GENERATION_LIVE"] === "1";
}

interface ProviderEntry {
  provider_name: "openai" | "gemini";
  model: string;
  call: (opts: { prompt: string; api_key: string; base_url: string; size: GenerationSize }) => Promise<ImageGenResult>;
}

const PROVIDER_ORDER: ProviderEntry[] = [
  {
    provider_name: "openai",
    model: "gpt-image-1",
    call: ({ prompt, api_key, base_url, size }) =>
      callOpenAIImage(prompt, api_key, base_url, size, "gpt-image-1"),
  },
  {
    provider_name: "gemini",
    model: "gemini-2.5-flash-image",
    call: ({ prompt, api_key, base_url, size }) =>
      callGeminiImage(prompt, api_key, base_url, size, "gemini-2.5-flash-image"),
  },
];

async function lookupProviderId(name: string): Promise<string | undefined> {
  try {
    const [row] = await db
      .select({ id: llmProvidersTable.id })
      .from(llmProvidersTable)
      .where(eq(llmProvidersTable.name, name))
      .limit(1);
    return row?.id;
  } catch (err) {
    logger.warn({ err, name }, "imageProviderBridge: provider lookup failed");
    return undefined;
  }
}

/**
 * Run image generation with full audit + persistence. Always returns —
 * never throws. Failures are surfaced as `success:false` plus a list of
 * per-provider error classes so the caller can compose a HOLD response.
 */
export async function runImageGeneration(
  options: ImageGenerationOptions,
): Promise<ImageGenerationOutcome> {
  const prompt_sha = sha256(options.prompt);
  const live = isLiveMode();

  await auditLog(options.task_id, "IMAGE_REQUESTED", "Image generation requested", {
    prompt_sha256_prefix: prompt_sha.slice(0, PROMPT_HASH_PREVIEW_BYTES * 2),
    prompt_chars: options.prompt.length,
    matched_phrase: options.matched_phrase ?? null,
    size: options.size,
    live_mode: live,
    provider_order: PROVIDER_ORDER.map((p) => `${p.provider_name}:${p.model}`),
  });

  const attempts: ImageGenerationOutcome["attempts"] = [];

  if (!live) {
    return await persistAndAudit({
      bytes: generateMockPng(options.prompt),
      mime: "image/png",
      provider: "mock",
      model: "mock-deterministic",
      width: MOCK_PNG_DIMENSIONS.width,
      height: MOCK_PNG_DIMENSIONS.height,
      latency_ms: 0,
      mocked: true,
      attempts: [{ provider: "mock", model: "mock-deterministic", success: true, latency_ms: 0, mocked: true }],
      options,
      prompt_sha,
    });
  }

  // Live mode: try providers in declared priority order. Any
  // success short-circuits; only when ALL fail do we surface the
  // collected errors via IMAGE_GENERATION_FAILED.
  for (const entry of PROVIDER_ORDER) {
    const provider_id = await lookupProviderId(
      entry.provider_name === "openai" ? "OpenAI" : "Gemini",
    );
    const resolved = await resolveProviderKey(provider_id, entry.provider_name);
    if (!resolved.key) {
      attempts.push({
        provider: entry.provider_name,
        model: entry.model,
        success: false,
        latency_ms: 0,
        error_type: "auth_failure",
        error_message: "no_credentials",
      });
      continue;
    }

    const base_url =
      resolved.base_url ??
      (entry.provider_name === "openai"
        ? "https://api.openai.com/v1"
        : "https://generativelanguage.googleapis.com/v1beta");

    const result = await entry.call({
      prompt: options.prompt,
      api_key: resolved.key,
      base_url,
      size: options.size,
    });

    attempts.push({
      provider: entry.provider_name,
      model: entry.model,
      success: result.success,
      latency_ms: result.latency_ms,
      error_type: result.error_type,
      error_message: result.error_message,
    });

    if (result.success && result.b64) {
      // SECURITY/ROBUSTNESS (architect HIGH finding): the upstream
      // base64 cannot be trusted blindly. Reject empty / oversized /
      // non-image payloads BEFORE persistence so a misbehaving
      // provider can never poison the upload store with garbage that
      // the chat UI would then try to render. Validation failures
      // demote the attempt from "success" to a typed failure so
      // fallback to the next provider continues.
      const validation = validateImageBytes(result.b64, result.mime ?? "image/png");
      if (validation.ok) {
        return await persistAndAudit({
          bytes: validation.bytes,
          mime: validation.mime,
          provider: entry.provider_name,
          model: entry.model,
          width: result.width ?? null,
          height: result.height ?? null,
          latency_ms: result.latency_ms,
          mocked: false,
          attempts,
          options,
          prompt_sha,
        });
      }
      // Retro-actively flip the attempt we just pushed to record the
      // validation failure — the provider technically returned 200 but
      // the payload was unusable, which is operationally indistinguishable
      // from a malformed_response and must surface in audit + attempts.
      const last = attempts[attempts.length - 1];
      if (last) {
        last.success = false;
        last.error_type = "malformed_response";
        last.error_message = validation.reason;
      }
      logger.warn(
        {
          provider: entry.provider_name,
          model: entry.model,
          reason: validation.reason,
          decoded_bytes: validation.decoded_bytes,
        },
        "image_bridge.validation_failed",
      );
      // Fall through to the next provider in the order.
    }
  }

  // All providers failed.
  await auditLog(
    options.task_id,
    "IMAGE_GENERATION_FAILED",
    "All image providers failed",
    {
      prompt_sha256_prefix: prompt_sha.slice(0, PROMPT_HASH_PREVIEW_BYTES * 2),
      attempts,
      live_mode: true,
    },
  );

  return {
    success: false,
    attachments: [],
    summary: composeFailureSummary(attempts),
    attempts,
    mocked: false,
  };
}

interface PersistInput {
  bytes: Buffer;
  mime: string;
  provider: string;
  model: string;
  width: number | null;
  height: number | null;
  latency_ms: number;
  mocked: boolean;
  attempts: ImageGenerationOutcome["attempts"];
  options: ImageGenerationOptions;
  prompt_sha: string;
}

async function persistAndAudit(input: PersistInput): Promise<ImageGenerationOutcome> {
  const ext = input.mime === "image/jpeg" ? "jpg" : "png";
  const original_name = `generated-${input.options.task_id.slice(0, 8)}-${randomUUID().slice(0, 8)}.${ext}`;

  let attachment;
  try {
    attachment = await ingestUpload({
      buffer: input.bytes,
      original_name,
      mime: input.mime,
      user_id: input.options.user_id,
      task_id: input.options.task_id,
    });
  } catch (err) {
    logger.error({ err, task_id: input.options.task_id }, "imageProviderBridge: ingestUpload failed");
    await auditLog(
      input.options.task_id,
      "IMAGE_GENERATION_FAILED",
      "Failed to persist generated image",
      {
        prompt_sha256_prefix: input.prompt_sha.slice(0, PROMPT_HASH_PREVIEW_BYTES * 2),
        provider: input.provider,
        model: input.model,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return {
      success: false,
      attachments: [],
      summary: "Image was generated but could not be saved.",
      attempts: input.attempts,
      mocked: input.mocked,
    };
  }

  const ref: GeneratedImageRef = {
    id: attachment.id,
    mime: attachment.mime,
    width: attachment.width ?? input.width,
    height: attachment.height ?? input.height,
    provider: input.provider,
    model: input.model,
    mock: input.mocked,
    original_name: attachment.original_name,
  };

  await auditLog(
    input.options.task_id,
    "IMAGE_GENERATED",
    `Image generated via ${input.provider}:${input.model}${input.mocked ? " (mock)" : ""}`,
    {
      attachment_id: attachment.id,
      provider: input.provider,
      model: input.model,
      mocked: input.mocked,
      latency_ms: input.latency_ms,
      bytes: attachment.size_bytes,
      sha256: attachment.sha256,
      width: ref.width,
      height: ref.height,
      prompt_sha256_prefix: input.prompt_sha.slice(0, PROMPT_HASH_PREVIEW_BYTES * 2),
    },
  );

  return {
    success: true,
    attachments: [ref],
    summary: input.mocked
      ? `Generated a placeholder image (mock mode — set IMAGE_GENERATION_LIVE=1 to call ${PROVIDER_ORDER.map((p) => p.provider_name).join("/")}).`
      : `Generated image via ${input.provider} (${input.model}).`,
    attempts: input.attempts,
    mocked: input.mocked,
  };
}

function composeFailureSummary(attempts: ImageGenerationOutcome["attempts"]): string {
  if (attempts.length === 0) {
    return "Image generation is not available — no providers are configured.";
  }
  const reasons = attempts
    .filter((a) => !a.success)
    .map((a) => `${a.provider}: ${a.error_type ?? "unknown"}`)
    .join("; ");
  return `Could not generate the image. Provider attempts: ${reasons}.`;
}

