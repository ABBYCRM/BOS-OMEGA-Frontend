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
  const key = await getOpenAiKey();
  if (!key) {
    return {
      status: "skipped",
      reason:
        "Audio transcription requires an OpenAI API key (configure in Settings or set OPENAI_API_KEY).",
    };
  }

  try {
    const form = new FormData();
    const blob = new Blob([new Uint8Array(buf)], { type: mime || "application/octet-stream" });
    form.append("file", blob, filename);
    form.append("model", "whisper-1");
    form.append("response_format", "text");

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
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

async function getOpenAiKey(): Promise<string> {
  // Prefer the DB-managed OpenAI provider key, fall back to env.
  const rows = await db.select().from(llmProvidersTable);
  const openai = rows.find((r) => (r.name || "").toLowerCase() === "openai");
  if (openai) {
    const { key } = await resolveProviderKey(openai.id, openai.name);
    if (key) return key;
  }
  return process.env["OPENAI_API_KEY"] ?? "";
}
