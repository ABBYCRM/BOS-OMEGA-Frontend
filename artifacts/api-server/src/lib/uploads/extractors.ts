import sharp from "sharp";
import type { AttachmentKind } from "./mime.js";
import { logger } from "../logger.js";

/**
 * Output of a text extraction pass. status:
 *   - "done"     : extracted_text is populated
 *   - "skipped"  : extraction not applicable for this kind
 *   - "failed"   : extractor threw — extraction_error is populated
 */
export interface ExtractionResult {
  status: "done" | "skipped" | "failed";
  text?: string;
  error?: string;
  meta?: Record<string, unknown>;
  width?: number;
  height?: number;
  duration_ms?: number;
}

/** Hard cap on extracted text per file — guards prompt size + DB row size. */
const MAX_EXTRACTED_CHARS = 200_000;

function clip(text: string): string {
  if (text.length <= MAX_EXTRACTED_CHARS) return text;
  return (
    text.slice(0, MAX_EXTRACTED_CHARS) +
    `\n\n[…truncated at ${MAX_EXTRACTED_CHARS.toLocaleString()} characters; original was ${text.length.toLocaleString()} characters.]`
  );
}

export async function extractText(
  buf: Buffer,
  kind: AttachmentKind,
  mime: string,
  filename: string,
): Promise<ExtractionResult> {
  try {
    if (kind === "text" || kind === "code" || kind === "spreadsheet") {
      const text = buf.toString("utf-8");
      // Guard against binary masquerading as text
      if (containsControlNoise(text)) {
        return { status: "failed", error: "File appears to be binary, not text" };
      }
      return { status: "done", text: clip(text) };
    }

    if (kind === "document") {
      if (mime === "application/pdf" || filename.toLowerCase().endsWith(".pdf")) {
        return await extractPdf(buf);
      }
      if (
        mime ===
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
        filename.toLowerCase().endsWith(".docx")
      ) {
        return await extractDocx(buf);
      }
      return { status: "skipped" };
    }

    if (kind === "image") {
      return await extractImageMeta(buf);
    }

    // audio / video / other handled by their own extractors
    return { status: "skipped" };
  } catch (err) {
    logger.error({ err, kind, filename }, "Extraction failed");
    return {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function extractPdf(buf: Buffer): Promise<ExtractionResult> {
  // pdf-parse v2: import the parser entry-point (avoids the v1 demo-file bug)
  const mod = (await import("pdf-parse")) as unknown as {
    default?: (b: Buffer) => Promise<{ text: string; numpages?: number }>;
  } & ((b: Buffer) => Promise<{ text: string; numpages?: number }>);
  const parser = (mod.default ?? mod) as (
    b: Buffer,
  ) => Promise<{ text: string; numpages?: number }>;
  const parsed = await parser(buf);
  return {
    status: "done",
    text: clip(parsed.text || ""),
    meta: { pages: parsed.numpages ?? null },
  };
}

async function extractDocx(buf: Buffer): Promise<ExtractionResult> {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer: buf });
  return {
    status: "done",
    text: clip(result.value || ""),
    meta: { messages: result.messages?.length ?? 0 },
  };
}

async function extractImageMeta(buf: Buffer): Promise<ExtractionResult> {
  try {
    const meta = await sharp(buf, { failOn: "none" }).metadata();
    return {
      status: "skipped",
      width: meta.width,
      height: meta.height,
      meta: { format: meta.format, channels: meta.channels },
    };
  } catch (err) {
    return {
      status: "failed",
      error: err instanceof Error ? err.message : "Image metadata read failed",
    };
  }
}

/** Generate a small webp thumbnail (max 256px) for an image attachment. */
export async function makeThumbnail(buf: Buffer): Promise<Buffer | null> {
  try {
    return await sharp(buf, { failOn: "none" })
      .rotate() // honor EXIF orientation
      .resize(256, 256, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
  } catch (err) {
    logger.warn({ err }, "Thumbnail generation failed");
    return null;
  }
}

/** Resize an image for vision-model input (max ~1568px long edge, ~strip alpha). */
export async function prepareImageForVision(
  buf: Buffer,
): Promise<{ base64: string; mime: string }> {
  const out = await sharp(buf, { failOn: "none" })
    .rotate()
    .resize(1568, 1568, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  return { base64: out.toString("base64"), mime: "image/jpeg" };
}

/** Heuristic: too many NUL/control chars → not real text */
function containsControlNoise(s: string): boolean {
  if (s.length === 0) return false;
  let bad = 0;
  const sample = s.slice(0, 4096);
  for (const ch of sample) {
    const c = ch.charCodeAt(0);
    if (c === 0) return true;
    if (c < 9 || (c > 13 && c < 32)) bad++;
  }
  return bad / sample.length > 0.05;
}
