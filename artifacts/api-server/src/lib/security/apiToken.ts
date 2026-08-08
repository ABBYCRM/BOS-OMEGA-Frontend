import { createHash, randomBytes } from "crypto";

/**
 * BOS-Omega API Token format
 *   bos_<prefix>_<secret>
 *   - "bos_"          brand prefix, 4 chars
 *   - <prefix>        16 random chars (alphanumeric), used for fast lookup and the
 *                     masked UI display ("bos_AbCdEf123456…")
 *   - "_"             separator
 *   - <secret>        40 random chars (alphanumeric) — the actual secret
 *
 * Full token: 4 + 16 + 1 + 40 = 61 chars
 * sha256(token) is what we persist; the plaintext is shown to the user exactly
 * once on creation and never stored.
 *
 * This format keeps the prefix small (so log lines and the UI can show it)
 * while leaving the secret long enough to make brute force impractical
 * (40 chars from a 62-char alphabet = log2(62^40) ≈ 238 bits of entropy).
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const PREFIX_LEN = 16;
const SECRET_LEN = 40;

function randomChars(n: number): string {
  const bytes = randomBytes(n);
  let out = "";
  for (let i = 0; i < n; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

export function generateApiToken(): { plaintext: string; prefix: string; hash: string } {
  const prefix = randomChars(PREFIX_LEN);
  const secret = randomChars(SECRET_LEN);
  const plaintext = `bos_${prefix}_${secret}`;
  return { plaintext, prefix, hash: sha256(plaintext) };
}

export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Available scopes for a token. Use `ALL_SCOPES` to grant everything
 * (e.g. a PowerShell bridge token that drives the whole platform).
 */
export const API_TOKEN_SCOPES = [
  "memory:read",
  "memory:write",
  "memory:canon:read",
  "memory:canon:write",
  "memory:scratchpad:read",
  "memory:scratchpad:write",
  "memory:continuity:read",
  "memory:continuity:write",
  "conversations:read",
  "conversations:write",
  "tasks:read",
  "tasks:write",
  "audit:read",
  "continuity:export",
  "continuity:import",
] as const;

export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

export const ALL_SCOPES: ReadonlyArray<ApiTokenScope> = API_TOKEN_SCOPES;

export function isScope(s: string): s is ApiTokenScope {
  return (API_TOKEN_SCOPES as readonly string[]).includes(s);
}

/** Extract the prefix portion of a token, for fast lookup. Returns
 *  null if the input doesn't look like a BOS token. */
export function tokenPrefix(plaintext: string): string | null {
  if (!plaintext.startsWith("bos_")) return null;
  const parts = plaintext.split("_");
  if (parts.length !== 3) return null;
  return parts[1] ?? null;
}

/** A masked display form of a token. The full plaintext is never
 *  shown after creation; this is the only form available to the UI. */
export function maskToken(prefix: string): string {
  return `bos_${prefix}…`;
}
