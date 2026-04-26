import { resolveProviderKey } from "../keyResolver.js";
import { db, llmProvidersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../logger.js";

/**
 * Transcribe an audio file via OpenAI Whisper.
 *
 *  - If no OpenAI key is available (DB-stored or env), returns
 *    {status:"skipped", reason:"…"} so the caller can store the file
 *    honestly without a fake transcript.
 *  - On API success, returns {status:"done", text}.
 *  - On API failure, returns {status:"failed", error}.
 */
export interface TranscriptionResult {
  status: "done" | "skipped" | "failed";
  text?: string;
  error?: string;
  reason?: string;
}

export async function transcribeAudio(
  buf: Buffer,
  filename: string,
  mime: string,
): Promise<TranscriptionResult> {
  const { key, base_url } = await getOpenAiKey();
  if (!key) {
    return {
      status: "skipped",
      reason:
        "Audio transcription requires an OpenAI API key (configure in Settings, set OPENAI_API_KEY, or provision the Replit OpenAI integration).",
    };
  }

  try {
    const form = new FormData();
    const blob = new Blob([new Uint8Array(buf)], { type: mime || "application/octet-stream" });
    form.append("file", blob, filename);
    form.append("model", "whisper-1");
    form.append("response_format", "text");

    const root = (base_url ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const res = await fetch(`${root}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        status: "failed",
        error: `Whisper API ${res.status}: ${body.slice(0, 300)}`,
      };
    }

    const text = (await res.text()).trim();
    return { status: "done", text };
  } catch (err) {
    logger.error({ err, filename }, "Whisper transcription failed");
    return {
      status: "failed",
      error: err instanceof Error ? err.message : "Unknown transcription error",
    };
  }
}

async function getOpenAiKey(): Promise<{ key: string; base_url?: string }> {
  // Prefer the DB-managed OpenAI provider key, then env, then the Replit
  // OpenAI proxy. resolveProviderKey already encodes that order.
  const rows = await db.select().from(llmProvidersTable);
  const openai = rows.find((r) => (r.name || "").toLowerCase() === "openai");
  if (openai) {
    const { key, base_url } = await resolveProviderKey(openai.id, openai.name);
    if (key) return { key, base_url };
  }
  const envKey = process.env["OPENAI_API_KEY"];
  if (envKey) return { key: envKey };
  const proxyKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
  const proxyBase = process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"];
  if (proxyKey && proxyBase) return { key: proxyKey, base_url: proxyBase };
  return { key: "" };
}
