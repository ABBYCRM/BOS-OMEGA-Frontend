/**
 * Task #85 — per-user image-generation spend caps.
 *
 * Two ceilings, enforced together:
 *   - daily count : how many images the user can persist today
 *   - daily USD   : the estimated provider charge they can incur today
 *
 * Engine defaults come from env (so an operator can ratchet caps without
 * redeploying schema). A row in `image_quota_overrides` raises (or lowers)
 * either cap per-user. Usage is derived live from the audit chain so the
 * quota never gets out of sync with what was actually generated.
 *
 * Anonymous callers (user_id === null — only test fixtures) bypass the
 * gate so the existing image-bridge unit tests keep working without
 * needing a stub user. Real users always have an id.
 */
import { db } from "@workspace/db";
import {
  imageQuotaOverridesTable,
  auditLogsTable,
  tasksTable,
} from "@workspace/db";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { auditLog } from "./auditEngine.js";
import { logger } from "../lib/logger.js";

// ---------------------------------------------------------------------------
// Cost lookup — cents per successful image. Sourced from each provider's
// public per-image price for the standard size (1024x1024) as of Apr 2026.
// Mock provider is free (dev/CI must not consume real budget). Unknown
// (provider, model) pairs default to 5¢ as a conservative upper bound so a
// new adapter can never accidentally bypass the USD cap.
// ---------------------------------------------------------------------------
export const IMAGE_COST_USD_CENTS_DEFAULT = 5;
export const IMAGE_COST_USD_CENTS: Record<string, number> = {
  "openai:gpt-image-1": 4,
  "gemini:gemini-2.5-flash-image": 4,
  "mock:mock-deterministic": 0,
};

export function costCentsFor(provider: string, model: string): number {
  const key = `${provider.toLowerCase()}:${model.toLowerCase()}`;
  const v = IMAGE_COST_USD_CENTS[key];
  return Number.isFinite(v) ? (v as number) : IMAGE_COST_USD_CENTS_DEFAULT;
}

// ---------------------------------------------------------------------------
// Defaults from env. Parsed once per call so test harnesses can mutate
// process.env between cases without restarting the server.
// ---------------------------------------------------------------------------
// The USD cap is the real spend guardrail (default $5/day ≈ 125 OpenAI
// gpt-image-1 generations); the count cap is a backstop against runaway
// loops that generate cheap/free images forever. Set generously enough
// that ordinary product use and the dev/test loop never trip it on
// accident — operators who care about strict count limits can lower it
// via IMAGE_QUOTA_DAILY_COUNT_DEFAULT or per-user override.
const HARDCODED_COUNT_DEFAULT = 200;
const HARDCODED_USD_CENTS_DEFAULT = 500; // $5.00

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    logger.warn(
      { env: name, raw },
      "image_quota.invalid_env_falling_back_to_default",
    );
    return fallback;
  }
  return n;
}

export interface DefaultCaps {
  daily_count: number;
  daily_usd_cents: number;
}

export function getDefaultCaps(): DefaultCaps {
  return {
    daily_count: parseIntEnv(
      "IMAGE_QUOTA_DAILY_COUNT_DEFAULT",
      HARDCODED_COUNT_DEFAULT,
    ),
    daily_usd_cents: parseIntEnv(
      "IMAGE_QUOTA_DAILY_USD_CENTS_DEFAULT",
      HARDCODED_USD_CENTS_DEFAULT,
    ),
  };
}

// ---------------------------------------------------------------------------
// Override lookup + effective cap merge.
// ---------------------------------------------------------------------------
export interface EffectiveCaps {
  daily_count: number;
  daily_usd_cents: number;
  has_override: boolean;
  /** Which fields, if any, were overridden (for the Settings badge). */
  overridden_fields: Array<"daily_count" | "daily_usd_cents">;
}

export async function getUserOverrideOrNull(
  user_id: string,
): Promise<typeof imageQuotaOverridesTable.$inferSelect | null> {
  const rows = await db
    .select()
    .from(imageQuotaOverridesTable)
    .where(eq(imageQuotaOverridesTable.user_id, user_id))
    .limit(1);
  return rows[0] ?? null;
}

export async function getEffectiveCaps(user_id: string): Promise<EffectiveCaps> {
  const defaults = getDefaultCaps();
  const override = await getUserOverrideOrNull(user_id);
  const overridden_fields: Array<"daily_count" | "daily_usd_cents"> = [];
  let daily_count = defaults.daily_count;
  let daily_usd_cents = defaults.daily_usd_cents;
  if (override) {
    if (override.max_images_per_day !== null) {
      daily_count = override.max_images_per_day;
      overridden_fields.push("daily_count");
    }
    if (override.max_usd_cents_per_day !== null) {
      daily_usd_cents = override.max_usd_cents_per_day;
      overridden_fields.push("daily_usd_cents");
    }
  }
  return {
    daily_count,
    daily_usd_cents,
    has_override: override !== null && overridden_fields.length > 0,
    overridden_fields,
  };
}

// ---------------------------------------------------------------------------
// Usage rollup — derived live from audit_logs joined to tasks.user_id over
// the current UTC calendar day.
//
// We count IMAGE_GENERATED + IMAGE_EDIT_COMPLETED rows (every successful
// persist == one billable image). Cost is read from each row's metadata
// `cost_usd_cents` field, which the bridge writes at persist time. Rows
// missing that field (legacy) are charged the default lookup as a
// conservative fallback so usage is never undercounted.
// ---------------------------------------------------------------------------
export interface TodayUsage {
  count: number;
  usd_cents: number;
  /** UTC midnight that the rolling window started at (ISO). */
  window_started_at: string;
}

function utcMidnightToday(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

const COUNTED_EVENTS = ["IMAGE_GENERATED", "IMAGE_EDIT_COMPLETED"] as const;

export async function getTodayUsage(user_id: string): Promise<TodayUsage> {
  const since = utcMidnightToday();
  const rows = await db
    .select({
      metadata: auditLogsTable.metadata,
    })
    .from(auditLogsTable)
    .innerJoin(tasksTable, eq(auditLogsTable.task_id, tasksTable.id))
    .where(
      and(
        eq(tasksTable.user_id, user_id),
        inArray(auditLogsTable.event_type, COUNTED_EVENTS as unknown as string[]),
        gte(auditLogsTable.created_at, since),
      ),
    );

  let count = 0;
  let usd_cents = 0;
  for (const row of rows) {
    count += 1;
    const md = (row.metadata ?? {}) as Record<string, unknown>;
    const c = md["cost_usd_cents"];
    if (typeof c === "number" && Number.isFinite(c) && c >= 0) {
      usd_cents += Math.floor(c);
    } else {
      // Legacy / missing cost — fall back to the provider+model lookup so
      // usage is conservatively over-counted rather than under-counted.
      const provider =
        typeof md["provider"] === "string" ? (md["provider"] as string) : "";
      const model =
        typeof md["model"] === "string" ? (md["model"] as string) : "";
      // Mock rows are intentionally free — only charge if we actually
      // know the provider/model.
      if (provider && model && provider !== "mock") {
        usd_cents += costCentsFor(provider, model);
      }
    }
  }

  return {
    count,
    usd_cents,
    window_started_at: since.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Pre-flight enforcement. Called BEFORE any provider call. Returns
// { allowed: true } when the user is under both caps, otherwise
// { allowed: false, reason } and emits an IMAGE_QUOTA_BLOCKED audit row.
//
// `estimated_cost_usd_cents` is the worst-case charge of the upcoming
// attempt (planned[0] cost). This is intentionally conservative: if the
// FIRST planned provider would push us over the USD cap, we block — even
// though a cheaper fallback might fit. That keeps the gate simple to
// reason about and matches the "stop runaway costs" intent.
// ---------------------------------------------------------------------------
export interface QuotaAllowed {
  allowed: true;
  caps: EffectiveCaps;
  usage_before: TodayUsage;
  estimated_cost_usd_cents: number;
}

export interface QuotaBlocked {
  allowed: false;
  caps: EffectiveCaps;
  usage_before: TodayUsage;
  estimated_cost_usd_cents: number;
  /** Which cap tripped (the FIRST one we observed — count is checked first). */
  tripped: "count" | "usd";
  /** Friendly summary the bridge will surface as the HOLD answer. */
  summary: string;
}

export type QuotaResult = QuotaAllowed | QuotaBlocked;

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Best-effort pre-flight quota check for an image-generation request.
 *
 * KNOWN LIMITATION (intentional, scoped to a follow-up):
 *   This is a read-then-act check, not a transactional reservation. Two
 *   concurrent requests from the same user can each pass the gate before
 *   either's success audit row is written, causing a single-tick
 *   overshoot on the count cap (and ~one provider call's worth of USD on
 *   the spend cap). For the goal of this task ("stop runaway
 *   image-generation costs") that's an accepted trade-off — the gate
 *   stops sustained loops dead and the worst-case overshoot under
 *   contention is bounded by the number of in-flight requests, not by
 *   the daily cap. A future tightening (atomic ledger row per
 *   user+UTC-day, locked with `SELECT ... FOR UPDATE`) would close that
 *   window without changing the public API of this function.
 */
export async function enforceImageQuota(opts: {
  user_id: string | null;
  task_id: string;
  estimated_cost_usd_cents: number;
  /** Audit-only: which entrypoint fired ("generation" | "edit"). */
  operation: "generation" | "edit";
}): Promise<QuotaResult> {
  // Anonymous callers (test fixtures only) bypass the gate.
  if (!opts.user_id) {
    const caps = { daily_count: 0, daily_usd_cents: 0, has_override: false, overridden_fields: [] as Array<"daily_count" | "daily_usd_cents"> };
    return {
      allowed: true,
      caps,
      usage_before: { count: 0, usd_cents: 0, window_started_at: utcMidnightToday().toISOString() },
      estimated_cost_usd_cents: opts.estimated_cost_usd_cents,
    };
  }

  const caps = await getEffectiveCaps(opts.user_id);
  const usage = await getTodayUsage(opts.user_id);

  // Count cap is checked first because it's the most intuitive signal a
  // user will recognize ("I asked for too many today"). USD cap is the
  // backstop for cheap-but-many runs that wouldn't trip the count cap.
  const wouldExceedCount = usage.count >= caps.daily_count;
  const wouldExceedUsd =
    usage.usd_cents + opts.estimated_cost_usd_cents > caps.daily_usd_cents;

  if (!wouldExceedCount && !wouldExceedUsd) {
    return {
      allowed: true,
      caps,
      usage_before: usage,
      estimated_cost_usd_cents: opts.estimated_cost_usd_cents,
    };
  }

  const tripped: "count" | "usd" = wouldExceedCount ? "count" : "usd";
  const summary =
    tripped === "count"
      ? `Spend limit reached: ${usage.count} of ${caps.daily_count} images already generated today (cap resets at UTC midnight). Lower the load, raise the cap in Settings, or wait for the window to reset.`
      : `Spend limit reached: ${formatUsd(usage.usd_cents)} of ${formatUsd(caps.daily_usd_cents)} estimated USD already spent on image generation today (this attempt would add ${formatUsd(opts.estimated_cost_usd_cents)}). Cap resets at UTC midnight.`;

  await auditLog(
    opts.task_id,
    "IMAGE_QUOTA_BLOCKED",
    `Image ${opts.operation} blocked by quota (${tripped})`,
    {
      user_id: opts.user_id,
      operation: opts.operation,
      tripped,
      daily_count: usage.count,
      daily_count_cap: caps.daily_count,
      daily_usd_cents: usage.usd_cents,
      daily_usd_cents_cap: caps.daily_usd_cents,
      estimated_cost_usd_cents: opts.estimated_cost_usd_cents,
      has_override: caps.has_override,
      overridden_fields: caps.overridden_fields,
      window_started_at: usage.window_started_at,
    },
  );

  return {
    allowed: false,
    caps,
    usage_before: usage,
    estimated_cost_usd_cents: opts.estimated_cost_usd_cents,
    tripped,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Override management. Used by an admin route (not exposed in this task) +
// future Settings UI extension. Kept in this module so all quota state
// lives in one place.
// ---------------------------------------------------------------------------
export async function upsertUserOverride(
  user_id: string,
  patch: {
    max_images_per_day?: number | null;
    max_usd_cents_per_day?: number | null;
    note?: string | null;
  },
): Promise<typeof imageQuotaOverridesTable.$inferSelect> {
  const now = new Date();
  const values = {
    user_id,
    max_images_per_day: patch.max_images_per_day ?? null,
    max_usd_cents_per_day: patch.max_usd_cents_per_day ?? null,
    note: patch.note ?? null,
    created_at: now,
    updated_at: now,
  };
  await db
    .insert(imageQuotaOverridesTable)
    .values(values)
    .onConflictDoUpdate({
      target: imageQuotaOverridesTable.user_id,
      set: {
        max_images_per_day: values.max_images_per_day,
        max_usd_cents_per_day: values.max_usd_cents_per_day,
        note: values.note,
        updated_at: now,
      },
    });
  const row = await getUserOverrideOrNull(user_id);
  if (!row) {
    throw new Error("Failed to upsert image quota override");
  }
  return row;
}

export async function clearUserOverride(user_id: string): Promise<void> {
  await db
    .delete(imageQuotaOverridesTable)
    .where(eq(imageQuotaOverridesTable.user_id, user_id));
}

// Exported only for tests; production code uses the public helpers above.
export const __test__ = { utcMidnightToday, sql };
