/**
 * MIME / extension allowlist + classification for the upload pipeline.
 *
 * "kind" is the high-level bucket the rest of the system uses to decide
 * how to process the file (extract text, send to vision, transcribe, etc.).
 */

export type AttachmentKind =
  | "image"
  | "document"
  | "spreadsheet"
  | "code"
  | "text"
  | "audio"
  | "video"
  | "other";

const TEXT_EXTS = new Set([
  "txt", "md", "markdown", "rst", "log", "rtf",
  "json", "yaml", "yml", "toml", "ini", "env",
  "xml", "html", "htm", "css", "scss", "sass", "less",
]);

const CODE_EXTS = new Set([
  "js", "jsx", "ts", "tsx", "mjs", "cjs",
  "py", "rb", "go", "rs", "java", "kt", "swift",
  "c", "cc", "cpp", "h", "hpp", "cs", "m", "mm",
  "php", "lua", "sh", "bash", "zsh", "fish", "ps1",
  "sql", "r", "scala", "pl", "dart", "vue", "svelte",
  "hs", "ex", "exs", "elm", "clj", "cljs", "fs", "fsx",
  "nim", "zig", "v", "jl",
]);

const SPREADSHEET_EXTS = new Set(["csv", "tsv"]);
const DOC_EXTS = new Set(["pdf", "docx"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "tiff"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus"]);
const VIDEO_EXTS = new Set(["mp4", "mov", "webm", "mkv", "avi", "m4v", "3gp"]);

export function classifyByName(name: string, mime: string): AttachmentKind {
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  if (IMAGE_EXTS.has(ext) || mime.startsWith("image/")) return "image";
  if (AUDIO_EXTS.has(ext) || mime.startsWith("audio/")) return "audio";
  if (VIDEO_EXTS.has(ext) || mime.startsWith("video/")) return "video";
  if (DOC_EXTS.has(ext) || mime === "application/pdf") return "document";
  if (
    mime ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  )
    return "document";
  if (SPREADSHEET_EXTS.has(ext)) return "spreadsheet";
  if (CODE_EXTS.has(ext)) return "code";
  if (TEXT_EXTS.has(ext) || mime.startsWith("text/")) return "text";
  return "other";
}

/** Reject files we do not want to accept at all (executables, archives we don't process, etc.) */
export function isAcceptedKind(kind: AttachmentKind): boolean {
  // We accept everything we classify; "other" still gets stored but is not extracted.
  // Block list could be added here for known-dangerous types.
  return kind !== undefined;
}

export function extOf(name: string): string {
  return (name.split(".").pop() ?? "").toLowerCase();
}
