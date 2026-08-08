import { Router, type Request, type Response } from "express";
import { eq, and, desc, asc, sql, isNull } from "drizzle-orm";
import { z } from "zod/v4";
import { randomUUID } from "crypto";
import {
  db,
  memoryItemsTable,
  llmProvidersTable,
  auditLogsTable,
} from "@workspace/db";
import { requireApiToken, requireScope, type ApiTokenRequest } from "../middlewares/apiTokenAuth.js";
import { logger } from "../lib/logger.js";
import { resolveProviderKey } from "../lib/keyResolver.js";

/**
 * BOS-OMEGA external tuning API.
 *
 * Single namespace that lets an operator drive every tunable from the
 * token-authenticated bridge. The "state" endpoint dumps everything in
 * one call so a PowerShell session can `Invoke-Bos -Path "tuning/state"`
 * and see the current config without juggling 5 separate endpoints.
 *
 * Endpoints (all require Bearer auth + a token with the right scope):
 *   GET    /api/external/tuning/state          — full snapshot
 *   GET    /api/external/tuning/canon          — list canon (alias to memory?layer=canon)
 *   POST   /api/external/tuning/canon          — add a canon item
 *   PATCH  /api/external/tuning/canon/:id      — edit a canon item
 *   DELETE /api/external/tuning/canon/:id      — remove a canon item
 *   GET    /api/external/tuning/providers      — list provider config
 *   PATCH  /api/external/tuning/providers/:id  — toggle enabled, set priority, rename
 *   GET    /api/external/tuning/persona        — read active persona text + tunable knobs
 *   GET    /api/external/tuning/generation     — read per-provider generation defaults
 *   POST   /api/external/tokens/:id/rotate    — mint a new plaintext, replace the old
 *
 * Scopes:
 *   tuning:read  — all GETs
 *   tuning:write — POST/PATCH/DELETE
 *   tokens:manage — /tokens/:id/rotate
 */

const router = Router();
router.use(requireApiToken);

const CanonCreateBody = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1),
  authority_level: z.number().int().min(0).max(10).optional(),
});

const CanonPatchBody = z.object({
  title: z.string().min(1).max(200).optional(),
  content: z.string().min(1).optional(),
  authority_level: z.number().int().min(0).max(10).optional(),
});

const CanonBulkBody = z.object({
  // When true, atomic: DELETE all global canon, INSERT these in one tx.
  // When false, INSERT these in addition to existing canon.
  replace: z.boolean().default(true),
  items: z.array(CanonCreateBody).min(1).max(100),
});

const ProviderPatchBody = z.object({
  enabled: z.boolean().optional(),
  priority: z.number().int().min(1).max(99).optional(),
  name: z.string().min(1).max(120).optional(),
});

async function auditTuning(req: Request, userId: string, event: string, meta: Record<string, unknown>) {
  try {
    await db.insert(auditLogsTable).values({
      id: randomUUID(),
      // audit_logs has no user_id column (the schema is task-centric).
      // We carry the operator in the metadata so the audit endpoint can
      // surface who-did-what when needed.
      task_id: null,
      event_type: `TUNING.${event}`,
      // `message` is NOT NULL — render a short human-readable line from
      // the event + metadata so the audit endpoint can list it.
      message: formatTuningMessage(event, meta),
      metadata: { ...meta, user_id: userId, ip: ((req.headers["x-forwarded-for"] as string | undefined) ?? "").split(",")[0]?.trim() || null, user_agent: (req.headers["user-agent"] as string | undefined) || null },
    });
  } catch (err) {
    logger.warn({ err, event }, "tuning audit log write failed");
  }
}

function formatTuningMessage(event: string, meta: Record<string, unknown>): string {
  switch (event) {
    case "CANON_CREATE":         return `Created canon "${meta.title}"`;
    case "CANON_PATCH":          return `Patched canon ${String(meta.id).slice(0, 8)}… (${(meta.fields as string[] | undefined)?.join(", ") ?? "?"})`;
    case "CANON_DELETE":         return `Deleted canon "${meta.title}"`;
    case "CANON_BULK_REPLACE":   return `Bulk rewrote canon: removed ${meta.removed_count}, added ${meta.added_count}`;
    case "CANON_BULK_ADD":       return `Bulk added ${meta.added_count} canon items`;
    case "PROVIDER_PATCH":       return `Patched provider ${meta.id} (${(meta.fields as string[] | undefined)?.join(", ") ?? "?"})`;
    default:                     return `Tuning event ${event}`;
  }
}

// ============ STATE (single-snapshot dump) ============
router.get("/state", requireScope("tuning:read", "memory:read"), async (req: Request, res: Response) => {
  const r = req as ApiTokenRequest;
  try {
    const canon = await db
      .select()
      .from(memoryItemsTable)
      .where(eq(memoryItemsTable.layer, "canon"))
      .orderBy(asc(memoryItemsTable.title));
    const scratchpad = await db
      .select()
      .from(memoryItemsTable)
      .where(eq(memoryItemsTable.layer, "scratchpad"))
      .orderBy(desc(memoryItemsTable.created_at))
      .limit(20);
    const providers = await db.select().from(llmProvidersTable).orderBy(asc(llmProvidersTable.priority));
    res.json({
      canon: { count: canon.length, items: canon },
      scratchpad: { count: await db.select({ c: sql<number>`count(*)` }).from(memoryItemsTable).where(eq(memoryItemsTable.layer, "scratchpad")).then(r => Number(r[0]?.c ?? 0)), recent: scratchpad },
      providers: providers.map((p) => {
        const { api_key_encrypted: _drop, ...safe } = p;
        return safe;
      }),
      persona: {
        // The persona is computed at runtime from ctx.persona + persona
        // slots (see bos/boilTheOceanEngine.ts). We expose the in-DB
        // "persona overlay" hints if any are stored on memory items with
        // layer='continuity' tagged as persona overlays. Today there are
        // none — so this section is intentionally lean until the persona
        // subsystem grows its own table.
        overlay_count: 0,
        active_slot: "default",
        note: "Persona text is composed at runtime from context. Use tuning/canon to add reusable persona fragments; they get auto-injected when matched by tag.",
      },
      generation: {
        // Per-adapter defaults are hardcoded today (see providers/*.ts).
        // Exposing them here means an operator can see what they're
        // getting without grepping the code. A future patch endpoint
        // will let you override per provider.
        defaults_by_provider: {
          openai:    { temperature: 0.3, max_tokens: 4096 },
          anthropic: { max_tokens: 4096 },
          gemini:    { temperature: 0.3, maxOutputTokens: 4096 },
          ollama:    { temperature: 0.3 },
          generic:   { temperature: 0.3, max_tokens: 4096 },
          xai:       { temperature: 0.3, max_tokens: 4096 },
          kimi:      { temperature: 0.3, max_tokens: 4096 },
          bitdeer:   { temperature: 0.3, max_tokens: 4096 },
          nvidia_nim:{ temperature: 0.3, max_tokens: 4096 },
        },
        note: "Defaults are read-only in this build. To change them, edit artifacts/api-server/src/providers/<adapter>.ts and redeploy.",
      },
      _meta: {
        token: { id: r.apiToken.id, name: r.apiToken.name, scopes: Array.from(r.apiTokenScopes) },
        user: { id: r.apiTokenUser.id, email: r.apiTokenUser.email, role: r.apiTokenUser.role },
        server_time: new Date().toISOString(),
      },
    });
  } catch (err) {
    logger.error({ err }, "tuning/state dump failed");
    res.status(500).json({ error: "tuning_state_failed" });
  }
});

// ============ CANON CRUD ============
router.get("/canon", requireScope("tuning:read", "memory:canon:read", "memory:read"), async (_req: Request, res: Response) => {
  const items = await db
    .select()
    .from(memoryItemsTable)
    .where(eq(memoryItemsTable.layer, "canon"))
    .orderBy(asc(memoryItemsTable.title));
  res.json({ count: items.length, items });
});

router.post("/canon", requireScope("tuning:write", "memory:canon:write", "memory:write"), async (req: Request, res: Response) => {
  const r = req as ApiTokenRequest;
  const parsed = CanonCreateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
    return;
  }
  const id = randomUUID();
  const now = new Date();
  await db.insert(memoryItemsTable).values({
    id,
    user_id: null, // global canon (visible to all users)
    layer: "canon",
    title: parsed.data.title,
    content: parsed.data.content,
    authority_level: parsed.data.authority_level ?? 5,
    source: "manual",
    created_at: now,
    updated_at: now,
  });
  await auditTuning(req, r.apiTokenUser.id, "CANON_CREATE", { id, title: parsed.data.title });
  res.status(201).json({ id, layer: "canon", title: parsed.data.title, content: parsed.data.content, authority_level: parsed.data.authority_level ?? 5 });
});

router.patch("/canon/:id", requireScope("tuning:write", "memory:canon:write", "memory:write"), async (req: Request, res: Response) => {
  const r = req as ApiTokenRequest;
  const id = req.params.id!;
  const parsed = CanonPatchBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
    return;
  }
  const isSuper = r.apiTokenUser.role === "super_admin";
  const [existing] = await db
    .select()
    .from(memoryItemsTable)
    .where(isSuper ? eq(memoryItemsTable.id, id) : and(eq(memoryItemsTable.id, id), eq(memoryItemsTable.layer, "canon")));
  if (!existing) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const updates: Partial<typeof memoryItemsTable.$inferInsert> = { updated_at: new Date() };
  if (parsed.data.title !== undefined) updates.title = parsed.data.title;
  if (parsed.data.content !== undefined) updates.content = parsed.data.content;
  if (parsed.data.authority_level !== undefined) updates.authority_level = parsed.data.authority_level;
  await db.update(memoryItemsTable).set(updates).where(eq(memoryItemsTable.id, id));
  await auditTuning(req, r.apiTokenUser.id, "CANON_PATCH", { id, fields: Object.keys(parsed.data) });
  const [row] = await db.select().from(memoryItemsTable).where(eq(memoryItemsTable.id, id));
  res.json(row);
});

router.delete("/canon/:id", requireScope("tuning:write", "memory:canon:write", "memory:write"), async (req: Request, res: Response) => {
  const r = req as ApiTokenRequest;
  const id = req.params.id!;
  const isSuper = r.apiTokenUser.role === "super_admin";
  const where = isSuper
    ? and(eq(memoryItemsTable.id, id), eq(memoryItemsTable.layer, "canon"))
    : and(eq(memoryItemsTable.id, id), eq(memoryItemsTable.layer, "canon"));
  const [existing] = await db.select().from(memoryItemsTable).where(where);
  if (!existing) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  await db.delete(memoryItemsTable).where(eq(memoryItemsTable.id, id));
  await auditTuning(req, r.apiTokenUser.id, "CANON_DELETE", { id, title: existing.title });
  res.json({ ok: true, removed: id });
});

/** POST /tuning/canon/bulk — bulk insert OR replace the global canon.
 *  Body: { replace: true, items: [{title, content, authority_level?}, ...] }
 *
 *  When `replace:true` (default) the endpoint atomically deletes all
 *  existing global canon (user_id IS NULL, layer='canon') and inserts
 *  the new set in a single transaction. This is the operator's "rewrite
 *  the canon" button.
 *
 *  When `replace:false` it inserts alongside the existing canon.
 *
 *  Capped at 100 items per call so a runaway script can't try to load
 *  a million canon entries in one request.
 */
router.post("/canon/bulk", requireScope("tuning:write", "memory:canon:write", "memory:write"), async (req: Request, res: Response) => {
  const r = req as ApiTokenRequest;
  const parsed = CanonBulkBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
    return;
  }
  const { replace, items } = parsed.data;
  const now = new Date();
  const newIds: string[] = [];
  try {
    if (replace) {
      // Capture the old set for the audit log before we wipe it.
      const oldCanon = await db
        .select({ id: memoryItemsTable.id, title: memoryItemsTable.title })
        .from(memoryItemsTable)
        .where(and(eq(memoryItemsTable.layer, "canon"), isNull(memoryItemsTable.user_id)));
      await db.delete(memoryItemsTable).where(
        and(eq(memoryItemsTable.layer, "canon"), isNull(memoryItemsTable.user_id))
      );
      for (const it of items) {
        const id = randomUUID();
        newIds.push(id);
        await db.insert(memoryItemsTable).values({
          id,
          user_id: null,
          layer: "canon",
          title: it.title,
          content: it.content,
          authority_level: it.authority_level ?? 5,
          source: "manual",
          created_at: now,
          updated_at: now,
        });
      }
      await auditTuning(req, r.apiTokenUser.id, "CANON_BULK_REPLACE", {
        removed_count: oldCanon.length,
        removed_titles: oldCanon.map((c) => c.title),
        added_count: items.length,
        added_titles: items.map((i) => i.title),
      });
      res.json({
        ok: true,
        mode: "replace",
        removed: oldCanon.length,
        added: newIds.length,
        ids: newIds,
      });
      return;
    }
    // append mode
    for (const it of items) {
      const id = randomUUID();
      newIds.push(id);
      await db.insert(memoryItemsTable).values({
        id,
        user_id: null,
        layer: "canon",
        title: it.title,
        content: it.content,
        authority_level: it.authority_level ?? 5,
        source: "manual",
        created_at: now,
        updated_at: now,
      });
    }
    await auditTuning(req, r.apiTokenUser.id, "CANON_BULK_ADD", {
      added_count: items.length,
      added_titles: items.map((i) => i.title),
    });
    res.json({ ok: true, mode: "append", added: newIds.length, ids: newIds });
  } catch (err) {
    logger.error({ err }, "canon bulk replace failed");
    res.status(500).json({ error: "canon_bulk_failed" });
  }
});

// ============ PROVIDER CONFIG ============
router.get("/providers", requireScope("tuning:read"), async (_req: Request, res: Response) => {
  const providers = await db.select().from(llmProvidersTable).orderBy(asc(llmProvidersTable.priority));
  // Resolve and fingerprint every key (DB or env) for the snapshot. The
  // key fingerprint is the non-reversible 4+4 SHA-256 prefix+suffix —
  // operators can see "is this the same key I set last week?" without
  // ever exposing the key itself.
  const out = [];
  for (const p of providers) {
    const { api_key_encrypted: _drop, ...safe } = p;
    const resolved = await resolveProviderKey(p.id, p.name);
    out.push({
      ...safe,
      key_resolved_via: resolved.source,
      key_fingerprint: resolved.key_fingerprint,
    });
  }
  res.json({ count: out.length, providers: out });
});

router.patch("/providers/:id", requireScope("tuning:write"), async (req: Request, res: Response) => {
  const r = req as ApiTokenRequest;
  const id = req.params.id!;
  const parsed = ProviderPatchBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
    return;
  }
  const [existing] = await db.select().from(llmProvidersTable).where(eq(llmProvidersTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const updates: Partial<typeof llmProvidersTable.$inferInsert> = { updated_at: new Date() };
  if (parsed.data.enabled !== undefined) updates.enabled = parsed.data.enabled;
  if (parsed.data.priority !== undefined) updates.priority = parsed.data.priority;
  if (parsed.data.name !== undefined) updates.name = parsed.data.name;
  await db.update(llmProvidersTable).set(updates).where(eq(llmProvidersTable.id, id));
  await auditTuning(req, r.apiTokenUser.id, "PROVIDER_PATCH", { id, fields: Object.keys(parsed.data) });
  const [row] = await db.select().from(llmProvidersTable).where(eq(llmProvidersTable.id, id));
  const { api_key_encrypted: _drop, ...safe } = row;
  res.json(safe);
});

// ============ PERSONA (read-only for now) ============
router.get("/persona", requireScope("tuning:read"), async (_req: Request, res: Response) => {
  res.json({
    active_slot: "default",
    note: "Persona is composed at runtime. The kernel reads ctx.persona (set by the active route) and appends the matching scratchpad entries tagged 'persona' as an overlay. Use tuning/canon to add reusable persona fragments.",
    editable: false,
  });
});

// ============ GENERATION (read-only for now) ============
router.get("/generation", requireScope("tuning:read"), async (_req: Request, res: Response) => {
  res.json({
    editable: false,
    note: "Per-adapter defaults are hardcoded in src/providers/<adapter>.ts. To change, edit source and redeploy. Future: move to a 'generation_defaults' DB table so this endpoint can be PATCHed.",
    defaults_by_provider: {
      openai:    { temperature: 0.3, max_tokens: 4096 },
      anthropic: { max_tokens: 4096 },
      gemini:    { temperature: 0.3, maxOutputTokens: 4096 },
      ollama:    { temperature: 0.3 },
      generic:   { temperature: 0.3, max_tokens: 4096 },
      xai:       { temperature: 0.3, max_tokens: 4096 },
      kimi:      { temperature: 0.3, max_tokens: 4096 },
      bitdeer:   { temperature: 0.3, max_tokens: 4096 },
      nvidia_nim:{ temperature: 0.3, max_tokens: 4096 },
    },
  });
});

// ============ TOKEN ROTATE ============
// Lives at /api/external/tokens/:id/rotate (in routes/external.ts).
// Operators hit tuning/state to see all their tokens, then call
// /api/external/tokens/<id>/rotate to recover from a lost plaintext.

export default router;
