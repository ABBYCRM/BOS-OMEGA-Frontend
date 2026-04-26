import { mkdir, writeFile, readFile, stat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

const UPLOADS_ROOT = resolve(
  process.env["UPLOADS_DIR"] ?? join(process.cwd(), ".data", "uploads"),
);
const THUMBS_ROOT = join(UPLOADS_ROOT, "thumbs");

export const MAX_UPLOAD_BYTES = Number(
  process.env["MAX_UPLOAD_BYTES"] ?? 50 * 1024 * 1024,
); // 50 MB default

let initPromise: Promise<void> | null = null;

async function init(): Promise<void> {
  if (!existsSync(UPLOADS_ROOT)) await mkdir(UPLOADS_ROOT, { recursive: true });
  if (!existsSync(THUMBS_ROOT)) await mkdir(THUMBS_ROOT, { recursive: true });
}

export function ensureStorageReady(): Promise<void> {
  if (!initPromise) initPromise = init();
  return initPromise;
}

export interface StoredFile {
  sha256: string;
  storage_key: string; // relative path under uploads root
  absolute_path: string;
  size_bytes: number;
}

export function sha256Of(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Store a buffer to disk, deduping by sha256. Returns storage descriptor. */
export async function storeBuffer(
  buf: Buffer,
  ext: string,
): Promise<StoredFile> {
  await ensureStorageReady();
  const sha = sha256Of(buf);
  const safe_ext = sanitizeExt(ext);
  const storage_key = `${sha}${safe_ext}`;
  const absolute_path = join(UPLOADS_ROOT, storage_key);

  if (!existsSync(absolute_path)) {
    await writeFile(absolute_path, buf);
  }
  const s = await stat(absolute_path);
  return {
    sha256: sha,
    storage_key,
    absolute_path,
    size_bytes: s.size,
  };
}

export async function readStoredFile(storage_key: string): Promise<Buffer> {
  const absolute_path = resolveStorageKey(storage_key);
  return readFile(absolute_path);
}

export async function storedFileSize(storage_key: string): Promise<number> {
  const s = await stat(resolveStorageKey(storage_key));
  return s.size;
}

export async function deleteStoredFile(storage_key: string): Promise<void> {
  try {
    await unlink(resolveStorageKey(storage_key));
  } catch {
    /* idempotent */
  }
}

export async function writeThumbnail(
  attachment_id: string,
  buf: Buffer,
): Promise<string> {
  await ensureStorageReady();
  const key = join("thumbs", `${attachment_id}.webp`);
  await writeFile(join(UPLOADS_ROOT, key), buf);
  return key;
}

export async function readThumbnail(attachment_id: string): Promise<Buffer | null> {
  const p = join(UPLOADS_ROOT, "thumbs", `${attachment_id}.webp`);
  if (!existsSync(p)) return null;
  return readFile(p);
}

export async function deleteThumbnail(attachment_id: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]+$/.test(attachment_id)) return;
  try {
    await unlink(join(UPLOADS_ROOT, "thumbs", `${attachment_id}.webp`));
  } catch {
    /* idempotent */
  }
}

export async function deleteFrameDir(attachment_id: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]+$/.test(attachment_id)) return;
  const dir = join(UPLOADS_ROOT, "frames", attachment_id);
  try {
    const { rm } = await import("node:fs/promises");
    await rm(dir, { recursive: true, force: true });
  } catch {
    /* idempotent */
  }
}

export function resolveStorageKey(storage_key: string): string {
  // hard guard against path traversal
  const candidate = resolve(UPLOADS_ROOT, storage_key);
  if (!candidate.startsWith(UPLOADS_ROOT + "/") && candidate !== UPLOADS_ROOT) {
    throw new Error("Invalid storage_key (path traversal blocked)");
  }
  return candidate;
}

function sanitizeExt(ext: string): string {
  if (!ext) return "";
  const lower = ext.toLowerCase();
  const trimmed = lower.startsWith(".") ? lower.slice(1) : lower;
  if (!/^[a-z0-9]{1,8}$/.test(trimmed)) return "";
  return "." + trimmed;
}

export function getUploadsRoot(): string {
  return UPLOADS_ROOT;
}
