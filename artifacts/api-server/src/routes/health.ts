import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { providerHealthTable, llmProvidersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { HealthCheckResponse } from "@workspace/api-zod";

// Public: only minimal liveness — no data leak.
export const publicHealthRouter: IRouter = Router();
publicHealthRouter.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

// Protected: detailed provider health (deployed behind requireAuth).
export const protectedHealthRouter: IRouter = Router();
protectedHealthRouter.get("/health/providers", async (_req, res) => {
  const rows = await db
    .select({ health: providerHealthTable, provider: llmProvidersTable })
    .from(providerHealthTable)
    .leftJoin(llmProvidersTable, eq(providerHealthTable.provider_id, llmProvidersTable.id));

  const result = rows.map(({ health, provider }) => ({
    id: health.id,
    provider_id: health.provider_id,
    provider_name: provider?.name || "Unknown",
    status: health.status,
    failure_count: health.failure_count,
    last_failure: health.last_failure,
    last_success: health.last_success,
    avg_latency_ms: health.avg_latency_ms,
  }));

  res.json(result);
});

export default publicHealthRouter;
