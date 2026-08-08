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
// 62. 256 % 62 = 8, so a naive `byte % 62` would bias chars at indices
// 0..7 by ~0.3% each. Rejection sampling on the largest power-of-2
// multiple that fits in a byte (248 = 4*62) keeps the distribution flat.
const ALPHABET_MAX = 248;
const PREFIX_LEN = 16;
const SECRET_LEN = 40;

function randomChars(n: number): string {
  // Over-allocate: ~n * 62/61 bytes are enough on average; pad +20% for
  // the rejection-sampling tail so we never loop.
  const buf = randomBytes(Math.ceil((n * 256) / ALPHABET_MAX) + 8);
  let out = "";
  let i = 0;
  while (out.length < n && i < buf.length) {
    const b = buf[i++]!;
    if (b < ALPHABET_MAX) out += ALPHABET[b % ALPHABET.length];
  }
  // Extremely unlikely (p < 1e-30 for the configured lengths) — but
  // if the byte stream was exhausted, top up with a second call.
  while (out.length < n) {
    const b = randomBytes(1)[0]!;
    if (b < ALPHABET_MAX) out += ALPHABET[b % ALPHABET.length];
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
  // Tuning subsystem — the operator's "knobs" surface. Read dumps the
  // current state of every tunable in one call; write applies changes
  // (canon CRUD, provider priority, persona, generation params).
  "tuning:read",
  "tuning:write",
  // Token management — rotate (revoke + mint a new plaintext) is the
  // recovery path for a lost token; reveal is intentionally NOT in this
  // list because we never store the plaintext server-side.
  "tokens:manage",
] as const;

export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

export const ALL_SCOPES: ReadonlyArray<ApiTokenScope> = API_TOKEN_SCOPES;

export function isScope(s: string): s is ApiTokenScope {
  return (API_TOKEN_SCOPES as readonly string[]).includes(s);
}

/** A masked display form of a token. The full plaintext is never
 *  shown after creation; this is the only form available to the UI. */
export function maskToken(prefix: string): string {
  return `bos_${prefix}…`;
}
