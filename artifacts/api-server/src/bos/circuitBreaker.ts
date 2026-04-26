import { db } from "@workspace/db";
import { providerHealthTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger.js";

const CIRCUIT_OPEN_THRESHOLD = 5;
const CIRCUIT_WINDOW_MS = 10 * 60 * 1000;
const SCHEMA_FAILURE_THRESHOLD = 3;

export async function ensureProviderHealth(provider_id: string): Promise<void> {
  const existing = await db
    .select()
    .from(providerHealthTable)
    .where(eq(providerHealthTable.provider_id, provider_id))
    .limit(1);

  if (existing.length === 0) {
    await db.insert(providerHealthTable).values({
      id: `ph_${provider_id}`,
      provider_id,
      status: "HEALTHY",
      failure_count: 0,
      schema_failure_count: 0,
    });
  }
}

export async function recordSuccess(provider_id: string, latency_ms: number): Promise<void> {
  const health = await getHealth(provider_id);
  if (!health) return;

  const new_avg = health.avg_latency_ms > 0
    ? (health.avg_latency_ms * 0.8 + latency_ms * 0.2)
    : latency_ms;

  const new_status = health.status === "RECOVERY_TEST" ? "HEALTHY" : health.status;

  await db
    .update(providerHealthTable)
    .set({
      last_success: new Date(),
      avg_latency_ms: new_avg,
      status: new_status,
      updated_at: new Date(),
    })
    .where(eq(providerHealthTable.provider_id, provider_id));

  if (new_status === "HEALTHY" && latency_ms > 5000) {
    await markDegraded(provider_id);
  }
}

export async function recordFailure(provider_id: string, error_type: string): Promise<void> {
  const health = await getHealth(provider_id);
  if (!health) return;

  const new_failure_count = health.failure_count + 1;
  let new_schema_count = health.schema_failure_count;
  let new_status = health.status;

  if (error_type === "auth_failure") {
    new_status = "OPEN_CIRCUIT";
    logger.warn({ provider_id }, "Auth failure — circuit opened");
  } else if (error_type === "schema_failure") {
    new_schema_count += 1;
    if (new_schema_count >= SCHEMA_FAILURE_THRESHOLD) {
      new_status = "DEGRADED";
    }
  } else {
    const recent_window_start = new Date(Date.now() - CIRCUIT_WINDOW_MS);
    const last_failure = health.last_failure;
    const in_window = last_failure && last_failure > recent_window_start;

    if (in_window && new_failure_count >= CIRCUIT_OPEN_THRESHOLD) {
      new_status = "OPEN_CIRCUIT";
      logger.warn({ provider_id, failure_count: new_failure_count }, "Circuit breaker opened");
    } else if (new_failure_count >= 3 && health.status === "HEALTHY") {
      new_status = "DEGRADED";
    }
  }

  await db
    .update(providerHealthTable)
    .set({
      failure_count: new_failure_count,
      schema_failure_count: new_schema_count,
      last_failure: new Date(),
      status: new_status,
      updated_at: new Date(),
    })
    .where(eq(providerHealthTable.provider_id, provider_id));
}

export async function markDegraded(provider_id: string): Promise<void> {
  await db
    .update(providerHealthTable)
    .set({ status: "DEGRADED", updated_at: new Date() })
    .where(eq(providerHealthTable.provider_id, provider_id));
}

export async function getHealth(provider_id: string) {
  const result = await db
    .select()
    .from(providerHealthTable)
    .where(eq(providerHealthTable.provider_id, provider_id))
    .limit(1);
  return result[0] || null;
}

export async function isCircuitOpen(provider_id: string): Promise<boolean> {
  const health = await getHealth(provider_id);
  return health?.status === "OPEN_CIRCUIT";
}
