/**
 * Load attachment bundles for the BOS pipeline.
 *
 * Given a list of attachment ids, this returns:
 *   - `context_block`  — a text block of all extracted text content, suitable for
 *                        prepending to the user prompt
 *   - `images`         — VisionImage[] for image attachments + extracted video frames,
 *                        ready to hand to vision-capable adapters
 *   - `notes`          — diagnostic notes about anything we couldn't process honestly
 */

import { db, attachmentsTable } from "@workspace/db";
import type { Attachment } from "@workspace/db";
import { inArray } from "drizzle-orm";
import type { VisionImage } from "../../bos/types.js";
import { readStoredFile } from "./storage.js";
import { prepareImageForVision } from "./extractors.js";
import { logger } from "../logger.js";

const MAX_IMAGES_PER_TASK = Number(process.env["MAX_VISION_IMAGES_PER_TASK"] ?? 12);
const MAX_CONTEXT_CHARS = Number(process.env["MAX_ATTACHMENT_CONTEXT_CHARS"] ?? 200_000);

export interface AttachmentBundle {
  attachments: Attachment[];
  context_block: string;
  images: VisionImage[];
  notes: string[];
}

export async function loadAttachmentBundle(
  ids: readonly string[],
): Promise<AttachmentBundle> {
  if (ids.length === 0) {
    return { attachments: [], context_block: "", images: [], notes: [] };
  }

  const rows = await db
    .select()
    .from(attachmentsTable)
    .where(inArray(attachmentsTable.id, [...ids]));

  // preserve the order the user attached them in
  const by_id = new Map(rows.map((r) => [r.id, r]));
  const ordered = ids.map((id) => by_id.get(id)).filter((r): r is Attachment => Boolean(r));

  const text_chunks: string[] = [];
  const images: VisionImage[] = [];
  const notes: string[] = [];

  for (const att of ordered) {
    if (att.kind === "image") {
      if (images.length >= MAX_IMAGES_PER_TASK) {
        notes.push(`Image cap reached (${MAX_IMAGES_PER_TASK}); ${att.original_name} not attached to vision payload.`);
        continue;
      }
      try {
        const buf = await readStoredFile(att.storage_key);
        const prepared = await prepareImageForVision(buf);
        images.push({ ...prepared, source: att.original_name });
      } catch (err) {
        notes.push(`Could not load image ${att.original_name}: ${(err as Error).message}`);
      }
      continue;
    }

    if (att.kind === "video") {
      // 1) frames → vision images
      const meta = parseMeta(att.extraction_meta);
      const frame_keys = Array.isArray(meta.frame_storage_keys)
        ? (meta.frame_storage_keys as string[])
        : [];
      for (let i = 0; i < frame_keys.length; i++) {
        if (images.length >= MAX_IMAGES_PER_TASK) {
          notes.push(`Image cap reached; remaining video frames from ${att.original_name} skipped.`);
          break;
        }
        try {
          const k = frame_keys[i]!;
          const buf = await readStoredFile(k);
          // already pre-sized JPEGs at upload time
          images.push({
            mime: "image/jpeg",
            base64: buf.toString("base64"),
            source: `${att.original_name} (frame ${i + 1}/${frame_keys.length})`,
          });
        } catch (err) {
          logger.warn({ err, frame_key: frame_keys[i] }, "Failed to load video frame");
        }
      }
      // 2) transcript → text context
      if (att.extracted_text) {
        text_chunks.push(formatChunk(att, att.extracted_text, "TRANSCRIPT"));
      } else if (att.extraction_status === "skipped" || att.extraction_status === "failed") {
        notes.push(
          `${att.original_name}: video transcript ${att.extraction_status}` +
            (att.extraction_error ? ` (${att.extraction_error})` : ""),
        );
      }
      continue;
    }

    if (att.kind === "audio") {
      if (att.extracted_text) {
        text_chunks.push(formatChunk(att, att.extracted_text, "TRANSCRIPT"));
      } else if (att.extraction_status === "skipped" || att.extraction_status === "failed") {
        notes.push(
          `${att.original_name}: audio transcript ${att.extraction_status}` +
            (att.extraction_error ? ` (${att.extraction_error})` : ""),
        );
      }
      continue;
    }

    // text/code/spreadsheet/document → just append the extracted text
    if (att.extracted_text) {
      text_chunks.push(formatChunk(att, att.extracted_text, kindLabel(att.kind)));
    } else if (att.extraction_status === "failed") {
      notes.push(
        `${att.original_name}: extraction failed` +
          (att.extraction_error ? ` (${att.extraction_error})` : ""),
      );
    } else if (att.extraction_status === "skipped" && att.kind !== "other") {
      notes.push(`${att.original_name}: not text-extractable; ignored.`);
    }
  }

  let context_block = "";
  if (text_chunks.length > 0 || notes.length > 0 || images.length > 0) {
    const parts: string[] = ["=== ATTACHED FILES ==="];
    if (text_chunks.length > 0) {
      parts.push(text_chunks.join("\n\n"));
    }
    if (images.length > 0) {
      const img_summary = images
        .map((im, i) => `  [${i + 1}] ${im.source ?? "image"} (${im.mime})`)
        .join("\n");
      parts.push(`Images attached for vision analysis:\n${img_summary}`);
    }
    if (notes.length > 0) {
      parts.push(`Notes:\n${notes.map((n) => `  - ${n}`).join("\n")}`);
    }
    parts.push("=== END ATTACHED FILES ===");
    context_block = parts.join("\n\n");
    if (context_block.length > MAX_CONTEXT_CHARS) {
      context_block =
        context_block.slice(0, MAX_CONTEXT_CHARS) +
        `\n\n[…attachment context truncated to ${MAX_CONTEXT_CHARS} characters.]`;
    }
  }

  return { attachments: ordered, context_block, images, notes };
}

function formatChunk(att: Attachment, text: string, label: string): string {
  return `--- FILE: ${att.original_name} (${label}, ${att.size_bytes.toLocaleString()} bytes) ---\n${text.trim()}\n--- END ${att.original_name} ---`;
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "document": return "DOCUMENT TEXT";
    case "spreadsheet": return "SPREADSHEET";
    case "code": return "CODE";
    case "text": return "TEXT";
    default: return "FILE";
  }
}

function parseMeta(meta: string | null): Record<string, unknown> {
  if (!meta) return {};
  try {
    return JSON.parse(meta) as Record<string, unknown>;
  } catch {
    return {};
  }
}
