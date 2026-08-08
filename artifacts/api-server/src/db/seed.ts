import { db } from "@workspace/db";
import {
  llmProvidersTable,
  llmModelsTable,
  providerHealthTable,
  memoryItemsTable,
} from "@workspace/db";
import { randomUUID } from "crypto";
import { logger } from "../lib/logger.js";

export async function seed() {
  const existing = await db.select().from(llmProvidersTable).limit(1);
  if (existing.length > 0) {
    logger.info("Seed data already exists, skipping");
    return;
  }

  logger.info("Seeding BOS-OMEGA providers and models...");

  const providers = [
    { id: "prov_openai", name: "OpenAI", base_url: "https://api.openai.com/v1", priority: 1, api_key_env: "OPENAI_API_KEY" },
    { id: "prov_anthropic", name: "Anthropic", base_url: "https://api.anthropic.com", priority: 2, api_key_env: "ANTHROPIC_API_KEY" },
    { id: "prov_gemini", name: "Gemini", base_url: "https://generativelanguage.googleapis.com", priority: 3, api_key_env: "GEMINI_API_KEY" },
    { id: "prov_ollama", name: "Ollama", base_url: "http://localhost:11434", priority: 4, api_key_env: null },
    { id: "prov_generic", name: "Generic API", base_url: null, priority: 5, api_key_env: "GENERIC_API_KEY" },
    { id: "prov_xai", name: "xAI (Grok)", base_url: "https://api.x.ai/v1", priority: 6, api_key_env: "XAI_API_KEY" },
  ];

  for (const p of providers) {
    await db.insert(llmProvidersTable).values({
      id: p.id,
      name: p.name,
      base_url: p.base_url,
      priority: p.priority,
      api_key_env: p.api_key_env,
      status: "HEALTHY",
      enabled: true,
    });

    await db.insert(providerHealthTable).values({
      id: `ph_${p.id}`,
      provider_id: p.id,
      status: "HEALTHY",
      failure_count: 0,
      schema_failure_count: 0,
    });
  }

  const models = [
    { id: "mdl_gpt4o", provider_id: "prov_openai", model_name: "gpt-4o", tags: ["reasoning", "coding", "long_context", "structured_output", "multimodal"], context: 128000, cost_in: 0.0025, cost_out: 0.01, rel: 0.97, lat: 0.85 },
    { id: "mdl_gpt4o_mini", provider_id: "prov_openai", model_name: "gpt-4o-mini", tags: ["reasoning", "coding", "fast", "cheap", "structured_output", "multimodal"], context: 128000, cost_in: 0.00015, cost_out: 0.0006, rel: 0.95, lat: 0.95 },
    { id: "mdl_gpt35", provider_id: "prov_openai", model_name: "gpt-3.5-turbo", tags: ["fast", "cheap", "structured_output"], context: 16385, cost_in: 0.0005, cost_out: 0.0015, rel: 0.92, lat: 0.98 },
    { id: "mdl_claude35s", provider_id: "prov_anthropic", model_name: "claude-sonnet-4-6", tags: ["reasoning", "coding", "long_context", "safety", "legal", "multimodal"], context: 200000, cost_in: 0.003, cost_out: 0.015, rel: 0.96, lat: 0.82 },
    { id: "mdl_claude35h", provider_id: "prov_anthropic", model_name: "claude-haiku-4-5", tags: ["fast", "cheap", "coding", "structured_output", "multimodal"], context: 200000, cost_in: 0.001, cost_out: 0.005, rel: 0.94, lat: 0.93 },
    { id: "mdl_claude3o", provider_id: "prov_anthropic", model_name: "claude-opus-4-7", tags: ["reasoning", "legal", "research", "long_context", "safety", "multimodal"], context: 200000, cost_in: 0.015, cost_out: 0.075, rel: 0.95, lat: 0.7 },
    { id: "mdl_gemini15p", provider_id: "prov_gemini", model_name: "gemini-2.5-pro", tags: ["reasoning", "long_context", "multimodal", "research"], context: 2000000, cost_in: 0.00125, cost_out: 0.005, rel: 0.93, lat: 0.78 },
    { id: "mdl_gemini15f", provider_id: "prov_gemini", model_name: "gemini-2.5-flash", tags: ["fast", "cheap", "structured_output", "multimodal"], context: 1000000, cost_in: 0.000075, cost_out: 0.0003, rel: 0.90, lat: 0.95 },
    { id: "mdl_llama3", provider_id: "prov_ollama", model_name: "llama3", tags: ["local_private", "reasoning", "cheap"], context: 8192, cost_in: 0, cost_out: 0, rel: 0.85, lat: 0.75 },
    { id: "mdl_mistral", provider_id: "prov_ollama", model_name: "mistral", tags: ["local_private", "fast", "cheap", "coding"], context: 32768, cost_in: 0, cost_out: 0, rel: 0.83, lat: 0.8 },
    // xAI (Grok) — OpenAI-compatible endpoint at https://api.x.ai/v1
    { id: "mdl_grok2",        provider_id: "prov_xai", model_name: "grok-2-1212",        tags: ["reasoning", "coding", "long_context", "structured_output"], context: 131072, cost_in: 0.002,  cost_out: 0.01,   rel: 0.93, lat: 0.82 },
    { id: "mdl_grok2_vision", provider_id: "prov_xai", model_name: "grok-2-vision-1212", tags: ["reasoning", "multimodal", "long_context"],                  context: 32768,  cost_in: 0.002,  cost_out: 0.01,   rel: 0.92, lat: 0.80 },
    { id: "mdl_grok3",        provider_id: "prov_xai", model_name: "grok-3",             tags: ["reasoning", "coding", "research", "structured_output"],      context: 131072, cost_in: 0.003,  cost_out: 0.015,  rel: 0.94, lat: 0.78 },
    { id: "mdl_grok3_mini",   provider_id: "prov_xai", model_name: "grok-3-mini",        tags: ["fast", "cheap", "coding", "structured_output"],              context: 131072, cost_in: 0.0003, cost_out: 0.0005, rel: 0.90, lat: 0.93 },
    { id: "mdl_grok_beta",    provider_id: "prov_xai", model_name: "grok-beta",          tags: ["reasoning", "coding", "structured_output"],                  context: 131072, cost_in: 0.005,  cost_out: 0.015,  rel: 0.91, lat: 0.79 },
  ];

  for (const m of models) {
    await db.insert(llmModelsTable).values({
      id: m.id,
      provider_id: m.provider_id,
      model_name: m.model_name,
      capability_tags: m.tags,
      context_window: m.context,
      cost_input: m.cost_in,
      cost_output: m.cost_out,
      reliability_score: m.rel,
      latency_score: m.lat,
      enabled: true,
    });
  }

  await db.insert(memoryItemsTable).values([
    {
      id: randomUUID(),
      layer: "canon",
      title: "BOS-OMEGA Operational Policy",
      content: "BOS-OMEGA is a governed multi-LLM orchestration runtime. Software controls routing, validation, fallback, memory, audit, and final release. LLMs execute assigned work only. Never invent facts. Always separate facts from assumptions.",
      authority_level: 10,
    },
    {
      id: randomUUID(),
      layer: "canon",
      title: "Safety Rules",
      content: "ABORT any request that is unsafe, illegal, or policy-violating. Do not assist with malware, unauthorized access, or harmful content. Validate all outputs before release.",
      authority_level: 10,
    },
    {
      id: randomUUID(),
      layer: "scratchpad",
      title: "System Initialized",
      content: "BOS-OMEGA runtime initialized. All providers seeded. Circuit breakers in HEALTHY state.",
      authority_level: 1,
    },
  ]);

  logger.info("Seed complete: 5 providers, 10 models, 3 memory items");
}
