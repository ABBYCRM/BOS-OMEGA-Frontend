/**
 * Task #83 — provider response validator (architect HIGH finding).
 *
 * Pure helper extracted out of `imageProviderBridge.ts` so unit tests
 * can exercise it without spinning up the database / pipeline. The
 * validator catches:
 *   - empty / whitespace-only base64,
 *   - base64 that decodes to fewer bytes than any real image header,
 *   - decoded payloads larger than the configured ceiling,
 *   - payloads whose magic bytes do not match a known image format
 *     (PNG, JPEG, WebP, GIF) — anything else is treated as untrusted
 *     because the chat UI renders the bytes via <img src=...> and a
 *     non-image payload could confuse downstream tooling,
 *   - mime types outside of `image/*` (a provider claiming
 *     `application/json` would otherwise leak through).
 *
 * Returns a discriminated union so callers can both attribute the
 * failure in audit/attempts AND continue the provider fallback chain.
 */

// 25 MB is well above any provider's per-image cap (OpenAI gpt-image-1
// caps around 1.5 MB for 1024×1024 PNG, ~6 MB for 1536×1536 high-quality)
// while still being orders of magnitude smaller than what would degrade
// the upload store. A 25 MB ceiling lets us reject runaway / streaming
// payloads without risking a false negative on a legitimate hi-res image.
export const MAX_DECODED_BYTES = 25 * 1024 * 1024;
export const MIN_DECODED_BYTES = 16; // smaller than this can't be a valid PNG/JPEG/WEBP/GIF header.
const ALLOWED_MIME_PREFIX = "image/";

export interface ValidationOk {
  ok: true;
  bytes: Buffer;
  mime: string;
  decoded_bytes: number;
}
export interface ValidationFail {
  ok: false;
  reason: string;
  decoded_bytes: number;
}
export type ValidationResult = ValidationOk | ValidationFail;

export function validateImageBytes(b64: string, mime: string): ValidationResult {
  if (typeof b64 !== "string" || b64.trim().length === 0) {
    return { ok: false, reason: "empty_base64", decoded_bytes: 0 };
  }
  // Buffer.from silently drops non-base64 chars, so we normalize
  // whitespace + base64url variants first so legitimate provider
  // responses (some include line wrapping) still pass.
  const normalized = b64.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  let bytes: Buffer;
  try {
    bytes = Buffer.from(normalized, "base64");
  } catch {
    return { ok: false, reason: "base64_decode_threw", decoded_bytes: 0 };
  }
  if (bytes.length < MIN_DECODED_BYTES) {
    return { ok: false, reason: "decoded_bytes_too_small", decoded_bytes: bytes.length };
  }
  if (bytes.length > MAX_DECODED_BYTES) {
    return { ok: false, reason: "decoded_bytes_too_large", decoded_bytes: bytes.length };
  }
  // Magic-byte sniffing. The provider's claimed mime is advisory — we
  // still verify the actual bytes so a JSON error body labeled
  // image/png cannot smuggle through.
  const sniffed = sniffImageMime(bytes);
  if (!sniffed) {
    return { ok: false, reason: "unrecognized_image_format", decoded_bytes: bytes.length };
  }
  const claimed = (mime || "").trim().toLowerCase();
  if (claimed && !claimed.startsWith(ALLOWED_MIME_PREFIX)) {
    return { ok: false, reason: "non_image_mime", decoded_bytes: bytes.length };
  }
  // Trust the sniffed mime over the claimed one. If the claimed mime
  // is `image/jpeg` but the bytes are a PNG, the canonical mime wins
  // — the chat UI uses the persisted mime to set the response
  // Content-Type, and we want it to match the bytes.
  return { ok: true, bytes, mime: sniffed, decoded_bytes: bytes.length };
}

/**
 * Return the canonical image mime type if `bytes` starts with a
 * recognized magic-byte signature, or null otherwise.
 *   PNG : 89 50 4E 47 0D 0A 1A 0A
 *   JPEG: FF D8 FF
 *   GIF : "GIF87a" or "GIF89a"
 *   WEBP: "RIFF" .... "WEBP"
 */
export function sniffImageMime(bytes: Buffer): string | null {
  if (bytes.length < 4) return null;
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}
