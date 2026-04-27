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
import { db, llmProvidersTable, attachmentsTable } from "@workspace/db";
import { and, asc, eq, ne } from "drizzle-orm";
import { resolveProviderKey } from "../lib/keyResolver.js";
import { ingestUpload } from "../lib/uploads/index.js";
import { readStoredFile } from "../lib/uploads/storage.js";
import { auditLog } from "./auditEngine.js";
import { logger } from "../lib/logger.js";
import { callOpenAIImage, callOpenAIImageEdit } from "../providers/openaiImageAdapter.js";
import { callGeminiImage, callGeminiImageEdit } from "../providers/geminiImageAdapter.js";
import type { ImageGenResult } from "../providers/openaiImageAdapter.js";
import type { GenerationSize } from "./imageIntent.js";
import type { GeneratedImageRef } from "./types.js";
import { generateMockPng, MOCK_PNG_DIMENSIONS } from "./imageMockPng.js";
import { validateImageBytes } from "./imageBytesValidator.js";
import { costCentsFor, enforceImageQuota } from "./imageQuotas.js";

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
    | "persistence_failed"
    | "quota_exceeded";
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
  /** Task #84: image-EDIT entrypoint. Same provider list, different endpoint. */
  callEdit: (opts: {
    prompt: string;
    image_bytes: Buffer;
    image_mime: string;
    api_key: string;
    base_url: string;
    size: GenerationSize;
  }) => Promise<ImageGenResult>;
}

/** Image-capable adapters we know how to dispatch to. */
const IMAGE_ADAPTERS: ImageProviderAdapter[] = [
  {
    match_name: "openai",
    model: "gpt-image-1",
    call: ({ prompt, api_key, base_url, size }) =>
      callOpenAIImage(prompt, api_key, base_url, size, "gpt-image-1"),
    callEdit: ({ prompt, image_bytes, image_mime, api_key, base_url, size }) =>
      callOpenAIImageEdit(prompt, image_bytes, image_mime, api_key, base_url, size, "gpt-image-1"),
  },
  {
    match_name: "gemini",
    model: "gemini-2.5-flash-image",
    call: ({ prompt, api_key, base_url, size }) =>
      callGeminiImage(prompt, api_key, base_url, size, "gemini-2.5-flash-image"),
    callEdit: ({ prompt, image_bytes, image_mime, api_key, base_url, size }) =>
      callGeminiImageEdit(prompt, image_bytes, image_mime, api_key, base_url, size, "gemini-2.5-flash-image"),
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

/**
 * Normalize the provider base_url for the image adapters' fetch URL
 * shape (`${base_url}/models/...` for Gemini, `${base_url}/images/generations`
 * for OpenAI). The seeded `llm_providers` row for Gemini uses the bare
 * vendor host `https://generativelanguage.googleapis.com` (no `/v1beta`),
 * which would build `https://generativelanguage.googleapis.com/models/...`
 * — a 404. Pre-pending `/v1beta` here keeps the seed row valid for both
 * the chat router (which already normalizes) and the image bridge.
 *
 * For OpenAI the only nudge is "ensure /v1 suffix" — the same hosts work
 * for both chat and images.
 *
 * IMPORTANT: this normalization runs ONLY for vendor URLs. The Replit AI
 * Integrations proxy returns `key + base_url` from `resolveProviderKey`
 * with `source === "proxy"` and the proxy's URL is already correct as-is
 * (it expects `${base_url}/models/...` with no version segment to inject).
 * The caller passes `key_source` so we can leave proxy URLs untouched.
 */
function normalizeBaseUrl(
  provider_name: string,
  raw: string | null,
  key_source: string,
): string {
  const name = provider_name.toLowerCase();
  if (!raw) {
    return name === "openai"
      ? "https://api.openai.com/v1"
      : "https://generativelanguage.googleapis.com/v1beta";
  }
  const trimmed = raw.replace(/\/+$/, "");
  // Proxy base URLs come from the AI Integrations resolver and must not be
  // version-rewritten — the proxy host owns its path layout.
  if (key_source === "proxy") return trimmed;
  if (name === "gemini") {
    if (/\/v\d+(beta)?$/.test(trimmed)) return trimmed;
    return `${trimmed}/v1beta`;
  }
  if (name === "openai") {
    if (/\/v\d+$/.test(trimmed)) return trimmed;
    return `${trimmed}/v1`;
  }
  return trimmed;
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

  // Anthropic-only situation: no image-capable adapter is enabled. Surface
  // the user-actionable switch-provider HOLD in BOTH live and mock mode so
  // mock-mode dev/CI mirrors the prod surface (otherwise an Anthropic-only
  // install silently returns a mock image and the user never learns they
  // need to enable OpenAI/Gemini before going live).
  const anthropic_only =
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

  // Task #85 — pre-flight spend cap. Estimate the upcoming charge using
  // the FIRST planned provider (priority order). In live mode that's the
  // adapter we'd actually call; in mock mode the cost is zero (mock
  // generation is intentionally free). If the user is over either cap,
  // emit IMAGE_QUOTA_BLOCKED and return a HOLD outcome BEFORE any
  // provider call is made.
  const estimated_cost_cents = !live
    ? 0
    : planned[0]
      ? costCentsFor(planned[0].provider_name, planned[0].adapter.model)
      : 0;
  const quota = await enforceImageQuota({
    user_id: options.user_id,
    task_id: options.task_id,
    estimated_cost_usd_cents: estimated_cost_cents,
    operation: "generation",
  });
  if (!quota.allowed) {
    return {
      success: false,
      attachments: [],
      summary: quota.summary,
      attempts: [],
      mocked: false,
      failure_reason: "quota_exceeded",
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

    const base_url = normalizeBaseUrl(
      plan.provider_name,
      resolved.base_url ?? plan.base_url ?? null,
      resolved.source,
    );

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

  // Task #85 — record per-image cost so getTodayUsage() can sum directly
  // from the audit chain. Mock provider intentionally costs $0.
  const cost_usd_cents = input.mocked ? 0 : costCentsFor(input.provider, input.model);
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
      cost_usd_cents,
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

// =====================================================================
// Task #84 — image EDIT bridge.
//
// Mirrors `runImageGeneration` end-to-end (audit → provider iteration →
// validate → ingestUpload → audit), except:
//   1. The source bytes are loaded from the parent attachment up-front.
//   2. The IMAGE_EDIT_REQUESTED / COMPLETED / FAILED audit family is
//      used so an operator can grep the audit chain for "edit" without
//      collisions with vanilla generation.
//   3. The persisted GeneratedImageRef carries `parent_attachment_id`
//      (and parent_storage_path / parent_mime) so the chat UI can
//      render the original→edited pair inline.
//   4. Mock mode reuses the same deterministic mock PNG generator with
//      a hashed prompt so the dev/CI surface is stable.
// =====================================================================

export interface ImageEditOptions {
  prompt: string;
  size: GenerationSize;
  user_id: string | null;
  task_id: string;
  /** Attachment id of the source image to operate on. */
  source_attachment_id: string;
  /** Audit-only: the matched edit phrase that routed this request here. */
  matched_phrase?: string;
}

export interface ImageEditOutcome {
  success: boolean;
  attachments: GeneratedImageRef[];
  summary: string;
  attempts: ImageGenerationOutcome["attempts"];
  mocked: boolean;
  failure_reason?:
    | "provider_does_not_support_images"
    | "no_image_provider_configured"
    | "all_providers_failed"
    | "persistence_failed"
    | "source_attachment_missing"
    | "source_bytes_unreadable"
    | "quota_exceeded";
}

interface SourceAttachment {
  id: string;
  storage_key: string;
  mime: string;
  size_bytes: number;
  bytes: Buffer;
}

async function loadSourceAttachment(
  attachment_id: string,
): Promise<{ ok: true; src: SourceAttachment } | { ok: false; reason: ImageEditOutcome["failure_reason"]; detail: string }> {
  let row: { id: string; storage_key: string; mime: string; size_bytes: number } | undefined;
  try {
    const rows = await db
      .select({
        id: attachmentsTable.id,
        storage_key: attachmentsTable.storage_key,
        mime: attachmentsTable.mime,
        size_bytes: attachmentsTable.size_bytes,
      })
      .from(attachmentsTable)
      .where(eq(attachmentsTable.id, attachment_id))
      .limit(1);
    row = rows[0];
  } catch (err) {
    logger.warn({ err, attachment_id }, "imageProviderBridge.loadSourceAttachment: lookup failed");
    return { ok: false, reason: "source_attachment_missing", detail: err instanceof Error ? err.message : String(err) };
  }
  if (!row) {
    return { ok: false, reason: "source_attachment_missing", detail: `attachment ${attachment_id} not found` };
  }
  try {
    const bytes = await readStoredFile(row.storage_key);
    return { ok: true, src: { ...row, bytes } };
  } catch (err) {
    logger.warn({ err, attachment_id, storage_key: row.storage_key }, "imageProviderBridge.loadSourceAttachment: read failed");
    return { ok: false, reason: "source_bytes_unreadable", detail: err instanceof Error ? err.message : String(err) };
  }
}

export async function runImageEdit(options: ImageEditOptions): Promise<ImageEditOutcome> {
  const prompt_sha = sha256(options.prompt);
  const live = isLiveMode();

  // 1. Resolve the source attachment up-front. If we can't read the
  //    bytes there's no point hitting any provider — fail fast with a
  //    typed reason and an audit row that names the parent id.
  const src_load = await loadSourceAttachment(options.source_attachment_id);
  if (!src_load.ok) {
    await auditLog(
      options.task_id,
      "IMAGE_EDIT_FAILED",
      "Image edit could not load source attachment",
      {
        reason: src_load.reason,
        detail: src_load.detail,
        parent_attachment_id: options.source_attachment_id,
        prompt_sha256_prefix: prompt_sha.slice(0, PROMPT_HASH_PREVIEW_BYTES * 2),
      },
    );
    return {
      success: false,
      attachments: [],
      summary: "Could not load the source image to edit. The original may have been deleted.",
      attempts: [],
      mocked: false,
      failure_reason: src_load.reason,
    };
  }
  const src = src_load.src;

  const enabled = await loadEnabledProviders();
  const planned = planAttempts(enabled);

  const anthropic_only =
    planned.length === 0 &&
    enabled.some((p) => p.name.toLowerCase() === "anthropic");

  await auditLog(options.task_id, "IMAGE_EDIT_REQUESTED", "Image edit requested", {
    prompt: options.prompt,
    prompt_sha256_prefix: prompt_sha.slice(0, PROMPT_HASH_PREVIEW_BYTES * 2),
    prompt_chars: options.prompt.length,
    matched_phrase: options.matched_phrase ?? null,
    parent_attachment_id: options.source_attachment_id,
    parent_storage_key: src.storage_key,
    parent_mime: src.mime,
    parent_bytes: src.size_bytes,
    size: options.size,
    live_mode: live,
    enabled_providers: enabled.map((p) => `${p.name}:${p.priority}`),
    planned_order: planned.map((p) => `${p.provider_name}:${p.adapter.model}`),
    anthropic_active: enabled.some((p) => p.name.toLowerCase() === "anthropic"),
  });

  if (anthropic_only) {
    const reason =
      "Anthropic does not expose an image-edit API. Enable OpenAI (gpt-image-1) " +
      "or Gemini (gemini-2.5-flash-image) in Settings → Providers and retry.";
    await auditLog(options.task_id, "IMAGE_EDIT_FAILED", "No image-capable provider enabled (Anthropic active)", {
      reason: "provider_does_not_support_images",
      parent_attachment_id: options.source_attachment_id,
      active_providers: enabled.map((p) => p.name.toLowerCase()),
    });
    return {
      success: false,
      attachments: [],
      summary: reason,
      attempts: [],
      mocked: false,
      failure_reason: "provider_does_not_support_images",
    };
  }

  // Task #85 — pre-flight spend cap also applies to edits. An edit is one
  // billable image (same per-call charge as a fresh generation), so it
  // must consume from the same daily count + USD budget. Mock mode is
  // free so estimated cost is 0.
  const estimated_cost_cents_edit = !live
    ? 0
    : planned[0]
      ? costCentsFor(planned[0].provider_name, planned[0].adapter.model)
      : 0;
  const quota_edit = await enforceImageQuota({
    user_id: options.user_id,
    task_id: options.task_id,
    estimated_cost_usd_cents: estimated_cost_cents_edit,
    operation: "edit",
  });
  if (!quota_edit.allowed) {
    return {
      success: false,
      attachments: [],
      summary: quota_edit.summary,
      attempts: [],
      mocked: false,
      failure_reason: "quota_exceeded",
    };
  }

  if (!live) {
    return await persistEditAndAudit({
      bytes: generateMockPng(`${options.source_attachment_id}::${options.prompt}`),
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
      src,
    });
  }

  if (planned.length === 0) {
    await auditLog(options.task_id, "IMAGE_EDIT_FAILED", "No image-capable provider configured", {
      reason: "no_image_provider_configured",
      parent_attachment_id: options.source_attachment_id,
      enabled_providers: enabled.map((p) => p.name.toLowerCase()),
    });
    return {
      success: false,
      attachments: [],
      summary: "Image editing is not available — enable OpenAI or Gemini in Settings → Providers and retry.",
      attempts: [],
      mocked: false,
      failure_reason: "no_image_provider_configured",
    };
  }

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
    const base_url = normalizeBaseUrl(
      plan.provider_name,
      resolved.base_url ?? plan.base_url ?? null,
      resolved.source,
    );
    const result = await plan.adapter.callEdit({
      prompt: options.prompt,
      image_bytes: src.bytes,
      image_mime: src.mime,
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
      const validation = validateImageBytes(result.b64, result.mime ?? "image/png");
      if (validation.ok) {
        return await persistEditAndAudit({
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
          src,
        });
      }
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
        "image_edit_bridge.validation_failed",
      );
    }
  }

  await auditLog(options.task_id, "IMAGE_EDIT_FAILED", "All image-edit providers failed", {
    reason: "all_providers_failed",
    parent_attachment_id: options.source_attachment_id,
    prompt_sha256_prefix: prompt_sha.slice(0, PROMPT_HASH_PREVIEW_BYTES * 2),
    attempts,
    live_mode: true,
  });
  return {
    success: false,
    attachments: [],
    summary: composeEditFailureSummary(attempts),
    attempts,
    mocked: false,
    failure_reason: "all_providers_failed",
  };
}

interface PersistEditInput {
  bytes: Buffer;
  mime: string;
  provider: string;
  model: string;
  width: number | null;
  height: number | null;
  latency_ms: number;
  mocked: boolean;
  attempts: ImageGenerationOutcome["attempts"];
  options: ImageEditOptions;
  prompt_sha: string;
  src: SourceAttachment;
}

async function persistEditAndAudit(input: PersistEditInput): Promise<ImageEditOutcome> {
  const ext = input.mime === "image/jpeg" ? "jpg" : "png";
  // Filename pattern marks the edit lineage so an operator browsing the
  // attachments table can spot edited rows at a glance: `edited-…`.
  const original_name = `edited-${input.options.task_id.slice(0, 8)}-${randomUUID().slice(0, 8)}.${ext}`;

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
    logger.error({ err, task_id: input.options.task_id }, "imageProviderBridge.runImageEdit: ingestUpload failed");
    await auditLog(input.options.task_id, "IMAGE_EDIT_FAILED", "Failed to persist edited image", {
      reason: "persistence_failed",
      parent_attachment_id: input.options.source_attachment_id,
      prompt_sha256_prefix: input.prompt_sha.slice(0, PROMPT_HASH_PREVIEW_BYTES * 2),
      provider: input.provider,
      model: input.model,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      success: false,
      attachments: [],
      summary: "Image was edited but could not be saved.",
      attempts: input.attempts,
      mocked: input.mocked,
      failure_reason: "persistence_failed",
    };
  }

  const width = attachment.width ?? input.width;
  const height = attachment.height ?? input.height;
  const storage_path = storagePathFor(attachment.id);
  const parent_storage_path = storagePathFor(input.src.id);

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
    parent_attachment_id: input.src.id,
    parent_storage_path,
    parent_mime: input.src.mime,
  };

  // Task #85 — record per-edit cost. An edit consumes the same daily
  // budget as a fresh generation (same provider call type).
  const cost_usd_cents_edit = input.mocked ? 0 : costCentsFor(input.provider, input.model);
  await auditLog(
    input.options.task_id,
    "IMAGE_EDIT_COMPLETED",
    `Image edited via ${input.provider}:${input.model}${input.mocked ? " (mock)" : ""}`,
    {
      attachment_id: attachment.id,
      parent_attachment_id: input.src.id,
      storage_path,
      parent_storage_path,
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
      cost_usd_cents: cost_usd_cents_edit,
    },
  );

  return {
    success: true,
    attachments: [ref],
    summary: input.mocked
      ? `Edited the image (mock mode — set IMAGE_GENERATION_LIVE=1 to call OpenAI/Gemini).`
      : `Edited image via ${input.provider} (${input.model}).`,
    attempts: input.attempts,
    mocked: input.mocked,
  };
}

function composeEditFailureSummary(attempts: ImageGenerationOutcome["attempts"]): string {
  if (attempts.length === 0) {
    return "Image editing is not available — no providers are configured.";
  }
  const reasons = attempts
    .filter((a) => !a.success)
    .map((a) => `${a.provider}: ${a.error_type ?? "unknown"}`)
    .join("; ");
  return `Could not edit the image. Provider attempts: ${reasons}.`;
}
