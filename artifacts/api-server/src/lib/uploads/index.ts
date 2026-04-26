/**
 * Upload pipeline orchestrator.
 *
 * Given an in-memory file buffer + metadata, this module:
 *   1. Stores the raw bytes (sha256-deduped) on disk
 *   2. Runs the appropriate extractor (text, pdf, docx, image meta, audio, video)
 *   3. Generates an image thumbnail for previewable kinds
 *   4. Persists the attachment row in Postgres
 *   5. Returns the saved row to the caller
 *
 * Everything happens synchronously per request — extraction is fast for
 * the file types we support, and queueing infrastructure isn't justified
 * for this workload yet.
 */

import { db, attachmentsTable } from "@workspace/db";
import type { Attachment } from "@workspace/db";
import { randomUUID } from "node:crypto";
import { storeBuffer, writeThumbnail } from "./storage.js";
import { classifyByName, extOf, type AttachmentKind } from "./mime.js";
import { extractText, makeThumbnail } from "./extractors.js";
import { transcribeAudio } from "./transcription.js";
import { processVideo, probeAudioDurationMs } from "./video.js";
import { logger } from "../logger.js";

export interface UploadInput {
  buffer: Buffer;
  original_name: string;
  mime: string;
  user_id?: string | null;
  task_id?: string;
}

export async function ingestUpload(input: UploadInput): Promise<Attachment> {
  const id = randomUUID();
  const kind = classifyByName(input.original_name, input.mime);
  const stored = await storeBuffer(input.buffer, extOf(input.original_name));

  let extraction_status: Attachment["extraction_status"] = "skipped";
  let extracted_text: string | null = null;
  let extraction_error: string | null = null;
  let extraction_meta: string | null = null;
  let width: number | null = null;
  let height: number | null = null;
  let duration_ms: number | null = null;
  let thumbnail_made = false;

  try {
    if (kind === "audio") {
      const t = await transcribeAudio(input.buffer, input.original_name, input.mime);
      extraction_status = t.status === "done" ? "done" : t.status;
      extracted_text = t.text ?? null;
      extraction_error = t.error ?? t.reason ?? null;
      duration_ms = (await probeAudioDurationMs(input.buffer)) ?? null;
    } else if (kind === "video") {
      const v = await processVideo(input.buffer, input.original_name, id);
      extracted_text = v.transcript_text ?? null;
      // Status reflects what we actually extracted: frames OR a real transcript
      // count as "done". A "no_audio" video with no frames is honestly "skipped".
      // A failed transcript with no frames is "failed".
      const got_frames = v.vision_images.length > 0;
      const got_transcript = v.transcript_status === "done" && !!v.transcript_text;
      if (got_frames || got_transcript) {
        extraction_status = "done";
      } else if (v.transcript_status === "skipped" || v.transcript_status === "no_audio") {
        extraction_status = "skipped";
      } else {
        extraction_status = "failed";
      }
      extraction_error = v.transcript_error ?? null;
      width = v.width ?? null;
      height = v.height ?? null;
      duration_ms = v.duration_ms ?? null;
      extraction_meta = JSON.stringify({
        frames_extracted: v.vision_images.length,
        frame_storage_keys: v.frame_storage_keys,
        notes: v.notes,
        transcript_status: v.transcript_status,
      });
    } else {
      const e = await extractText(input.buffer, kind, input.mime, input.original_name);
      extraction_status = e.status;
      extracted_text = e.text ?? null;
      extraction_error = e.error ?? null;
      extraction_meta = e.meta ? JSON.stringify(e.meta) : null;
      width = e.width ?? null;
      height = e.height ?? null;
    }

    if (kind === "image") {
      const thumb = await makeThumbnail(input.buffer);
      if (thumb) {
        await writeThumbnail(id, thumb);
        thumbnail_made = true;
      }
    }
  } catch (err) {
    logger.error({ err, kind, name: input.original_name }, "Extraction phase failed");
    extraction_status = "failed";
    extraction_error = err instanceof Error ? err.message : String(err);
  }

  const row: Attachment = {
    id,
    task_id: input.task_id ?? null,
    user_id: input.user_id ?? null,
    original_name: input.original_name,
    mime: input.mime,
    kind: kind as AttachmentKind,
    size_bytes: stored.size_bytes,
    sha256: stored.sha256,
    storage_key: stored.storage_key,
    extracted_text,
    extraction_status,
    extraction_error,
    extraction_meta,
    width,
    height,
    duration_ms,
    created_at: new Date(),
  };

  await db.insert(attachmentsTable).values(row);

  // Annotate that we made a thumbnail in the meta so the client can opt to use it.
  if (thumbnail_made) {
    const next_meta = JSON.stringify({
      ...(extraction_meta ? safeParse(extraction_meta) : {}),
      thumbnail: true,
    });
    await db
      .update(attachmentsTable)
      .set({ extraction_meta: next_meta })
      .where(eqId(id));
    return { ...row, extraction_meta: next_meta };
  }

  return row;
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}

import { eq } from "drizzle-orm";
function eqId(id: string) {
  return eq(attachmentsTable.id, id);
}
