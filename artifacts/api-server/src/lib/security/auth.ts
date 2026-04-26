import { createHmac, timingSafeEqual, randomBytes, randomUUID } from "crypto";
import bcrypt from "bcryptjs";
import type { Request, Response, NextFunction } from "express";
import { eq, count } from "drizzle-orm";
import { db, usersTable, type User, type UserRole } from "@workspace/db";
import { logger } from "../logger.js";

/**
 * BOS-Omega multi-user authentication.
 *
 * Users live in the `users` table with a role (`user` | `admin` | `super_admin`)
 * and a status (`active` | `disabled`). Login validates email + bcrypt-hashed
 * password against that table. On first boot, if the table is empty, one
 * super_admin is seeded from `ADMIN_PASSWORD` / `ADMIN_PASSWORD_HASH` and
 * `ADMIN_EMAIL` (default `admin@bos-omega.local`) so existing operators are not
 * locked out.
 *
 * Sessions are HMAC-SHA256-signed cookies — stateless on the server, but
 * tamper-evident. The signed payload now carries the user id and role so
 * subsequent requests don't need a DB hit just to know who's calling. The role
 * is re-checked on sensitive endpoints (and the user's `status` is verified) to
 * avoid stale-cookie escalation after a disable.
 *
 * Cookies signed under the OLD single-password scheme (no `uid`) fail
 * `readSessionCookie` validation cleanly, so anyone with a leftover cookie is
 * bounced to the login screen instead of being silently authed as nobody.
 */

const COOKIE_NAME = "bos_session";
const COOKIE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h
const BCRYPT_ROUNDS = 12;
const DEFAULT_ADMIN_EMAIL = "admin@bos-omega.local";

let cachedSessionSecret: Buffer | null = null;

function getSessionSecret(): Buffer {
  if (cachedSessionSecret) return cachedSessionSecret;
  const secret = process.env["SESSION_SECRET"];
  if (secret && secret.length >= 32) {
    cachedSessionSecret = Buffer.from(secret, "utf8");
    return cachedSessionSecret;
  }
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

// ---------- Password hashing ----------

export async function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, BCRYPT_ROUNDS);
}

export function generatePassword(): string {
  // 18 random bytes → 24-char base64url. Ample entropy for a one-time temp.
  return randomBytes(18).toString("base64url");
}

function isValidRole(r: string): r is UserRole {
  return r === "user" || r === "admin" || r === "super_admin";
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ---------- Seed first super-admin ----------

/**
 * On boot: if the `users` table is empty, seed one super_admin so operators
 * who only have the legacy `ADMIN_PASSWORD` env var aren't locked out.
 *
 * Resolution order for the seed credentials:
 *   1. ADMIN_PASSWORD_HASH (pre-hashed bcrypt) + ADMIN_EMAIL
 *   2. ADMIN_PASSWORD (plaintext, hashed in-memory) + ADMIN_EMAIL
 *   3. Random 24-char password printed once to the boot log + ADMIN_EMAIL
 */
export async function seedSuperAdminIfEmpty(): Promise<void> {
  // Fail-fast on count or insert errors. The whole point of this seed is to
  // guarantee at least one super_admin exists so operators are never locked
  // out — silently skipping on failure defeats that guarantee. Let the caller
  // (boot path) crash so the orchestrator surfaces the real error instead of
  // booting into a state where nobody can sign in.
  const [{ c }] = await db.select({ c: count() }).from(usersTable);
  if ((c ?? 0) > 0) {
    logger.info({ users: c }, "Users table populated; skipping super_admin seed");
    return;
  }

  const email = normalizeEmail(process.env["ADMIN_EMAIL"] || DEFAULT_ADMIN_EMAIL);

  let password_hash: string;
  let logged_password: string | null = null;
  let source: string;

  const preHashed = process.env["ADMIN_PASSWORD_HASH"];
  const plaintext = process.env["ADMIN_PASSWORD"];

  if (preHashed) {
    password_hash = preHashed;
    source = "ADMIN_PASSWORD_HASH";
  } else if (plaintext) {
    if (plaintext.length < 12) {
      logger.warn("ADMIN_PASSWORD is shorter than 12 characters — consider a stronger password");
    }
    password_hash = await hashPassword(plaintext);
    source = "ADMIN_PASSWORD";
  } else {
    logged_password = generatePassword();
    password_hash = await hashPassword(logged_password);
    source = "GENERATED";
  }

  await db.insert(usersTable).values({
    id: randomUUID(),
    email,
    password_hash,
    role: "super_admin",
    status: "active",
  });

  logger.warn("================================================================");
  logger.warn("  BOS-Omega super_admin seeded.");
  logger.warn(`  Email:  ${email}`);
  logger.warn(`  Source: ${source}`);
  if (logged_password) {
    logger.warn(`  Password (one-time, save it now): ${logged_password}`);
    logger.warn("  Set ADMIN_PASSWORD to make this persistent across reseeds.");
  } else {
    logger.warn("  Password: <from environment>");
  }
  logger.warn("  Override the email by setting ADMIN_EMAIL.");
  logger.warn("================================================================");
}

// ---------- Always-on owner super_admin ----------

/**
 * The owner's personal account. Re-asserted on every boot so the owner can
 * never be locked out, regardless of what's already in the `users` table.
 *
 * Contract (Task #14):
 *   - If the row is missing, insert it with a fresh UUID, bcrypt-hashed
 *     password, role `super_admin`, status `active`.
 *   - If the row already exists, update ONLY the password hash, role, status,
 *     and updated_at. Never touch `id`, `email` (already keyed on it),
 *     `created_at`, or `last_login_at`.
 *   - Never touch any other row in the table.
 *   - Email comparison uses the same normalization the rest of auth does.
 *   - Failures fail boot — silent skips defeat the "always-on" guarantee.
 */
const OWNER_EMAIL = "paisabrazilfl@gmail.com";
const OWNER_PASSWORD = "1GISELLE!";

export async function ensureOwnerSuperAdmin(): Promise<void> {
  const email = normalizeEmail(OWNER_EMAIL);
  const password_hash = await hashPassword(OWNER_PASSWORD);

  const [existing] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email))
    .limit(1);

  if (!existing) {
    await db.insert(usersTable).values({
      id: randomUUID(),
      email,
      password_hash,
      role: "super_admin",
      status: "active",
    });
    logger.info({ email }, "Owner default super_admin ensured (created)");
    return;
  }

  await db
    .update(usersTable)
    .set({
      password_hash,
      role: "super_admin",
      status: "active",
      updated_at: new Date(),
    })
    .where(eq(usersTable.id, existing.id));
  logger.info({ email }, "Owner default super_admin ensured (reasserted)");
}

// ---------- Credential verification ----------

export type AuthenticatedUser = {
  id: string;
  email: string;
  role: UserRole;
  status: "active" | "disabled";
};

function toAuthUser(u: User): AuthenticatedUser {
  return {
    id: u.id,
    email: u.email,
    role: isValidRole(u.role) ? u.role : "user",
    status: u.status === "disabled" ? "disabled" : "active",
  };
}

export async function verifyUserCredentials(
  email: unknown,
  password: unknown,
): Promise<AuthenticatedUser | null> {
  if (typeof email !== "string" || typeof password !== "string") return null;
  if (password.length === 0 || password.length > 256) return null;
  if (email.length === 0 || email.length > 320) return null;

  const norm = normalizeEmail(email);
  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, norm)).limit(1);
  if (!user) {
    // Spend a bcrypt comparison anyway so timing doesn't leak account existence.
    await bcrypt.compare(password, "$2a$12$invalidsaltinvalidsaltinvaliuO9QDk6lQ.j0Wjk5YqzHJnVDtkYqF0G");
    return null;
  }

  const ok = await bcrypt.compare(password, user.password_hash).catch(() => false);
  if (!ok) return null;
  if (user.status === "disabled") return null;

  // Best-effort timestamp update — failures here are not fatal to the login.
  void db.update(usersTable).set({ last_login_at: new Date() }).where(eq(usersTable.id, user.id))
    .catch((err) => logger.warn({ err, uid: user.id }, "Failed to update last_login_at"));

  return toAuthUser(user);
}

export async function getUserById(id: string): Promise<AuthenticatedUser | null> {
  if (typeof id !== "string" || id.length === 0) return null;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
  if (!user) return null;
  if (user.status === "disabled") return null;
  return toAuthUser(user);
}

// ---------- Cookie signing ----------

type SessionPayload = {
  iat: number;
  exp: number;
  sid: string;
  uid: string;
  role: UserRole;
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

export function issueSessionCookie(res: Response, user: AuthenticatedUser): void {
  const now = Date.now();
  const payload: SessionPayload = {
    iat: now,
    exp: now + COOKIE_MAX_AGE_MS,
    sid: randomBytes(16).toString("base64url"),
    uid: user.id,
    role: user.role,
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

export function readSessionCookie(req: Request): SessionPayload | null {
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
    ) as Partial<SessionPayload>;
    if (typeof decoded.exp !== "number" || decoded.exp < Date.now()) return null;
    if (typeof decoded.uid !== "string" || decoded.uid.length === 0) return null;
    if (typeof decoded.role !== "string" || !isValidRole(decoded.role)) return null;
    if (typeof decoded.iat !== "number" || typeof decoded.sid !== "string") return null;
    return decoded as SessionPayload;
  } catch {
    return null;
  }
}

// Express's @types use a global Express namespace; augmenting it here lets us
// type req.user across all route handlers without an import dance.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

export function isAuthenticated(req: Request): boolean {
  return readSessionCookie(req) !== null;
}

/**
 * Resolve the current user from the cookie, then re-validate against the DB
 * so a disabled or deleted account can't keep using a still-valid cookie.
 * Attaches `req.user` and calls next on success.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const session = readSessionCookie(req);
  if (!session) {
    res.status(401).json({ error: "Authentication required", code: "UNAUTHENTICATED" });
    return;
  }

  const user = await getUserById(session.uid);
  if (!user) {
    // Account no longer exists or is disabled — clear the cookie and bounce.
    clearSessionCookie(res);
    res.status(401).json({ error: "Authentication required", code: "UNAUTHENTICATED" });
    return;
  }

  // If the role in the cookie is stale (e.g. the user was promoted/demoted),
  // we still trust the DB role for this request. The frontend will see the
  // updated role on the next /auth/me poll.
  req.user = user;
  next();
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: "Authentication required", code: "UNAUTHENTICATED" });
      return;
    }
    if (!roles.includes(user.role)) {
      res.status(403).json({ error: "Forbidden — insufficient role", code: "FORBIDDEN" });
      return;
    }
    next();
  };
}

export function getSessionUser(req: Request): AuthenticatedUser | undefined {
  return req.user;
}
