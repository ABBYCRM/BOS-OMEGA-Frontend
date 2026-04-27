/**
 * Task #85 — image-generation spend cap surface.
 *
 * GET    /api/image-quota          → current caller's usage + caps.
 * PUT    /api/image-quota/override → upsert per-user override (self).
 * DELETE /api/image-quota/override → drop override, revert to defaults.
 *
 * The overrides endpoints scope to req.user.id so a non-super user can
 * only adjust their own cap (a tight cap they impose on themselves is
 * always safe; a loose cap is bounded by the engine default upper limit
 * — see MAX_OVERRIDE_* below). A future super_admin extension can add
 * a `?user_id=` parameter to manage other users.
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

// Hard upper bounds on what a user may set for themselves. These are
// generous (1k images / $100/day) but exist so a typo can't accidentally
// brick the gate by setting the cap to Number.MAX_SAFE_INTEGER.
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

router.put("/override", async (req, res) => {
  if (!req.user?.id) {
    res
      .status(401)
      .json({ error: "Authentication required", code: "UNAUTHENTICATED" });
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

  await upsertUserOverride(req.user.id, {
    max_images_per_day: c.value,
    max_usd_cents_per_day: u.value,
    note,
  });
  res.json({ ok: true });
});

router.delete("/override", async (req, res) => {
  if (!req.user?.id) {
    res
      .status(401)
      .json({ error: "Authentication required", code: "UNAUTHENTICATED" });
    return;
  }
  await clearUserOverride(req.user.id);
  res.json({ ok: true });
});

export default router;
