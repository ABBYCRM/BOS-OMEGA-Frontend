import type { Request, Response, NextFunction } from "express";
import { eq, and, isNull, sql } from "drizzle-orm";
import { db, apiTokensTable, apiTokenAuditTable, type ApiToken, type User } from "@workspace/db";
import { randomUUID } from "crypto";
import { logger } from "../lib/logger.js";
import { sha256, isScope, type ApiTokenScope } from "../lib/security/apiToken.js";
import { usersTable } from "@workspace/db";

/** Augmented Express request — populated by requireApiToken. */
export interface ApiTokenRequest extends Request {
  apiToken: ApiToken;
  apiTokenUser: User;
  apiTokenScopes: Set<ApiTokenScope>;
}

/** Parse `Authorization: Bearer bos_xxx_yyy` and return the plaintext token. */
function extractBearerToken(req: Request): string | null {
  const auth = req.headers.authorization ?? req.headers.Authorization;
  if (typeof auth !== "string") return null;
  const m = /^Bearer\s+(\S+)$/i.exec(auth.trim());
  return m?.[1] ?? null;
}

async function audit(
  tokenId: string | null,
  userId: string,
  eventType: string,
  req: Request,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    await db.insert(apiTokenAuditTable).values({
      id: randomUUID(),
      token_id: tokenId,
      user_id: userId,
      event_type: eventType,
      ip: (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim()
        ?? req.socket.remoteAddress
        ?? null,
      user_agent: (req.headers["user-agent"] as string | undefined) ?? null,
      metadata: metadata ?? null,
    });
  } catch (err) {
    logger.error({ err, eventType }, "failed to write api_token_audit row");
  }
}

/** Token-auth middleware. Attaches `req.apiToken`, `req.apiTokenUser`,
 *  `req.apiTokenScopes` on success. Returns 401 on missing/invalid token,
 *  403 on expired/revoked, 403 on PowerShell-only token called from a
 *  web origin. */
export async function requireApiToken(req: Request, res: Response, next: NextFunction): Promise<void> {
  const plaintext = extractBearerToken(req);
  if (!plaintext) {
    res.status(401).json({ error: "missing_bearer_token" });
    return;
  }
  const hash = sha256(plaintext);
  let row: ApiToken | undefined;
  try {
    const found = await db
      .select()
      .from(apiTokensTable)
      .where(and(eq(apiTokensTable.token_hash, hash), isNull(apiTokensTable.revoked_at)))
      .limit(1);
    row = found[0];
  } catch (err) {
    logger.error({ err }, "api token lookup failed");
    res.status(500).json({ error: "token_lookup_failed" });
    return;
  }
  if (!row) {
    res.status(401).json({ error: "invalid_token" });
    return;
  }
  if (row.expires_at && row.expires_at.getTime() < Date.now()) {
    await audit(row.id, row.user_id, "EXPIRED", req);
    res.status(403).json({ error: "token_expired" });
    return;
  }
  if (row.power_shell_only) {
    const ua = (req.headers["user-agent"] as string | undefined) ?? "";
    const looksLikeBrowser = /mozilla|chrome|safari|firefox|edge|webkit/i.test(ua);
    if (looksLikeBrowser) {
      await audit(row.id, row.user_id, "USE_FAILED", req, { reason: "power_shell_only" });
      res.status(403).json({ error: "token_restricted_to_powershell" });
      return;
    }
  }
  // Resolve user
  let user: User | undefined;
  try {
    const u = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, row.user_id))
      .limit(1);
    user = u[0];
  } catch (err) {
    logger.error({ err }, "api token user lookup failed");
    res.status(500).json({ error: "user_lookup_failed" });
    return;
  }
  if (!user || user.status !== "active") {
    await audit(row.id, row.user_id, "USE_FAILED", req, { reason: "user_inactive" });
    res.status(403).json({ error: "user_inactive" });
    return;
  }
  // Touch last_used_at (async, fire-and-forget — don't block the request)
  void db
    .update(apiTokensTable)
    .set({ last_used_at: new Date() })
    .where(eq(apiTokensTable.id, row.id))
    .catch((err) => logger.warn({ err }, "api token last_used_at update failed"));

  const scopes = new Set<ApiTokenScope>();
  for (const s of row.scopes ?? []) {
    if (isScope(s)) scopes.add(s);
  }
  const r = req as ApiTokenRequest;
  r.apiToken = row;
  r.apiTokenUser = user;
  r.apiTokenScopes = scopes;
  await audit(row.id, row.user_id, "USE", req);
  next();
}

/** Require a specific scope (or one of several). 403 if missing. */
export function requireScope(...allowed: ApiTokenScope[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const r = req as ApiTokenRequest;
    if (!r.apiToken) {
      res.status(401).json({ error: "missing_bearer_token" });
      return;
    }
    for (const s of allowed) {
      if (r.apiTokenScopes.has(s)) {
        next();
        return;
      }
    }
    void audit(
      r.apiToken.id,
      r.apiToken.user_id,
      "SCOPE_DENIED",
      req,
      { required: allowed, granted: Array.from(r.apiTokenScopes) },
    );
    res.status(403).json({ error: "scope_denied", required: allowed });
  };
}

/** Re-export so the routers don't need to import from schema directly. */
export { sql };
