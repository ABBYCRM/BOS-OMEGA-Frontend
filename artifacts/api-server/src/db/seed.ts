import { db } from "@workspace/db";
import {
  llmProvidersTable,
  llmModelsTable,
  providerHealthTable,
  memoryItemsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
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
    { id: "prov_xai",  name: "xAI (Grok)",         base_url: "https://api.x.ai/v1",          priority: 6, api_key_env: "XAI_API_KEY"  },
    { id: "prov_kimi", name: "Kimi (Moonshot AI)", base_url: "https://api.moonshot.cn/v1", priority: 7, api_key_env: "KIMI_API_KEY" },
    // NVIDIA NIM — 11 parallel slots (one key each) for fan-out across all execution modes.
    // Names reflect the actual model assigned to each slot (2026-08-08
    // rebrand after the operator supplied 10 keys). 11th slot keeps its
    // "Ultra 253B" assignment but stays disabled until a key is added.
    { id: "prov_nvidia_1",  name: "NVIDIA NIM [1] — Llama 3.3 70B",              base_url: "https://integrate.api.nvidia.com/v1", priority: 8,  api_key_env: "NVIDIA_API_KEY_1"  },
    { id: "prov_nvidia_2",  name: "NVIDIA NIM [2] — Nemotron 4 340B",            base_url: "https://integrate.api.nvidia.com/v1", priority: 9,  api_key_env: "NVIDIA_API_KEY_2"  },
    { id: "prov_nvidia_3",  name: "NVIDIA NIM [3] — GPT-OSS 120B",               base_url: "https://integrate.api.nvidia.com/v1", priority: 10, api_key_env: "NVIDIA_API_KEY_3"  },
    { id: "prov_nvidia_4",  name: "NVIDIA NIM [4] — Nemotron Super 49B v1.5",    base_url: "https://integrate.api.nvidia.com/v1", priority: 11, api_key_env: "NVIDIA_API_KEY_4"  },
    { id: "prov_nvidia_5",  name: "NVIDIA NIM [5] — DeepSeek V4 Flash",          base_url: "https://integrate.api.nvidia.com/v1", priority: 12, api_key_env: "NVIDIA_API_KEY_5"  },
    { id: "prov_nvidia_6",  name: "NVIDIA NIM [6] — Codestral 22B",              base_url: "https://integrate.api.nvidia.com/v1", priority: 13, api_key_env: "NVIDIA_API_KEY_6"  },
    { id: "prov_nvidia_7",  name: "NVIDIA NIM [7] — Kimi K2.6",                  base_url: "https://integrate.api.nvidia.com/v1", priority: 14, api_key_env: "NVIDIA_API_KEY_7"  },
    { id: "prov_nvidia_8",  name: "NVIDIA NIM [8] — Llama 3.2 90B Vision",       base_url: "https://integrate.api.nvidia.com/v1", priority: 15, api_key_env: "NVIDIA_API_KEY_8"  },
    { id: "prov_nvidia_9",  name: "NVIDIA NIM [9] — Palmyra Creative 122B",      base_url: "https://integrate.api.nvidia.com/v1", priority: 16, api_key_env: "NVIDIA_API_KEY_9"  },
    { id: "prov_nvidia_10", name: "NVIDIA NIM [10] — Nemotron Nano 3 30B",       base_url: "https://integrate.api.nvidia.com/v1", priority: 17, api_key_env: "NVIDIA_API_KEY_10" },
    { id: "prov_nvidia_11", name: "NVIDIA NIM [11] — Nemotron Ultra 253B (no key yet)", base_url: "https://integrate.api.nvidia.com/v1", priority: 18, api_key_env: "NVIDIA_API_KEY_11" },
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
    // Kimi / Moonshot AI — OpenAI-compatible endpoint at https://api.moonshot.cn/v1
    { id: "mdl_kimi_8k",   provider_id: "prov_kimi", model_name: "moonshot-v1-8k",   tags: ["fast", "cheap", "coding", "structured_output"],                  context: 8000,   cost_in: 0.0012, cost_out: 0.0012, rel: 0.89, lat: 0.92 },
    { id: "mdl_kimi_32k",  provider_id: "prov_kimi", model_name: "moonshot-v1-32k",  tags: ["reasoning", "coding", "long_context", "structured_output"],      context: 32000,  cost_in: 0.0024, cost_out: 0.0024, rel: 0.91, lat: 0.87 },
    { id: "mdl_kimi_128k", provider_id: "prov_kimi", model_name: "moonshot-v1-128k", tags: ["reasoning", "long_context", "research", "structured_output"],    context: 128000, cost_in: 0.006,  cost_out: 0.006,  rel: 0.92, lat: 0.82 },
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

/**
 * Run on every boot. Idempotently upserts the canonical 18-node LLM
 * provider matrix so a live install that pre-dates a new node (e.g.
 * Bitdeer) picks it up the next time the api-server starts. Existing
 * rows are NOT modified — only missing rows are added.
 *
 * This intentionally lives outside `seed()` (which early-returns when
 * any provider exists) so it can run on every boot against an
 * already-populated DB.
 */
export async function ensureProviderMatrix(): Promise<void> {
  const expected: Array<{
    id: string;
    name: string;
    base_url: string | null;
    priority: number;
    api_key_env: string | null;
  }> = [
    { id: "prov_openai",    name: "OpenAI",                  base_url: "https://api.openai.com/v1",                    priority: 1,  api_key_env: "OPENAI_API_KEY" },
    { id: "prov_anthropic", name: "Anthropic",               base_url: "https://api.anthropic.com",                    priority: 2,  api_key_env: "ANTHROPIC_API_KEY" },
    { id: "prov_gemini",    name: "Gemini",                  base_url: "https://generativelanguage.googleapis.com",     priority: 3,  api_key_env: "GEMINI_API_KEY" },
    { id: "prov_ollama",    name: "Ollama",                  base_url: "http://localhost:11434",                       priority: 4,  api_key_env: null },
    { id: "prov_generic",   name: "Generic API",             base_url: null,                                          priority: 5,  api_key_env: "GENERIC_API_KEY" },
    { id: "prov_xai",       name: "xAI (Grok)",              base_url: "https://api.x.ai/v1",                          priority: 6,  api_key_env: "XAI_API_KEY" },
    { id: "prov_kimi",      name: "Kimi (Moonshot AI)",      base_url: "https://api.moonshot.cn/v1",                   priority: 7,  api_key_env: "KIMI_API_KEY" },
    { id: "prov_bitdeer",   name: "Bitdeer",                 base_url: "https://api.bitdeer.com/v1",                   priority: 8,  api_key_env: "BITDEER_API_KEY" },
    { id: "prov_nvidia_1",  name: "NVIDIA NIM [1] — Llama 3.3 70B",              base_url: "https://integrate.api.nvidia.com/v1", priority: 9,  api_key_env: "NVIDIA_API_KEY_1"  },
    { id: "prov_nvidia_2",  name: "NVIDIA NIM [2] — Nemotron 4 340B",            base_url: "https://integrate.api.nvidia.com/v1", priority: 10, api_key_env: "NVIDIA_API_KEY_2"  },
    { id: "prov_nvidia_3",  name: "NVIDIA NIM [3] — GPT-OSS 120B",               base_url: "https://integrate.api.nvidia.com/v1", priority: 11, api_key_env: "NVIDIA_API_KEY_3"  },
    { id: "prov_nvidia_4",  name: "NVIDIA NIM [4] — Nemotron Super 49B v1.5",    base_url: "https://integrate.api.nvidia.com/v1", priority: 12, api_key_env: "NVIDIA_API_KEY_4"  },
    { id: "prov_nvidia_5",  name: "NVIDIA NIM [5] — DeepSeek V4 Flash",          base_url: "https://integrate.api.nvidia.com/v1", priority: 13, api_key_env: "NVIDIA_API_KEY_5"  },
    { id: "prov_nvidia_6",  name: "NVIDIA NIM [6] — Codestral 22B",              base_url: "https://integrate.api.nvidia.com/v1", priority: 14, api_key_env: "NVIDIA_API_KEY_6"  },
    { id: "prov_nvidia_7",  name: "NVIDIA NIM [7] — Kimi K2.6",                  base_url: "https://integrate.api.nvidia.com/v1", priority: 15, api_key_env: "NVIDIA_API_KEY_7"  },
    { id: "prov_nvidia_8",  name: "NVIDIA NIM [8] — Llama 3.2 90B Vision",       base_url: "https://integrate.api.nvidia.com/v1", priority: 16, api_key_env: "NVIDIA_API_KEY_8"  },
    { id: "prov_nvidia_9",  name: "NVIDIA NIM [9] — Palmyra Creative 122B",      base_url: "https://integrate.api.nvidia.com/v1", priority: 17, api_key_env: "NVIDIA_API_KEY_9"  },
    { id: "prov_nvidia_10", name: "NVIDIA NIM [10] — Nemotron Nano 3 30B",       base_url: "https://integrate.api.nvidia.com/v1", priority: 18, api_key_env: "NVIDIA_API_KEY_10" },
    { id: "prov_nvidia_11", name: "NVIDIA NIM [11] — Nemotron Ultra 253B (no key yet)", base_url: "https://integrate.api.nvidia.com/v1", priority: 19, api_key_env: "NVIDIA_API_KEY_11" },
  ];

  // Per-id name overrides for installs that pre-date the 2026-08-08 rebrand.
  // If a row exists with an old name, update only the name field — leave the
  // operator's keys / status / priority / last_test_* alone.
  const RENAME = new Map<string, string>([
    ["prov_nvidia_1",  "NVIDIA NIM [1] — Llama 3.3 70B"],
    ["prov_nvidia_2",  "NVIDIA NIM [2] — Nemotron 4 340B"],
    ["prov_nvidia_3",  "NVIDIA NIM [3] — GPT-OSS 120B"],
    ["prov_nvidia_4",  "NVIDIA NIM [4] — Nemotron Super 49B v1.5"],
    ["prov_nvidia_5",  "NVIDIA NIM [5] — DeepSeek V4 Flash"],
    ["prov_nvidia_6",  "NVIDIA NIM [6] — Codestral 22B"],
    ["prov_nvidia_7",  "NVIDIA NIM [7] — Kimi K2.6"],
    ["prov_nvidia_8",  "NVIDIA NIM [8] — Llama 3.2 90B Vision"],
    ["prov_nvidia_9",  "NVIDIA NIM [9] — Palmyra Creative 122B"],
    ["prov_nvidia_10", "NVIDIA NIM [10] — Nemotron Nano 3 30B"],
    ["prov_nvidia_11", "NVIDIA NIM [11] — Nemotron Ultra 253B (no key yet)"],
  ]);
  const existing = await db.select({ id: llmProvidersTable.id, name: llmProvidersTable.name }).from(llmProvidersTable);
  const have = new Set(existing.map((r) => r.id));
  let added = 0;
  let renamed = 0;
  for (const p of expected) {
    if (have.has(p.id)) {
      // Rebrand existing rows whose name changed
      const wanted = RENAME.get(p.id);
      if (wanted) {
        const cur = existing.find((r) => r.id === p.id);
        if (cur && cur.name !== wanted) {
          await db.update(llmProvidersTable)
            .set({ name: wanted, updated_at: new Date() })
            .where(eq(llmProvidersTable.id, p.id));
          renamed++;
        }
      }
      continue;
    }
    await db.insert(llmProvidersTable).values({
      id: p.id,
      name: p.name,
      base_url: p.base_url,
      priority: p.priority,
      api_key_env: p.api_key_env,
      status: "HEALTHY",
      enabled: true,
    });
    try {
      await db.insert(providerHealthTable).values({
        id: `ph_${p.id}`,
        provider_id: p.id,
        status: "HEALTHY",
        failure_count: 0,
        schema_failure_count: 0,
      });
    } catch {
      // ignore — health row is best-effort
    }
    added++;
  }
  if (added > 0) {
    logger.info({ added }, "ensureProviderMatrix added missing nodes to the LLM provider matrix");
  }
  if (renamed > 0) {
    logger.info({ renamed }, "ensureProviderMatrix renamed NIM slots to current models");
  }
}
