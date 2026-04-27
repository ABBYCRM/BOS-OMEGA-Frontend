/**
 * Task #85 — image-generation spend cap surface.
 *
 * GET    /api/image-quota                       → current caller's usage + caps.
 * PUT    /api/image-quota/users/:user_id/override → upsert override (super_admin only).
 * DELETE /api/image-quota/users/:user_id/override → drop override (super_admin only).
 *
 * Cost-governance rule: ONLY super_admin may mutate an override, on
 * behalf of any user (incl. themselves). A non-admin user cannot raise
 * (or lower) their own cap — the whole point of this task is to stop
 * runaway costs, so per-user override authority is reserved for the
 * operator who's responsible for the org's budget.
 */
import { Router } from "express";
import {
  getDefaultCaps,
  getEffectiveCaps,
  getTodayUsage,
  getUserOverrideOrNull,
  upsertUserOverride,
  clearUserOverride,
} from "../bos/imageQuotas.js";

// Hard upper bounds on any single override. These bracket what a
// reasonable operator might set ($100/day is already 25× the engine
// default) so a typo can't accidentally brick the gate by setting the
// cap to Number.MAX_SAFE_INTEGER. The lower clamp (>= 0) lets a
// super_admin lock a user out by setting count = 0 if needed.
const MAX_OVERRIDE_COUNT = 1000;
const MAX_OVERRIDE_USD_CENTS = 10_000; // $100.00

const router = Router();

router.get("/", async (req, res) => {
  if (!req.user?.id) {
    res
      .status(401)
      .json({ error: "Authentication required", code: "UNAUTHENTICATED" });
    return;
  }
  const [defaults, caps, usage, override] = await Promise.all([
    Promise.resolve(getDefaultCaps()),
    getEffectiveCaps(req.user.id),
    getTodayUsage(req.user.id),
    getUserOverrideOrNull(req.user.id),
  ]);
  res.json({
    defaults,
    caps: {
      daily_count: caps.daily_count,
      daily_usd_cents: caps.daily_usd_cents,
    },
    has_override: caps.has_override,
    overridden_fields: caps.overridden_fields,
    usage_today: {
      count: usage.count,
      usd_cents: usage.usd_cents,
      window_started_at: usage.window_started_at,
    },
    override_note: override?.note ?? null,
  });
});

function requireSuperAdmin(
  req: import("express").Request,
  res: import("express").Response,
): boolean {
  if (!req.user?.id) {
    res
      .status(401)
      .json({ error: "Authentication required", code: "UNAUTHENTICATED" });
    return false;
  }
  if (req.user.role !== "super_admin") {
    // Cost-governance: only the operator with super_admin can mutate
    // image-quota overrides. A non-super user gets a friendly hint
    // pointing them at the admin so they don't sit guessing.
    res.status(403).json({
      error:
        "Only a super admin can change image spend caps. Ask your administrator to raise your daily image limit.",
      code: "SUPER_ADMIN_REQUIRED",
    });
    return false;
  }
  return true;
}

router.put("/users/:user_id/override", async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;
  const target = req.params.user_id;
  if (!target || typeof target !== "string") {
    res
      .status(400)
      .json({ error: "user_id path param required", code: "INVALID_USER_ID" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;

  function parseNullableInt(
    raw: unknown,
    field: string,
    upper: number,
  ): { ok: true; value: number | null } | { ok: false; error: string } {
    if (raw === null || raw === undefined) return { ok: true, value: null };
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      return { ok: false, error: `${field} must be a number or null` };
    }
    const n = Math.floor(raw);
    if (n < 0) return { ok: false, error: `${field} must be >= 0` };
    if (n > upper) {
      return {
        ok: false,
        error: `${field} must be <= ${upper.toLocaleString()}`,
      };
    }
    return { ok: true, value: n };
  }

  const c = parseNullableInt(
    body["max_images_per_day"],
    "max_images_per_day",
    MAX_OVERRIDE_COUNT,
  );
  if (!c.ok) {
    res.status(400).json({ error: c.error, code: "INVALID_OVERRIDE" });
    return;
  }
  const u = parseNullableInt(
    body["max_usd_cents_per_day"],
    "max_usd_cents_per_day",
    MAX_OVERRIDE_USD_CENTS,
  );
  if (!u.ok) {
    res.status(400).json({ error: u.error, code: "INVALID_OVERRIDE" });
    return;
  }
  const note =
    typeof body["note"] === "string"
      ? (body["note"] as string).slice(0, 500)
      : null;

  await upsertUserOverride(target, {
    max_images_per_day: c.value,
    max_usd_cents_per_day: u.value,
    note,
  });
  res.json({ ok: true });
});

router.delete("/users/:user_id/override", async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;
  const target = req.params.user_id;
  if (!target || typeof target !== "string") {
    res
      .status(400)
      .json({ error: "user_id path param required", code: "INVALID_USER_ID" });
    return;
  }
  await clearUserOverride(target);
  res.json({ ok: true });
});

export default router;
