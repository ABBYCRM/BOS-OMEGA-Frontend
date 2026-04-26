import { Router } from "express";
import { z } from "zod";
import { randomUUID, createHash, randomBytes } from "node:crypto";
import { eq, desc } from "drizzle-orm";
import {
  db,
  bosOrgsTable,
  bosDevicesTable,
  bosOrgPolicyOverridesTable,
} from "@workspace/db";
import {
  requireRole,
  type AuthenticatedUser,
} from "../../lib/security/auth.js";
import { appendLocalAgentAudit } from "../../lib/localAgent/auditChain.js";
import {
  isWiderThanLockedValue,
  type EnterprisePolicyOverride,
  type PolicyFieldPath,
} from "@workspace/local-agent-contracts";

/**
 * Super-admin organization management for the local-agent surface.
 *
 * All routes here are super_admin-only. Reads are limited to a small
 * surface (no listing of every device on every org without a join key)
 * to keep the blast radius of a leaked super_admin cookie tractable.
 */

const router = Router();
router.use(requireRole("super_admin"));

const SlugSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "slug must be lower-kebab/snake");

const ReasonSchema = z.string().trim().min(3).max(2000);

const CreateOrgSchema = z.object({
  slug: SlugSchema,
  display_name: z.string().min(1).max(200),
  reason: ReasonSchema,
});

const RotateSecretSchema = z.object({
  reason: ReasonSchema,
});

const PolicyFieldPathSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/, "Invalid policy field path");

const SetOverrideSchema = z.object({
  policy_field_path: PolicyFieldPathSchema,
  locked_value: z.unknown(),
  reason: ReasonSchema,
});

function publicOrg(o: typeof bosOrgsTable.$inferSelect) {
  return {
    id: o.id,
    slug: o.slug,
    display_name: o.display_name,
    status: o.status,
    has_enrollment_secret: !!o.enrollment_secret_hash,
    created_at: o.created_at,
    updated_at: o.updated_at,
  };
}

// ---------------------------------------------------------------------------
// GET /v1/orgs — list every org.
// ---------------------------------------------------------------------------

router.get("/", async (_req, res) => {
  const rows = await db
    .select()
    .from(bosOrgsTable)
    .orderBy(desc(bosOrgsTable.created_at));
  res.json({ orgs: rows.map(publicOrg) });
});

// ---------------------------------------------------------------------------
// POST /v1/orgs — create a new org.
// ---------------------------------------------------------------------------

router.post("/", async (req, res) => {
  const parsed = CreateOrgSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      code: "INPUT_ERROR",
      issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
    });
    return;
  }
  const actor = req.user as AuthenticatedUser;

  const [existing] = await db
    .select({ id: bosOrgsTable.id })
    .from(bosOrgsTable)
    .where(eq(bosOrgsTable.slug, parsed.data.slug))
    .limit(1);
  if (existing) {
    res.status(409).json({ error: "Slug already in use", code: "SLUG_EXISTS" });
    return;
  }

  const [created] = await db
    .insert(bosOrgsTable)
    .values({
      id: randomUUID(),
      slug: parsed.data.slug,
      display_name: parsed.data.display_name,
      status: "active",
      created_by_user_id: actor.id,
    })
    .returning();

  if (!created) {
    res.status(500).json({ error: "Failed to create org", code: "SYSTEM_ERROR" });
    return;
  }

  await appendLocalAgentAudit({
    device_id: null,
    org_id: created.id,
    actor_user_id: actor.id,
    event_type: "ORG_CREATED",
    payload: {
      slug: created.slug,
      display_name: created.display_name,
      reason: parsed.data.reason,
    },
  });

  res.status(201).json({ org: publicOrg(created) });
});

// ---------------------------------------------------------------------------
// POST /v1/orgs/:id/rotate-enrollment-secret
// ---------------------------------------------------------------------------
// Returns the freshly-minted plaintext enrollment secret ONCE in the
// response body. Never persisted in plaintext — only the SHA-256 hash
// lives on `bos_orgs.enrollment_secret_hash`. The frontend must surface
// it to the operator immediately.

router.post("/:id/rotate-enrollment-secret", async (req, res) => {
  const id = req.params["id"];
  if (!id) {
    res.status(400).json({ error: "Missing id" });
    return;
  }
  const parsed = RotateSecretSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", code: "INPUT_ERROR" });
    return;
  }
  const actor = req.user as AuthenticatedUser;

  const [org] = await db
    .select()
    .from(bosOrgsTable)
    .where(eq(bosOrgsTable.id, id))
    .limit(1);
  if (!org) {
    res.status(404).json({ error: "Org not found", code: "NOT_FOUND" });
    return;
  }

  // 32 random bytes → 43-char base64url. Plenty of entropy and short
  // enough to paste into a config file by hand if needed.
  const plaintext = `bos_org_${randomBytes(32).toString("base64url")}`;
  const hash = createHash("sha256").update(plaintext).digest("hex");

  await db
    .update(bosOrgsTable)
    .set({ enrollment_secret_hash: hash, updated_at: new Date() })
    .where(eq(bosOrgsTable.id, id));

  await appendLocalAgentAudit({
    device_id: null,
    org_id: id,
    actor_user_id: actor.id,
    event_type: "ORG_ENROLLMENT_SECRET_ROTATED",
    payload: { reason: parsed.data.reason },
    is_critical: true,
  });

  res.json({ enrollment_secret: plaintext });
});

// ---------------------------------------------------------------------------
// GET /v1/orgs/:id/devices
// ---------------------------------------------------------------------------

router.get("/:id/devices", async (req, res) => {
  const id = req.params["id"];
  if (!id) {
    res.status(400).json({ error: "Missing id" });
    return;
  }
  const rows = await db
    .select()
    .from(bosDevicesTable)
    .where(eq(bosDevicesTable.org_id, id))
    .orderBy(desc(bosDevicesTable.paired_at));
  res.json({
    devices: rows.map((d) => ({
      id: d.id,
      org_id: d.org_id,
      install_mode: d.install_mode,
      display_name: d.display_name,
      hostname: d.hostname,
      status: d.status,
      paired_at: d.paired_at,
      last_seen_at: d.last_seen_at,
      contract_version: d.contract_version,
    })),
  });
});

// ---------------------------------------------------------------------------
// GET /v1/orgs/:id/policy-overrides
// ---------------------------------------------------------------------------

router.get("/:id/policy-overrides", async (req, res) => {
  const id = req.params["id"];
  if (!id) {
    res.status(400).json({ error: "Missing id" });
    return;
  }
  const rows = await db
    .select()
    .from(bosOrgPolicyOverridesTable)
    .where(eq(bosOrgPolicyOverridesTable.org_id, id))
    .orderBy(desc(bosOrgPolicyOverridesTable.set_at));
  res.json({ overrides: rows });
});

// ---------------------------------------------------------------------------
// POST /v1/orgs/:id/policy-overrides
// ---------------------------------------------------------------------------
// Upsert semantics: if an override already exists for the (org, path)
// pair we replace its `locked_value` and re-stamp `set_by_user_id`.
// The previous value is preserved in the audit chain via the
// `ORG_POLICY_OVERRIDE_SET` event payload.

router.post("/:id/policy-overrides", async (req, res) => {
  const id = req.params["id"];
  if (!id) {
    res.status(400).json({ error: "Missing id" });
    return;
  }
  const parsed = SetOverrideSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", code: "INPUT_ERROR" });
    return;
  }
  const actor = req.user as AuthenticatedUser;

  const [org] = await db.select().from(bosOrgsTable).where(eq(bosOrgsTable.id, id)).limit(1);
  if (!org) {
    res.status(404).json({ error: "Org not found", code: "NOT_FOUND" });
    return;
  }

  const path = parsed.data.policy_field_path as PolicyFieldPath;

  const [existing] = await db
    .select()
    .from(bosOrgPolicyOverridesTable)
    .where(eq(bosOrgPolicyOverridesTable.id, `${id}:${path}`))
    .limit(1);

  // Sanity: the new lock must not already be widening itself versus the
  // previous lock — that would be a no-op or a downgrade hidden inside
  // an override set. We allow same-or-narrower; we reject wider.
  if (existing) {
    if (isWiderThanLockedValue(parsed.data.locked_value, existing.locked_value)) {
      res.status(400).json({
        error:
          "Proposed locked_value would widen the existing org lock. Clear the override first if you really mean to relax it.",
        code: "ENTERPRISE_LOCK_WIDENS_EXISTING",
      });
      return;
    }
  }

  const row: EnterprisePolicyOverride = {
    org_id: id,
    policy_field_path: path,
    locked_value: parsed.data.locked_value,
    set_by_user_id: actor.id,
    set_at: new Date().toISOString(),
  };

  await db
    .insert(bosOrgPolicyOverridesTable)
    .values({
      id: `${id}:${path}`,
      org_id: id,
      policy_field_path: path,
      locked_value: row.locked_value,
      set_by_user_id: actor.id,
      set_at: new Date(),
    })
    .onConflictDoUpdate({
      target: bosOrgPolicyOverridesTable.id,
      set: {
        locked_value: row.locked_value,
        set_by_user_id: actor.id,
        set_at: new Date(),
      },
    });

  await appendLocalAgentAudit({
    device_id: null,
    org_id: id,
    actor_user_id: actor.id,
    event_type: "ORG_POLICY_OVERRIDE_SET",
    payload: {
      policy_field_path: path,
      previous_locked_value: existing?.locked_value ?? null,
      new_locked_value: parsed.data.locked_value,
      reason: parsed.data.reason,
    },
    is_critical: true,
  });

  res.status(201).json({ override: row });
});

export default router;
