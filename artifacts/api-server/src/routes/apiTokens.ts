import { Router, type Request, type Response } from "express";
import { randomUUID } from "crypto";
import { eq, and, desc, sql } from "drizzle-orm";
import { db, apiTokensTable, apiTokenAuditTable } from "@workspace/db";
import { requireAuth } from "../lib/security/auth.js";
import {
  generateApiToken,
  API_TOKEN_SCOPES,
  isScope,
  type ApiTokenScope,
  maskToken,
} from "../lib/security/apiToken.js";
import { logger } from "../lib/logger.js";
import { z } from "zod/v4";

const router = Router();

// All token management endpoints require a session.
router.use(requireAuth);

const createBodySchema = z.object({
  name: z.string().min(1).max(80),
  scopes: z.array(z.string()).min(1),
  expires_in_days: z.number().int().min(1).max(365).optional(),
  power_shell_only: z.boolean().optional().default(false),
});

/** POST /api/tokens — create a new API token. Returns the plaintext
 *  token exactly once. */
router.post("/", async (req: Request, res: Response) => {
  const parsed = createBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
    return;
  }
  const { name, scopes, expires_in_days, power_shell_only } = parsed.data;
  // Validate scopes
  const invalid = scopes.filter((s) => !isScope(s));
  if (invalid.length > 0) {
    res.status(400).json({ error: "invalid_scopes", invalid });
    return;
  }
  const { plaintext, prefix, hash } = generateApiToken();
  const id = randomUUID();
  const expires_at = expires_in_days
    ? new Date(Date.now() + expires_in_days * 24 * 60 * 60 * 1000)
    : null;
  try {
    await db.insert(apiTokensTable).values({
      id,
      user_id: req.user!.id,
      name,
      token_hash: hash,
      token_prefix: prefix,
      scopes,
      expires_at,
      power_shell_only: !!power_shell_only,
    });
    await db.insert(apiTokenAuditTable).values({
      id: randomUUID(),
      token_id: id,
      user_id: req.user!.id,
      event_type: "CREATE",
      ip: (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? null,
      user_agent: (req.headers["user-agent"] as string | undefined) ?? null,
      metadata: { scopes, name },
    });
    res.status(201).json({
      id,
      name,
      plaintext, // shown exactly once
      mask: maskToken(prefix),
      scopes,
      expires_at,
      power_shell_only: !!power_shell_only,
      created_at: new Date(),
      warning:
        "Save this token now. The plaintext is not stored on the server and cannot be shown again.",
    });
  } catch (err) {
    logger.error({ err }, "failed to create api token");
    res.status(500).json({ error: "create_failed" });
  }
});

/** GET /api/tokens — list the caller's tokens (never the plaintext). */
router.get("/", async (req: Request, res: Response) => {
  try {
    const rows = await db
      .select()
      .from(apiTokensTable)
      .where(eq(apiTokensTable.user_id, req.user!.id))
      .orderBy(desc(apiTokensTable.created_at));
    res.json({
      tokens: rows.map((r) => ({
        id: r.id,
        name: r.name,
        mask: maskToken(r.token_prefix),
        scopes: r.scopes,
        expires_at: r.expires_at,
        last_used_at: r.last_used_at,
        created_at: r.created_at,
        revoked_at: r.revoked_at,
        revoked_reason: r.revoked_reason,
        power_shell_only: r.power_shell_only,
        active:
          r.revoked_at === null &&
          (r.expires_at === null || r.expires_at.getTime() > Date.now()),
      })),
    });
  } catch (err) {
    logger.error({ err }, "failed to list api tokens");
    res.status(500).json({ error: "list_failed" });
  }
});

/** GET /api/tokens/scopes — the catalog of valid scopes (for the UI). */
router.get("/scopes", (_req: Request, res: Response) => {
  res.json({ scopes: API_TOKEN_SCOPES });
});

const revokeBodySchema = z.object({ reason: z.string().max(500).optional() });

/** DELETE /api/tokens/:id — hard-delete a token row (irreversible).
 *  Use only after the token is already revoked, or to clean up a
 *  never-used token you minted by accident. */
router.delete("/:id", async (req: Request, res: Response) => {
  const id = req.params.id!;
  try {
    const found = await db
      .select()
      .from(apiTokensTable)
      .where(
        and(eq(apiTokensTable.id, id), eq(apiTokensTable.user_id, req.user!.id)),
      )
      .limit(1);
    const row = found[0];
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    await db.delete(apiTokensTable).where(eq(apiTokensTable.id, id));
    await db.insert(apiTokenAuditTable).values({
      id: randomUUID(),
      token_id: id,
      user_id: req.user!.id,
      event_type: "HARD_DELETE",
      ip: (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? null,
      user_agent: (req.headers["user-agent"] as string | undefined) ?? null,
      metadata: { token_name: row.name, previously_revoked: row.revoked_at !== null },
    });
    res.status(204).end();
  } catch (err) {
    logger.error({ err }, "failed to hard-delete api token");
    res.status(500).json({ error: "delete_failed" });
  }
});

/** DELETE /api/tokens?revoked_only=1 — wipe every revoked token for the
 *  caller. Used to clean up smoke-test tokens after a deploy. */
router.delete("/", async (req: Request, res: Response) => {
  const revokedOnly = String(req.query.revoked_only ?? "0") === "1";
  try {
    const conditions = [eq(apiTokensTable.user_id, req.user!.id)];
    if (revokedOnly) conditions.push(sql`${apiTokensTable.revoked_at} IS NOT NULL`);
    const found = await db
      .select({ id: apiTokensTable.id, name: apiTokensTable.name })
      .from(apiTokensTable)
      .where(and(...conditions));
    if (found.length === 0) {
      res.json({ removed: 0 });
      return;
    }
    await db
      .delete(apiTokensTable)
      .where(and(...conditions));
    await db.insert(apiTokenAuditTable).values({
      id: randomUUID(),
      token_id: null,
      user_id: req.user!.id,
      event_type: "WIPE_REVOKED",
      ip: (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? null,
      user_agent: (req.headers["user-agent"] as string | undefined) ?? null,
      metadata: { removed_count: found.length, names: found.map((r) => r.name) },
    });
    res.json({ removed: found.length });
  } catch (err) {
    logger.error({ err }, "failed to wipe api tokens");
    res.status(500).json({ error: "wipe_failed" });
  }
});

/** POST /api/tokens/:id/revoke — soft-revoke a token. */
router.post("/:id/revoke", async (req: Request, res: Response) => {
  const parsed = revokeBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }
  const id = req.params.id!;
  try {
    const found = await db
      .select()
      .from(apiTokensTable)
      .where(
        and(eq(apiTokensTable.id, id), eq(apiTokensTable.user_id, req.user!.id)),
      )
      .limit(1);
    const row = found[0];
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (row.revoked_at) {
      res.status(409).json({ error: "already_revoked" });
      return;
    }
    await db
      .update(apiTokensTable)
      .set({ revoked_at: new Date(), revoked_reason: parsed.data.reason ?? null })
      .where(eq(apiTokensTable.id, id));
    await db.insert(apiTokenAuditTable).values({
      id: randomUUID(),
      token_id: id,
      user_id: req.user!.id,
      event_type: "REVOKE",
      ip: (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? null,
      user_agent: (req.headers["user-agent"] as string | undefined) ?? null,
      metadata: { reason: parsed.data.reason ?? null },
    });
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "failed to revoke api token");
    res.status(500).json({ error: "revoke_failed" });
  }
});

/** GET /api/tokens/audit — recent token-usage audit for the caller's
 *  tokens. */
router.get("/audit", async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(String(req.query.limit ?? "100"), 10) || 100, 500);
  try {
    const rows = await db
      .select()
      .from(apiTokenAuditTable)
      .where(eq(apiTokenAuditTable.user_id, req.user!.id))
      .orderBy(desc(apiTokenAuditTable.created_at))
      .limit(limit);
    res.json({ events: rows });
  } catch (err) {
    logger.error({ err }, "failed to read api token audit");
    res.status(500).json({ error: "audit_failed" });
  }
});

export default router;

// Re-export the type so other modules don't have to drill in.
export type { ApiTokenScope };
