import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "crypto";
import { eq, desc } from "drizzle-orm";
import { db, usersTable, type UserRole } from "@workspace/db";
import {
  hashPassword,
  generatePassword,
  requireRole,
  reconcileOwnerSuperAdmin,
  getProtectedOwnerEmail,
  isOwnerBreakGlassEnabled,
  type AuthenticatedUser,
} from "../lib/security/auth.js";
import { auditLog } from "../bos/auditEngine.js";

const router = Router();

// Every endpoint here is super_admin-only. The mounting site already runs
// requireAuth, so req.user is guaranteed to be present once requireRole
// passes.
router.use(requireRole("super_admin"));

const RoleSchema = z.enum(["user", "admin", "super_admin"]);
const StatusSchema = z.enum(["active", "disabled"]);

// RFC 5322 is huge; this is a pragmatic check that catches the obvious
// nonsense without being a full validator. The DB has a unique index, so
// duplicate detection is authoritative there.
const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(320)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Invalid email address");

const PasswordSchema = z.string().min(8).max(256);

// Every super_admin write to a user account must carry a typed reason that
// lands in the audit log alongside actor + target. This is what the spec
// means by "the reason text the super admin typed in" — it applies to user
// management changes the same way it does to overrides.
const ReasonSchema = z.string().trim().min(3).max(2000);

const CreateUserSchema = z.object({
  email: EmailSchema,
  password: PasswordSchema,
  role: RoleSchema,
  reason: ReasonSchema,
});

const UpdateUserSchema = z
  .object({
    role: RoleSchema.optional(),
    status: StatusSchema.optional(),
    reason: ReasonSchema,
  })
  .refine((v) => v.role !== undefined || v.status !== undefined, {
    message: "At least one of role or status is required",
  });

const ResetPasswordSchema = z.object({
  reason: ReasonSchema,
});

/**
 * Owner-account protection (Task #34).
 *
 * The owner break-glass account is the always-on super_admin that can never
 * be locked out. Even another super_admin must not be able to demote it,
 * disable it, or (if a delete route is ever added) remove it through the
 * normal user-management API.
 *
 * `evaluateOwnerProtection` returns:
 *   - `null` when the change is fine (target is not the owner, or no
 *     destructive change is being attempted).
 *   - A rejection record describing what was attempted and why it was
 *     blocked, when the change should be denied. Callers use this both for
 *     the 403 response body and for the audit-log payload.
 *
 * The break-glass override (`OWNER_SUPERADMIN_BREAK_GLASS_OVERRIDE=true`)
 * lets a super_admin bypass the protection — this is the documented escape
 * hatch for genuine ownership transfer. Even when it bypasses, the action
 * is audited as a break-glass mutation.
 */
type OwnerProtectionRejection = {
  reason: "owner_role_demote" | "owner_disable" | "owner_delete";
  attempted_change: Record<string, unknown>;
  message: string;
};

function evaluateOwnerProtection(args: {
  targetEmail: string;
  newRole?: UserRole;
  newStatus?: "active" | "disabled";
  intendDelete?: boolean;
}): OwnerProtectionRejection | null {
  if (args.targetEmail.trim().toLowerCase() !== getProtectedOwnerEmail()) return null;

  if (args.intendDelete) {
    return {
      reason: "owner_delete",
      attempted_change: { delete: true },
      message: "Owner account is protected and cannot be deleted",
    };
  }
  if (args.newRole !== undefined && args.newRole !== "super_admin") {
    return {
      reason: "owner_role_demote",
      attempted_change: { role: args.newRole },
      message: "Owner account is protected and cannot be demoted below super_admin",
    };
  }
  if (args.newStatus === "disabled") {
    return {
      reason: "owner_disable",
      attempted_change: { status: "disabled" },
      message: "Owner account is protected and cannot be disabled",
    };
  }
  return null;
}

function publicUser(u: typeof usersTable.$inferSelect) {
  return {
    id: u.id,
    email: u.email,
    role: u.role as UserRole,
    status: u.status as "active" | "disabled",
    created_at: u.created_at,
    updated_at: u.updated_at,
    last_login_at: u.last_login_at,
  };
}

router.get("/", async (_req, res) => {
  const rows = await db.select().from(usersTable).orderBy(desc(usersTable.created_at));
  res.json({ users: rows.map(publicUser) });
});

router.post("/", async (req, res) => {
  const parsed = CreateUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      code: "INPUT_ERROR",
      issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
    });
    return;
  }
  const actor = req.user as AuthenticatedUser;

  // Pre-check for duplicate to give a 409 instead of a 500 from the unique index.
  const [existing] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.email, parsed.data.email))
    .limit(1);
  if (existing) {
    res.status(409).json({ error: "Email already in use", code: "EMAIL_EXISTS" });
    return;
  }

  const hash = await hashPassword(parsed.data.password);
  const [created] = await db
    .insert(usersTable)
    .values({
      id: randomUUID(),
      email: parsed.data.email,
      password_hash: hash,
      role: parsed.data.role,
      status: "active",
    })
    .returning();

  if (!created) {
    res.status(500).json({ error: "Failed to create user", code: "SYSTEM_ERROR" });
    return;
  }

  await auditLog(undefined, "USER_CREATED", `User ${created.email} created (${created.role})`, {
    actor_user_id: actor.id,
    target_user_id: created.id,
    target_email: created.email,
    role: created.role,
    reason: parsed.data.reason,
  });

  res.status(201).json({ user: publicUser(created) });
});

router.patch("/:id", async (req, res) => {
  const id = req.params["id"];
  if (!id) {
    res.status(400).json({ error: "Missing id" });
    return;
  }
  const parsed = UpdateUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      code: "INPUT_ERROR",
      issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
    });
    return;
  }
  const actor = req.user as AuthenticatedUser;

  const [target] = await db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
  if (!target) {
    res.status(404).json({ error: "User not found", code: "NOT_FOUND" });
    return;
  }

  // Self-protection: a super_admin can't lock or demote themselves; otherwise
  // they could lose access to their own account in one click.
  if (target.id === actor.id) {
    if (parsed.data.role !== undefined && parsed.data.role !== "super_admin") {
      res.status(400).json({
        error: "Cannot demote yourself",
        code: "SELF_DEMOTE_FORBIDDEN",
      });
      return;
    }
    if (parsed.data.status === "disabled") {
      res.status(400).json({
        error: "Cannot disable yourself",
        code: "SELF_DISABLE_FORBIDDEN",
      });
      return;
    }
  }

  // Owner-account protection (Task #34): even another super_admin must not
  // be able to demote, disable, or delete the owner break-glass account
  // through the normal user-management API. The break-glass override env
  // flag bypasses this — when it does, the action is still audited as a
  // break-glass mutation rather than a normal one.
  const ownerRejection = evaluateOwnerProtection({
    targetEmail: target.email,
    newRole: parsed.data.role,
    newStatus: parsed.data.status,
  });
  if (ownerRejection) {
    if (!isOwnerBreakGlassEnabled()) {
      await auditLog(
        undefined,
        "OWNER_ACCOUNT_PROTECTED_MUTATION_BLOCKED",
        `Blocked ${ownerRejection.reason} on owner ${target.email}`,
        {
          actor_user_id: actor.id,
          target_user_id: target.id,
          target_email: target.email,
          attempted_change: ownerRejection.attempted_change,
          reason_code: ownerRejection.reason,
          reason_text: parsed.data.reason,
          break_glass: false,
        },
      );
      res.status(403).json({
        error: ownerRejection.message,
        code: "OWNER_PROTECTED",
        reason: ownerRejection.reason,
      });
      return;
    }
    // Break-glass override is on; allow but audit as such. The normal
    // USER_ROLE_CHANGED / USER_DISABLED events still fire below.
    await auditLog(
      undefined,
      "OWNER_ACCOUNT_PROTECTED_MUTATION_BLOCKED",
      `BREAK-GLASS bypass: ${ownerRejection.reason} on owner ${target.email}`,
      {
        actor_user_id: actor.id,
        target_user_id: target.id,
        target_email: target.email,
        attempted_change: ownerRejection.attempted_change,
        reason_code: ownerRejection.reason,
        reason_text: parsed.data.reason,
        break_glass: true,
      },
    );
  }

  const updates: Record<string, unknown> = { updated_at: new Date() };
  if (parsed.data.role !== undefined) updates["role"] = parsed.data.role;
  if (parsed.data.status !== undefined) updates["status"] = parsed.data.status;

  const [updated] = await db.update(usersTable).set(updates).where(eq(usersTable.id, id)).returning();
  if (!updated) {
    res.status(500).json({ error: "Failed to update user", code: "SYSTEM_ERROR" });
    return;
  }

  if (parsed.data.role !== undefined && parsed.data.role !== target.role) {
    await auditLog(undefined, "USER_ROLE_CHANGED", `User ${target.email} role changed: ${target.role} → ${parsed.data.role}`, {
      actor_user_id: actor.id,
      target_user_id: target.id,
      target_email: target.email,
      from_role: target.role,
      to_role: parsed.data.role,
      reason: parsed.data.reason,
    });
  }
  if (parsed.data.status !== undefined && parsed.data.status !== target.status) {
    const event = parsed.data.status === "disabled" ? "USER_DISABLED" : "USER_ENABLED";
    await auditLog(undefined, event, `User ${target.email} ${event === "USER_DISABLED" ? "disabled" : "enabled"}`, {
      actor_user_id: actor.id,
      target_user_id: target.id,
      target_email: target.email,
      reason: parsed.data.reason,
    });
  }

  res.json({ user: publicUser(updated) });
});

/**
 * On-demand owner break-glass reconciliation.
 *
 * Mounted at `POST /api/users/owner/repair`. Runs the same routine as the
 * boot reconcile and returns the structured summary. Audited.
 *
 * Mounted BEFORE the parameterized `/:id/reset-password` and `/:id` routes
 * so Express resolves "owner" as the literal segment, not as an `:id`.
 */
router.post("/owner/repair", async (req, res) => {
  const actor = req.user as AuthenticatedUser;
  let summary;
  try {
    summary = await reconcileOwnerSuperAdmin();
  } catch (err) {
    res.status(500).json({
      error: "Owner reconcile failed",
      code: "OWNER_RECONCILE_FAILED",
      detail: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (summary.action === "created") {
    await auditLog(
      undefined,
      "OWNER_ACCOUNT_CREATED",
      `Owner break-glass account created via repair endpoint (${summary.email})`,
      {
        actor_user_id: actor.id,
        target_user_id: summary.user_id,
        target_email: summary.email,
        source: "repair_endpoint",
      },
    );
  } else if (summary.action === "repaired") {
    await auditLog(
      undefined,
      "OWNER_ACCOUNT_REPAIRED",
      `Owner break-glass account repaired via repair endpoint (${summary.email}): ${summary.changed_fields.join(", ")}`,
      {
        actor_user_id: actor.id,
        target_user_id: summary.user_id,
        target_email: summary.email,
        changed_fields: summary.changed_fields,
        password_reset: summary.password_reset,
        source: "repair_endpoint",
      },
    );
  }
  res.json({ ok: true, summary });
});

router.post("/:id/reset-password", async (req, res) => {
  const id = req.params["id"];
  if (!id) {
    res.status(400).json({ error: "Missing id" });
    return;
  }
  const parsed = ResetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      code: "INPUT_ERROR",
      issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
    });
    return;
  }
  const actor = req.user as AuthenticatedUser;

  const [target] = await db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
  if (!target) {
    res.status(404).json({ error: "User not found", code: "NOT_FOUND" });
    return;
  }

  const tempPassword = generatePassword();
  const hash = await hashPassword(tempPassword);
  await db
    .update(usersTable)
    .set({ password_hash: hash, updated_at: new Date() })
    .where(eq(usersTable.id, id));

  await auditLog(undefined, "USER_PASSWORD_RESET", `Password reset for ${target.email}`, {
    actor_user_id: actor.id,
    target_user_id: target.id,
    target_email: target.email,
    reason: parsed.data.reason,
  });

  // The temporary password is shown ONCE in the response; never persisted in
  // plaintext. The frontend must surface it to the operator immediately.
  res.json({
    ok: true,
    temporary_password: tempPassword,
    user: publicUser({ ...target, password_hash: hash, updated_at: new Date() }),
  });
});

export default router;
