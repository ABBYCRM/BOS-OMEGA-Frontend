import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "crypto";
import { eq, desc } from "drizzle-orm";
import { db, usersTable, type UserRole } from "@workspace/db";
import {
  hashPassword,
  generatePassword,
  requireRole,
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
