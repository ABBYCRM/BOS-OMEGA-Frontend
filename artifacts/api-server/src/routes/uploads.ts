import { Router } from "express";
import multer from "multer";
import { db, attachmentsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { ingestUpload } from "../lib/uploads/index.js";
import type { AuthenticatedUser } from "../lib/security/auth.js";

// IDOR guard: callers must either be super_admin, or the row's user_id must
// match the requester's id, or it must be a legacy row with user_id == NULL.
// We treat "unauthorized" as 404 to avoid leaking attachment existence.
function canAccessAttachment(req: { user?: AuthenticatedUser }, row: { user_id: string | null }): boolean {
  if (req.user?.role === "super_admin") return true;
  if (row.user_id === null) return true;
  return row.user_id === (req.user?.id ?? "");
}
import {
  MAX_UPLOAD_BYTES,
  readStoredFile,
  readThumbnail,
  deleteStoredFile,
  deleteThumbnail,
  deleteFrameDir,
} from "../lib/uploads/storage.js";
import { expensiveLimiter } from "../lib/security/rateLimit.js";
import { classifyByName } from "../lib/uploads/mime.js";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 1,
  },
});

/**
 * POST /api/uploads
 *
 * multipart/form-data with field "file". On success returns the attachment
 * row (without raw bytes); on failure returns a JSON error.
 */
router.post(
  "/",
  expensiveLimiter,
  upload.single("file"),
  async (req, res, next) => {
    try {
      const file = req.file;
      if (!file) {
        res.status(400).json({ error: "No file uploaded", code: "INPUT_ERROR" });
        return;
      }
      // multer surfaces filename truncation via originalname; clamp to a sane size
      const original_name = (file.originalname || "file").slice(0, 200);

      const attachment = await ingestUpload({
        buffer: file.buffer,
        original_name,
        mime: file.mimetype || "application/octet-stream",
        user_id: (req.user as AuthenticatedUser | undefined)?.id ?? null,
      });

      res.status(201).json(serialize(attachment));
    } catch (err) {
      next(err);
    }
  },
);

/** Multer error handler — must come AFTER the route to catch its errors */
router.use((err: unknown, _req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({
        error: `File too large. Maximum is ${(MAX_UPLOAD_BYTES / 1024 / 1024).toFixed(0)}MB.`,
        code: "FILE_TOO_LARGE",
      });
      return;
    }
    res.status(400).json({ error: err.message, code: "UPLOAD_ERROR" });
    return;
  }
  next(err);
});

router.get("/:id", async (req, res) => {
  const id = req.params.id;
  if (!id) { res.status(400).json({ error: "Missing id" }); return; }
  const [row] = await db
    .select()
    .from(attachmentsTable)
    .where(eq(attachmentsTable.id, id))
    .limit(1);
  if (!row || !canAccessAttachment(req, row)) {
    res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
    return;
  }
  res.json(serialize(row));
});

router.get("/:id/raw", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!id) { res.status(400).json({ error: "Missing id" }); return; }
    const [row] = await db
      .select()
      .from(attachmentsTable)
      .where(eq(attachmentsTable.id, id))
      .limit(1);
    if (!row || !canAccessAttachment(req, row)) {
      res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
      return;
    }
    const buf = await readStoredFile(row.storage_key);
    // Force download disposition to neutralize active content (HTML/SVG/JS)
    // being served from the same origin as the app. Images and PDFs that the
    // client explicitly wants to render can still be fetched and rendered
    // client-side via blob URLs; we just refuse to render them as the page.
    const safe_name = row.original_name.replace(/[^\w.\-]+/g, "_").slice(0, 200);
    res.setHeader("Content-Type", row.mime || "application/octet-stream");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Length", String(buf.length));
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safe_name}"`,
    );
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.end(buf);
  } catch (err) {
    next(err);
  }
});

router.get("/:id/thumbnail", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!id) { res.status(400).json({ error: "Missing id" }); return; }
    const [row] = await db
      .select({ user_id: attachmentsTable.user_id })
      .from(attachmentsTable)
      .where(eq(attachmentsTable.id, id))
      .limit(1);
    if (!row || !canAccessAttachment(req, row)) {
      res.status(404).json({ error: "No thumbnail" });
      return;
    }
    const buf = await readThumbnail(id);
    if (!buf) { res.status(404).json({ error: "No thumbnail" }); return; }
    res.setHeader("Content-Type", "image/webp");
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.end(buf);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res) => {
  const id = req.params.id;
  if (!id) { res.status(400).json({ error: "Missing id" }); return; }
  const [row] = await db
    .select()
    .from(attachmentsTable)
    .where(eq(attachmentsTable.id, id))
    .limit(1);
  if (!row || !canAccessAttachment(req, row)) {
    res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
    return;
  }
  // Drop the row first so the dedup ref-count check is consistent.
  await db.delete(attachmentsTable).where(eq(attachmentsTable.id, id));
  // The physical key is `<sha>.<ext>` — two rows with the same sha but
  // different extensions occupy different keys, so we ref-count by storage_key,
  // not by sha alone, to avoid both leaking files AND deleting still-live ones.
  const remaining = await db
    .select({ id: attachmentsTable.id })
    .from(attachmentsTable)
    .where(eq(attachmentsTable.storage_key, row.storage_key));
  if (remaining.length === 0) {
    await deleteStoredFile(row.storage_key);
  }
  // Per-attachment artifacts (thumbnail, video frames) are NEVER shared, so
  // they're always safe to remove on attachment delete.
  await deleteThumbnail(row.id);
  if (row.kind === "video") {
    await deleteFrameDir(row.id);
  }
  res.json({ ok: true, deleted: id });
});

function serialize(row: typeof attachmentsTable.$inferSelect) {
  // Never leak the raw extracted text in the listing — the server uses it
  // when building prompts. The client should request a preview separately
  // if it ever needs to display the full content.
  return {
    id: row.id,
    task_id: row.task_id,
    original_name: row.original_name,
    mime: row.mime,
    kind: row.kind,
    size_bytes: row.size_bytes,
    width: row.width,
    height: row.height,
    duration_ms: row.duration_ms,
    extraction_status: row.extraction_status,
    extraction_error: row.extraction_error,
    extraction_chars: row.extracted_text?.length ?? 0,
    has_thumbnail:
      row.kind === "image"
        ? safeMetaHas(row.extraction_meta, "thumbnail")
        : false,
    created_at: row.created_at.toISOString(),
  };

  function safeMetaHas(meta: string | null, k: string): boolean {
    if (!meta) return false;
    try {
      const j = JSON.parse(meta) as Record<string, unknown>;
      return Boolean(j[k]);
    } catch {
      return false;
    }
  }
}

// Re-export a helper for the kind classifier so callers can inspect a name without parsing here.
export { classifyByName };
export default router;
