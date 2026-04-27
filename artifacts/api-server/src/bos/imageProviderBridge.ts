/**
 * Task #83 — image-generation provider bridge.
 *
 * Audits IMAGE_REQUESTED before any provider call, generates either
 * deterministic mock bytes (default) or live provider output ordered by
 * `llm_providers.priority` filtered to image-capable adapters
 * (OpenAI gpt-image-1, Gemini gemini-2.5-flash-image), persists via the
 * uploads pipeline, and audits IMAGE_GENERATED / IMAGE_GENERATION_FAILED.
 *
 * Anthropic is intentionally not an image-capable adapter. When Anthropic
 * is the highest-priority enabled provider AND no image-capable provider
 * is enabled, the bridge returns a HOLD whose `summary` tells the user to
 * enable OpenAI or Gemini, and audits the same outcome with reason
 * `provider_does_not_support_images` so the UI/audit chain are consistent.
 */
import { createHash, randomUUID } from "node:crypto";
import { db, llmProvidersTable } from "@workspace/db";
import { and, asc, eq, ne } from "drizzle-orm";
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
  /** Failure cause when success === false. */
  failure_reason?:
    | "provider_does_not_support_images"
    | "no_image_provider_configured"
    | "all_providers_failed"
    | "persistence_failed";
}

const PROMPT_HASH_PREVIEW_BYTES = 8;

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function isLiveMode(): boolean {
  return process.env["IMAGE_GENERATION_LIVE"] === "1";
}

interface ImageProviderAdapter {
  /** Lower-cased provider name as stored in `llm_providers.name` (case-insensitive match). */
  match_name: string;
  model: string;
  call: (opts: { prompt: string; api_key: string; base_url: string; size: GenerationSize }) => Promise<ImageGenResult>;
}

/** Image-capable adapters we know how to dispatch to. */
const IMAGE_ADAPTERS: ImageProviderAdapter[] = [
  {
    match_name: "openai",
    model: "gpt-image-1",
    call: ({ prompt, api_key, base_url, size }) =>
      callOpenAIImage(prompt, api_key, base_url, size, "gpt-image-1"),
  },
  {
    match_name: "gemini",
    model: "gemini-2.5-flash-image",
    call: ({ prompt, api_key, base_url, size }) =>
      callGeminiImage(prompt, api_key, base_url, size, "gemini-2.5-flash-image"),
  },
];

const STORAGE_PATH_PREFIX = "/api/uploads";
const storagePathFor = (id: string): string => `${STORAGE_PATH_PREFIX}/${id}/raw`;

interface ResolvedProviderRow {
  id: string;
  name: string;
  priority: number;
  base_url: string | null;
  api_key_env: string | null;
}

/**
 * Read the enabled providers ordered by priority (lowest = highest priority,
 * mirroring modelSelector.ts). Returns the full list so the caller can
 * detect anthropic-only situations and surface a switch-provider hint.
 */
async function loadEnabledProviders(): Promise<ResolvedProviderRow[]> {
  try {
    const rows = await db
      .select({
        id: llmProvidersTable.id,
        name: llmProvidersTable.name,
        priority: llmProvidersTable.priority,
        base_url: llmProvidersTable.base_url,
        api_key_env: llmProvidersTable.api_key_env,
      })
      .from(llmProvidersTable)
      // Match modelRouter.ts semantics: only OPEN_CIRCUIT is hard-excluded.
      // HEALTHY, DEGRADED, and RECOVERY_TEST providers are all eligible —
      // a DEGRADED provider can still serve image requests; the circuit
      // breaker will short the call if it's actually broken. Filtering to
      // HEALTHY-only would let a single transient blip on the highest-
      // priority provider falsely trigger the "no provider configured"
      // HOLD path even when a usable adapter is one row down the list.
      .where(
        and(
          eq(llmProvidersTable.enabled, true),
          ne(llmProvidersTable.status, "OPEN_CIRCUIT"),
        ),
      )
      .orderBy(asc(llmProvidersTable.priority));
    return rows;
  } catch (err) {
    logger.warn({ err }, "imageProviderBridge: provider load failed");
    return [];
  }
}

interface PlannedAttempt {
  adapter: ImageProviderAdapter;
  provider_id: string;
  provider_name: string;
  priority: number;
  base_url: string | null;
}

/**
 * Map enabled providers to the image adapters we can dispatch to, preserving
 * the configured priority order. Providers with no matching image adapter
 * (e.g. Anthropic) are dropped here — the caller inspects the raw provider
 * list separately to surface the switch-provider hint.
 */
function planAttempts(providers: ResolvedProviderRow[]): PlannedAttempt[] {
  const planned: PlannedAttempt[] = [];
  for (const p of providers) {
    const adapter = IMAGE_ADAPTERS.find((a) => a.match_name === p.name.toLowerCase());
    if (!adapter) continue;
    planned.push({
      adapter,
      provider_id: p.id,
      provider_name: adapter.match_name,
      priority: p.priority,
      base_url: p.base_url,
    });
  }
  return planned;
}

/**
 * Run image generation with full audit + persistence. Always returns —
 * never throws. Failures are surfaced as success:false plus a list of
 * per-provider attempts and a typed failure_reason so the caller can
 * compose a HOLD response.
 */
export async function runImageGeneration(
  options: ImageGenerationOptions,
): Promise<ImageGenerationOutcome> {
  const prompt_sha = sha256(options.prompt);
  const live = isLiveMode();

  const enabled = await loadEnabledProviders();
  const planned = planAttempts(enabled);

  // Anthropic-only situation: no image-capable adapter is enabled. Surface a
  // user-actionable HOLD instead of silently mock-fallback even in live mode.
  // In mock mode we still proceed with the mock so dev/CI remains functional.
  const anthropic_only =
    live &&
    planned.length === 0 &&
    enabled.some((p) => p.name.toLowerCase() === "anthropic");

  await auditLog(options.task_id, "IMAGE_REQUESTED", "Image generation requested", {
    prompt: options.prompt,
    prompt_sha256_prefix: prompt_sha.slice(0, PROMPT_HASH_PREVIEW_BYTES * 2),
    prompt_chars: options.prompt.length,
    matched_phrase: options.matched_phrase ?? null,
    size: options.size,
    live_mode: live,
    enabled_providers: enabled.map((p) => `${p.name}:${p.priority}`),
    planned_order: planned.map((p) => `${p.provider_name}:${p.adapter.model}`),
    anthropic_active: enabled.some((p) => p.name.toLowerCase() === "anthropic"),
  });

  if (anthropic_only) {
    const reason =
      "Anthropic does not expose an image-generation API. Enable OpenAI (gpt-image-1) " +
      "or Gemini (gemini-2.5-flash-image) in Settings → Providers and retry.";
    await auditLog(
      options.task_id,
      "IMAGE_GENERATION_FAILED",
      "No image-capable provider enabled (Anthropic active)",
      {
        reason: "provider_does_not_support_images",
        active_providers: enabled.map((p) => p.name.toLowerCase()),
      },
    );
    return {
      success: false,
      attachments: [],
      summary: reason,
      attempts: [],
      mocked: false,
      failure_reason: "provider_does_not_support_images",
    };
  }

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

  if (planned.length === 0) {
    await auditLog(
      options.task_id,
      "IMAGE_GENERATION_FAILED",
      "No image-capable provider configured",
      { reason: "no_image_provider_configured", enabled_providers: enabled.map((p) => p.name.toLowerCase()) },
    );
    return {
      success: false,
      attachments: [],
      summary: "Image generation is not available — enable OpenAI or Gemini in Settings → Providers and retry.",
      attempts: [],
      mocked: false,
      failure_reason: "no_image_provider_configured",
    };
  }

  // Live mode: try planned attempts in priority order. Any success short-circuits.
  const attempts: ImageGenerationOutcome["attempts"] = [];
  for (const plan of planned) {
    const resolved = await resolveProviderKey(plan.provider_id, plan.provider_name);
    if (!resolved.key) {
      attempts.push({
        provider: plan.provider_name,
        model: plan.adapter.model,
        success: false,
        latency_ms: 0,
        error_type: "auth_failure",
        error_message: "no_credentials",
      });
      continue;
    }

    const base_url =
      resolved.base_url ??
      plan.base_url ??
      (plan.provider_name === "openai"
        ? "https://api.openai.com/v1"
        : "https://generativelanguage.googleapis.com/v1beta");

    const result = await plan.adapter.call({
      prompt: options.prompt,
      api_key: resolved.key,
      base_url,
      size: options.size,
    });

    attempts.push({
      provider: plan.provider_name,
      model: plan.adapter.model,
      success: result.success,
      latency_ms: result.latency_ms,
      error_type: result.error_type,
      error_message: result.error_message,
    });

    if (result.success && result.b64) {
      // Validate base64 BEFORE persistence: reject empty/oversized/non-image
      // payloads so a misbehaving provider can never poison uploads.
      const validation = validateImageBytes(result.b64, result.mime ?? "image/png");
      if (validation.ok) {
        return await persistAndAudit({
          bytes: validation.bytes,
          mime: validation.mime,
          provider: plan.provider_name,
          model: plan.adapter.model,
          width: result.width ?? null,
          height: result.height ?? null,
          latency_ms: result.latency_ms,
          mocked: false,
          attempts,
          options,
          prompt_sha,
        });
      }
      // Demote the just-recorded success to a malformed_response and continue.
      const last = attempts[attempts.length - 1];
      if (last) {
        last.success = false;
        last.error_type = "malformed_response";
        last.error_message = validation.reason;
      }
      logger.warn(
        {
          provider: plan.provider_name,
          model: plan.adapter.model,
          reason: validation.reason,
          decoded_bytes: validation.decoded_bytes,
        },
        "image_bridge.validation_failed",
      );
    }
  }

  // All providers failed.
  await auditLog(
    options.task_id,
    "IMAGE_GENERATION_FAILED",
    "All image providers failed",
    {
      reason: "all_providers_failed",
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
    failure_reason: "all_providers_failed",
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
        reason: "persistence_failed",
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
      failure_reason: "persistence_failed",
    };
  }

  const width = attachment.width ?? input.width;
  const height = attachment.height ?? input.height;
  const storage_path = storagePathFor(attachment.id);

  const ref: GeneratedImageRef = {
    id: attachment.id,
    mime: attachment.mime,
    width,
    height,
    provider: input.provider,
    model: input.model,
    mock: input.mocked,
    original_name: attachment.original_name,
    storage_path,
  };

  await auditLog(
    input.options.task_id,
    "IMAGE_GENERATED",
    `Image generated via ${input.provider}:${input.model}${input.mocked ? " (mock)" : ""}`,
    {
      attachment_id: attachment.id,
      storage_path,
      provider: input.provider,
      model: input.model,
      mocked: input.mocked,
      latency_ms: input.latency_ms,
      bytes: attachment.size_bytes,
      sha256: attachment.sha256,
      width,
      height,
      mime: attachment.mime,
      prompt: input.options.prompt,
      prompt_sha256_prefix: input.prompt_sha.slice(0, PROMPT_HASH_PREVIEW_BYTES * 2),
    },
  );

  return {
    success: true,
    attachments: [ref],
    summary: input.mocked
      ? `Generated a placeholder image (mock mode — set IMAGE_GENERATION_LIVE=1 to call OpenAI/Gemini).`
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
