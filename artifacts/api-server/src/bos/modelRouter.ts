import { db } from "@workspace/db";
import { llmModelsTable, llmProvidersTable, providerHealthTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import type { TaskType, ModelScore, ExecutionMode } from "./types.js";
import { logger } from "../lib/logger.js";

const TASK_CAPABILITY_MATRIX: Record<string, string[]> = {
  legal: ["reasoning", "legal", "long_context"],
  code: ["coding", "reasoning", "structured_output"],
  math: ["reasoning", "structured_output"],
  research: ["research", "long_context", "reasoning"],
  summarization: ["cheap", "fast", "long_context"],
  extraction: ["structured_output", "fast"],
  planning: ["reasoning", "structured_output"],
  creative: ["fast", "cheap"],
  safety_review: ["safety", "reasoning"],
  general: ["reasoning", "fast"],
};

export async function selectModel(
  task_type: TaskType | string,
  input_length: number,
  mode: ExecutionMode = "single",
  count: number = 1
): Promise<ModelScore[]> {
  const required_caps = TASK_CAPABILITY_MATRIX[task_type] || TASK_CAPABILITY_MATRIX["general"];

  const models = await db
    .select({
      model: llmModelsTable,
      provider: llmProvidersTable,
      health: providerHealthTable,
    })
    .from(llmModelsTable)
    .innerJoin(llmProvidersTable, eq(llmModelsTable.provider_id, llmProvidersTable.id))
    .leftJoin(providerHealthTable, eq(llmProvidersTable.id, providerHealthTable.provider_id))
    .where(
      and(
        eq(llmModelsTable.enabled, true),
        eq(llmProvidersTable.enabled, true)
      )
    );

  const scores: ModelScore[] = [];

  for (const row of models) {
    const { model, provider, health } = row;

    if (health?.status === "OPEN_CIRCUIT") continue;

    const capability_match = computeCapabilityMatch(model.capability_tags, required_caps);
    const reliability_score = model.reliability_score;
    const context_fit = computeContextFit(model.context_window, input_length);
    const latency_score = model.latency_score;
    const cost_score = computeCostScore(model.cost_input, model.cost_output);
    const provider_health_score = computeHealthScore(health?.status ?? "HEALTHY", health?.avg_latency_ms ?? 0);

    const score =
      capability_match * 3.0 +
      reliability_score * 2.0 +
      context_fit * 1.5 +
      latency_score * 1.0 +
      cost_score * 0.5 +
      provider_health_score * 2.0;

    scores.push({
      model_id: model.id,
      provider_id: provider.id,
      provider_name: provider.name,
      model_name: model.model_name,
      score,
      capability_match,
      reliability_score,
      context_fit,
      latency_score,
      cost_score,
      provider_health_score,
    });
  }

  scores.sort((a, b) => b.score - a.score);

  if (scores.length === 0) {
    logger.warn({ task_type }, "No models available for routing");
  }

  return scores.slice(0, count);
}

function computeCapabilityMatch(model_caps: string[], required_caps: string[]): number {
  if (required_caps.length === 0) return 0.5;
  const matched = required_caps.filter((cap) => model_caps.includes(cap)).length;
  return matched / required_caps.length;
}

function computeContextFit(context_window: number, input_length: number): number {
  const estimated_tokens = Math.ceil(input_length / 4);
  if (estimated_tokens > context_window * 0.9) return 0;
  if (estimated_tokens > context_window * 0.7) return 0.5;
  return 1.0;
}

function computeCostScore(cost_input: number, cost_output: number): number {
  const total_cost = cost_input + cost_output;
  if (total_cost === 0) return 1.0;
  if (total_cost < 0.001) return 0.9;
  if (total_cost < 0.01) return 0.7;
  if (total_cost < 0.1) return 0.4;
  return 0.1;
}

function computeHealthScore(status: string, avg_latency: number): number {
  let base = 1.0;
  if (status === "DEGRADED") base = 0.5;
  else if (status === "RECOVERY_TEST") base = 0.3;
  else if (status === "OPEN_CIRCUIT") return 0;

  if (avg_latency > 5000) base *= 0.5;
  else if (avg_latency > 2000) base *= 0.8;

  return base;
}
