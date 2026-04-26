import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, readdir, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { logger } from "../logger.js";
import { transcribeAudio } from "./transcription.js";
import { prepareImageForVision } from "./extractors.js";
import type { VisionImage } from "../../bos/types.js";
import { getUploadsRoot, ensureStorageReady } from "./storage.js";

const FFMPEG = process.env["FFMPEG_PATH"] ?? "ffmpeg";
const FFPROBE = process.env["FFPROBE_PATH"] ?? "ffprobe";

const MAX_FRAMES = Number(process.env["VIDEO_MAX_FRAMES"] ?? 6);
const MAX_VIDEO_DURATION_S = Number(process.env["VIDEO_MAX_DURATION_S"] ?? 600); // 10 min
const FRAME_TIMEOUT_MS = 60_000;

export interface VideoProcessingResult {
  /** N evenly-spaced frames extracted from the video (jpeg base64), ready for vision adapters */
  vision_images: VisionImage[];
  /** Storage keys (relative to uploads root) of persisted frame files, so we can re-load them at task time */
  frame_storage_keys: string[];
  /** Whisper transcript of the audio track, if any and a key is configured */
  transcript_text?: string;
  transcript_status: "done" | "skipped" | "failed" | "no_audio";
  transcript_error?: string;
  duration_ms?: number;
  width?: number;
  height?: number;
  notes: string[];
}

interface ProbeResult {
  duration_s: number;
  has_audio: boolean;
  width?: number;
  height?: number;
}

async function ffprobe(file: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFPROBE, [
      "-v", "error",
      "-show_entries", "stream=codec_type,width,height:format=duration",
      "-of", "json",
      file,
    ]);
    let out = "";
    let err = "";
    proc.stdout.on("data", (c) => { out += c.toString(); });
    proc.stderr.on("data", (c) => { err += c.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`ffprobe exit ${code}: ${err}`));
      }
      try {
        const j = JSON.parse(out) as {
          streams?: Array<{ codec_type: string; width?: number; height?: number }>;
          format?: { duration?: string };
        };
        const video = j.streams?.find((s) => s.codec_type === "video");
        const has_audio = !!j.streams?.find((s) => s.codec_type === "audio");
        resolve({
          duration_s: Number(j.format?.duration ?? 0),
          has_audio,
          width: video?.width,
          height: video?.height,
        });
      } catch (e) {
        reject(e as Error);
      }
    });
  });
}

async function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", ...args]);
    let err = "";
    proc.stderr.on("data", (c) => { err += c.toString(); });
    const t = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("ffmpeg timeout"));
    }, FRAME_TIMEOUT_MS);
    proc.on("error", (e) => { clearTimeout(t); reject(e); });
    proc.on("close", (code) => {
      clearTimeout(t);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${err.slice(0, 500)}`));
    });
  });
}

export async function processVideo(
  buf: Buffer,
  filename: string,
  attachment_id?: string,
): Promise<VideoProcessingResult> {
  await ensureStorageReady();
  const notes: string[] = [];
  const work = await mkdtemp(join(tmpdir(), "vid-"));
  const src = join(work, "src.bin");
  await writeFile(src, buf);

  // Persist frames to a stable location so we can re-load them at task time
  // without re-running ffmpeg.
  const frames_dir = attachment_id
    ? join(getUploadsRoot(), "frames", attachment_id)
    : null;
  if (frames_dir) await mkdir(frames_dir, { recursive: true });

  try {
    const probe = await ffprobe(src);
    const duration_s = Math.max(0, probe.duration_s);

    if (duration_s > MAX_VIDEO_DURATION_S) {
      notes.push(
        `Video duration ${duration_s.toFixed(0)}s exceeds limit ${MAX_VIDEO_DURATION_S}s — only first ${MAX_VIDEO_DURATION_S}s used.`,
      );
    }
    const effective_s = Math.min(duration_s, MAX_VIDEO_DURATION_S) || 1;

    // === Frame extraction: N evenly-spaced frames ===
    const frame_count = Math.min(MAX_FRAMES, Math.max(1, Math.floor(effective_s / 5) + 1));
    const fps_expr = `${frame_count}/${effective_s}`; // exact fps to land ~N frames
    const frames_pattern = join(work, "frame_%03d.jpg");

    try {
      await runFfmpeg([
        "-i", src,
        "-vf", `fps=${fps_expr},scale='min(1568,iw)':-2`,
        "-frames:v", String(frame_count),
        "-t", String(effective_s),
        "-q:v", "3",
        frames_pattern,
      ]);
    } catch (err) {
      notes.push(`Frame extraction failed: ${(err as Error).message}`);
    }

    const frame_files = (await readdir(work))
      .filter((f) => f.startsWith("frame_") && f.endsWith(".jpg"))
      .sort();

    const vision_images: VisionImage[] = [];
    const frame_storage_keys: string[] = [];
    for (let i = 0; i < frame_files.length; i++) {
      const name = frame_files[i]!;
      const buf2 = await readFile(join(work, name));
      const prepared = await prepareImageForVision(buf2);
      vision_images.push({
        ...prepared,
        source: `${filename} (frame ${i + 1}/${frame_files.length})`,
      });
      if (frames_dir) {
        const out_name = `frame_${String(i + 1).padStart(3, "0")}.jpg`;
        const out_path = join(frames_dir, out_name);
        // store the prepared (resized) jpeg for fast re-load
        await writeFile(out_path, Buffer.from(prepared.base64, "base64"));
        frame_storage_keys.push(relative(getUploadsRoot(), out_path));
      }
    }

    // === Audio extraction + transcription ===
    let transcript_text: string | undefined;
    let transcript_status: VideoProcessingResult["transcript_status"] = "no_audio";
    let transcript_error: string | undefined;

    if (probe.has_audio) {
      const audio_path = join(work, "audio.mp3");
      try {
        await runFfmpeg([
          "-i", src,
          "-vn",
          "-acodec", "libmp3lame",
          "-ab", "64k",
          "-ac", "1",
          "-ar", "16000",
          "-t", String(Math.min(effective_s, MAX_VIDEO_DURATION_S)),
          audio_path,
        ]);
        const audio_buf = await readFile(audio_path);
        const t = await transcribeAudio(audio_buf, "audio.mp3", "audio/mpeg");
        transcript_status = t.status;
        transcript_text = t.text;
        transcript_error = t.error || t.reason;
      } catch (err) {
        transcript_status = "failed";
        transcript_error = `Audio strip failed: ${(err as Error).message}`;
      }
    }

    return {
      vision_images,
      frame_storage_keys,
      transcript_text,
      transcript_status,
      transcript_error,
      duration_ms: Math.round(duration_s * 1000),
      width: probe.width,
      height: probe.height,
      notes,
    };
  } catch (err) {
    logger.error({ err, filename }, "Video processing failed");
    return {
      vision_images: [],
      frame_storage_keys: [],
      transcript_status: "failed",
      transcript_error: err instanceof Error ? err.message : "Unknown",
      notes,
    };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/** Probe audio duration via ffprobe. */
export async function probeAudioDurationMs(buf: Buffer): Promise<number | undefined> {
  const work = await mkdtemp(join(tmpdir(), "aud-"));
  const src = join(work, "audio.bin");
  try {
    await writeFile(src, buf);
    const probe = await ffprobe(src);
    return probe.duration_s ? Math.round(probe.duration_s * 1000) : undefined;
  } catch {
    return undefined;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
