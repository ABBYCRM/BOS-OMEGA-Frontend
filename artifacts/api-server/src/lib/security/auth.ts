import { createHmac, timingSafeEqual, randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import type { Request, Response, NextFunction } from "express";
import { logger } from "../logger.js";

/**
 * BOS-Omega admin authentication.
 *
 * Single-admin model. Password is provided via ADMIN_PASSWORD env (hashed on
 * boot) or ADMIN_PASSWORD_HASH (pre-hashed bcrypt). If neither is set, a
 * cryptographically-random password is generated on first boot and printed
 * to the logs once, with a loud warning.
 *
 * Sessions are HMAC-SHA256-signed cookies — server-stateless, but
 * tamper-evident. Each cookie carries an issued-at and expiry. Compromise of
 * SESSION_SECRET allows session forgery, so it must be high-entropy.
 *
 * Cookie attributes are HttpOnly (no JS access), SameSite=Strict (no
 * cross-site CSRF), Secure (when NODE_ENV=production), Path=/.
 */

const COOKIE_NAME = "bos_session";
const COOKIE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h
const BCRYPT_ROUNDS = 12;

let cachedPasswordHash: string | null = null;
let cachedSessionSecret: Buffer | null = null;

function getSessionSecret(): Buffer {
  if (cachedSessionSecret) return cachedSessionSecret;
  const secret = process.env["SESSION_SECRET"];
  if (secret && secret.length >= 32) {
    cachedSessionSecret = Buffer.from(secret, "utf8");
    return cachedSessionSecret;
  }
  // Fallback: generate a high-entropy ephemeral secret. Sessions will not
  // survive a server restart, but the system stays usable until the operator
  // sets SESSION_SECRET. Logged once with a loud warning.
  if (secret && secret.length < 32) {
    logger.warn(
      "SESSION_SECRET is shorter than 32 chars — ignored. Generating an ephemeral one.",
    );
  } else {
    logger.warn(
      "================================================================",
    );
    logger.warn("  SESSION_SECRET is not set.");
    logger.warn("  Generated an ephemeral session signing key.");
    logger.warn("  Sessions will be invalidated on server restart.");
    logger.warn("  Set SESSION_SECRET to a 32+ char random string for persistence.");
    logger.warn(
      "================================================================",
    );
  }
  cachedSessionSecret = randomBytes(48);
  return cachedSessionSecret;
}

export async function initAdminPassword(): Promise<void> {
  const preHashed = process.env["ADMIN_PASSWORD_HASH"];
  if (preHashed) {
    cachedPasswordHash = preHashed;
    logger.info("Admin password loaded from ADMIN_PASSWORD_HASH");
    return;
  }

  const plaintext = process.env["ADMIN_PASSWORD"];
  if (plaintext) {
    if (plaintext.length < 12) {
      logger.warn("ADMIN_PASSWORD is shorter than 12 characters — consider a stronger password");
    }
    cachedPasswordHash = await bcrypt.hash(plaintext, BCRYPT_ROUNDS);
    logger.info("Admin password loaded from ADMIN_PASSWORD (hashed in memory)");
    return;
  }

  // Generate a random password on first boot — must be captured by operator.
  const generated = randomBytes(18).toString("base64url");
  cachedPasswordHash = await bcrypt.hash(generated, BCRYPT_ROUNDS);
  logger.warn(
    "================================================================",
  );
  logger.warn("  No ADMIN_PASSWORD or ADMIN_PASSWORD_HASH set.");
  logger.warn(`  Generated one-time admin password: ${generated}`);
  logger.warn("  Save it now. It will not be printed again.");
  logger.warn("  Set ADMIN_PASSWORD as an environment variable to make it persistent.");
  logger.warn(
    "================================================================",
  );
}

export async function verifyPassword(plaintext: string): Promise<boolean> {
  if (!cachedPasswordHash) return false;
  if (typeof plaintext !== "string" || plaintext.length === 0 || plaintext.length > 256) return false;
  try {
    return await bcrypt.compare(plaintext, cachedPasswordHash);
  } catch {
    return false;
  }
}

// ---------- Cookie signing ----------

type SessionPayload = {
  iat: number; // issued at (ms)
  exp: number; // expiry (ms)
  sid: string; // random session id (rotation handle)
};

function sign(payloadB64: string): string {
  return createHmac("sha256", getSessionSecret()).update(payloadB64).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function issueSessionCookie(res: Response): void {
  const now = Date.now();
  const payload: SessionPayload = {
    iat: now,
    exp: now + COOKIE_MAX_AGE_MS,
    sid: randomBytes(16).toString("base64url"),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = sign(payloadB64);
  const value = `${payloadB64}.${sig}`;

  const isProd = process.env["NODE_ENV"] === "production";
  const parts = [
    `${COOKIE_NAME}=${value}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${Math.floor(COOKIE_MAX_AGE_MS / 1000)}`,
  ];
  if (isProd) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

export function clearSessionCookie(res: Response): void {
  const isProd = process.env["NODE_ENV"] === "production";
  const parts = [
    `${COOKIE_NAME}=`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    "Max-Age=0",
  ];
  if (isProd) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function readSessionCookie(req: Request): SessionPayload | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  const cookies = raw.split(";").map((c) => c.trim());
  const target = cookies.find((c) => c.startsWith(`${COOKIE_NAME}=`));
  if (!target) return null;
  const value = target.slice(COOKIE_NAME.length + 1);
  const dot = value.lastIndexOf(".");
  if (dot < 0) return null;
  const payloadB64 = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expected = sign(payloadB64);
  if (!safeEqual(sig, expected)) return null;
  try {
    const decoded = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8"),
    ) as SessionPayload;
    if (typeof decoded.exp !== "number" || decoded.exp < Date.now()) return null;
    return decoded;
  } catch {
    return null;
  }
}

export function isAuthenticated(req: Request): boolean {
  return readSessionCookie(req) !== null;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (isAuthenticated(req)) {
    next();
    return;
  }
  res.status(401).json({ error: "Authentication required", code: "UNAUTHENTICATED" });
}
