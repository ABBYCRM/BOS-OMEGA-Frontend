import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

/**
 * AES-256-GCM encryption for provider API keys.
 *
 * Key derivation: scrypt(SESSION_SECRET, "bos-omega-provider-keys", 32).
 * Format on disk: "iv:authTag:ciphertext" (all hex).
 *
 * Keys never leave the backend in plaintext — the UI only sees the last 4 chars.
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const SALT = "bos-omega-provider-keys";

let cachedKey: Buffer | null = null;
function getMasterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const secret = process.env["SESSION_SECRET"];
  if (!secret) throw new Error("SESSION_SECRET is required to encrypt provider API keys");
  cachedKey = scryptSync(secret, SALT, 32);
  return cachedKey;
}

export function encryptSecret(plaintext: string): string {
  if (!plaintext) return "";
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getMasterKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptSecret(payload: string | null | undefined): string {
  if (!payload) return "";
  const parts = payload.split(":");
  if (parts.length !== 3) return "";
  const [ivHex, tagHex, dataHex] = parts as [string, string, string];
  try {
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(tagHex, "hex");
    const encrypted = Buffer.from(dataHex, "hex");
    const decipher = createDecipheriv(ALGORITHM, getMasterKey(), iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    return "";
  }
}

export function maskKey(plaintext: string): string {
  if (!plaintext) return "";
  if (plaintext.length <= 4) return "••••";
  return plaintext.slice(-4);
}
