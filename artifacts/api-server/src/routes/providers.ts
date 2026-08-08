import { Router } from "express";
import { db } from "@workspace/db";
import { llmProvidersTable, providerHealthTable, llmModelsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { randomUUID } from "crypto";
import { CreateProviderBody, UpdateProviderBody } from "@workspace/api-zod";
import { z } from "zod";

const ApiKeyBody = z.object({
  api_key: z.string().min(4).max(2048),
});
import { encryptSecret, decryptSecret, maskKey } from "../lib/secrets.js";
import { resolveProviderKey } from "../lib/keyResolver.js";
import { testProviderKey, discoverModels } from "../lib/providerAgent.js";
import { auditLog } from "../bos/auditEngine.js";
import { logger } from "../lib/logger.js";
import { expensiveLimiter } from "../lib/security/rateLimit.js";
import { requireRole } from "../lib/security/auth.js";

const router = Router();

// Provider configuration is admin-only. The mounting layer in routes/index.ts
// already runs requireAuth, so a self-signed-up `user` lands here with a
// valid session and is rejected at this gate — they cannot read provider
// rows, save the OpenAI API key, or trigger discovery / test calls. Only
// admin and super_admin can configure the LLM backbone.
router.use(requireRole("admin", "super_admin"));

// Strip secrets before returning provider rows. The `has_api_key` flag
// is a UX signal — it tells the operator whether the provider row has a
// usable key. The actual key resolution chain (DB → env var → legacy
// canonical env → AI Integrations proxy) lives in `lib/keyResolver.ts`
// and may succeed even when this flag is `false`. So we check all three
// sources here to give the operator a truthful UI:
//   1. `api_key_encrypted`  — DB column
//   2. `api_key_env`        — env var named in the row
//   3. `canonicalEnvFor()`  — legacy hardcoded env (OpenAI/Anthropic/Gemini)
function hasResolvableKey(p: typeof llmProvidersTable.$inferSelect): boolean {
  if (p.api_key_encrypted) return true;
  if (p.api_key_env && process.env[p.api_key_env]) return true;
  // Legacy canonical fallback (mirrors keyResolver.canonicalEnvFor).
  const n = (p.name || "").toLowerCase();
  if (n === "openai" && process.env["OPENAI_API_KEY"]) return true;
  if (n === "anthropic" && process.env["ANTHROPIC_API_KEY"]) return true;
  if ((n === "gemini" || n === "google gemini") && process.env["GEMINI_API_KEY"]) return true;
  return false;
}

function sanitize(p: typeof llmProvidersTable.$inferSelect) {
  const { api_key_encrypted: _drop, ...safe } = p;
  return { ...safe, has_api_key: hasResolvableKey(p) };
}

router.get("/", async (_req, res) => {
  const providers = await db.select().from(llmProvidersTable).orderBy(llmProvidersTable.priority);
  res.json(providers.map(sanitize));
});

// GET /api/providers/preflight — does this install have at least ONE
// LLM provider with a resolvable key/route? Used by the lattice
// round-trip self-test (and any future E2E test that submits tasks)
// to fail loudly with an actionable hint *before* submitting tasks
// that would otherwise HOLD on `no_provider_available` and surface as
// a confusing audit-count assertion failure many steps later.
//
// Resolution mirrors `resolveProviderKey` exactly (DB → vendor env →
// legacy canonical env → AI Integrations proxy). For Ollama there is
// no key, so we cheaply probe `/api/version` with a 1s timeout — that
// way a freshly seeded DB with `prov_ollama` enabled but no Ollama
// process running does NOT incorrectly pass preflight.
//
// This endpoint must be declared before the `:id`-parameterised
// routes below so Express does not try to interpret "preflight" as a
// provider id. The current router has no `GET /:id` (only PATCH /
// PUT / POST / DELETE on `:id`), but ordering it here keeps that
// guarantee robust under future additions.
router.get("/preflight", async (_req, res) => {
  const providers = await db.select().from(llmProvidersTable);
  const reachable: Array<{ name: string; source: string }> = [];
  for (const p of providers) {
    if (!p.enabled) continue;
    if (p.name.toLowerCase() === "ollama") {
      const ollamaHost = (process.env["OLLAMA_HOST"] || "http://localhost:11434").replace(/\/$/, "");
      try {
        const r = await fetch(`${ollamaHost}/api/version`, {
          signal: AbortSignal.timeout(1000),
        });
        if (r.ok) reachable.push({ name: p.name, source: `ollama_local:${ollamaHost}` });
      } catch (_e) { /* unreachable — skip */ }
      continue;
    }
    const { key, source } = await resolveProviderKey(p.id, p.name);
    if (key) reachable.push({ name: p.name, source });
  }
  if (reachable.length === 0) {
    res.json({
      ok: false,
      reachable: [],
      reason: "no_llm_provider_reachable",
      hint: "No LLM provider is reachable in this env. Either set ANTHROPIC_API_KEY / OPENAI_API_KEY, provision the AI Integration, or configure a provider via Settings.",
    });
    return;
  }
  res.json({ ok: true, reachable });
});

router.post("/", async (req, res) => {
  const parsed = CreateProviderBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", code: "INPUT_ERROR" });
    return;
  }

  const id = randomUUID();
  const [provider] = await db.insert(llmProvidersTable).values({
    id,
    name: parsed.data.name,
    base_url: parsed.data.base_url || null,
    priority: parsed.data.priority ?? 5,
    api_key_env: parsed.data.api_key_env || null,
    status: "HEALTHY",
    enabled: true,
    last_test_status: "NEVER_TESTED",
  }).returning();

  await db.insert(providerHealthTable).values({
    id: `ph_${id}`,
    provider_id: id,
    status: "HEALTHY",
    failure_count: 0,
    schema_failure_count: 0,
  });

  if (!provider) { res.status(500).json({ error: "Failed to create provider" }); return; }
  res.status(201).json(sanitize(provider));
});

router.patch("/:id", async (req, res) => {
  const { id } = req.params;
  if (!id) { res.status(400).json({ error: "Missing id" }); return; }

  const parsed = UpdateProviderBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid request", code: "INPUT_ERROR" }); return; }

  const updates: Record<string, unknown> = { updated_at: new Date() };
  if (parsed.data.status !== undefined) updates["status"] = parsed.data.status;
  if (parsed.data.enabled !== undefined) updates["enabled"] = parsed.data.enabled;
  if (parsed.data.priority !== undefined) updates["priority"] = parsed.data.priority;
  // base_url is now nullable in UpdateProviderBody — explicit null
  // clears the value (used by lattice round-trip teardown to fully
  // restore prov_generic to seed default after pointing it at the
  // inline mock LLM server). undefined leaves the column alone.
  if (parsed.data.base_url !== undefined) updates["base_url"] = parsed.data.base_url;

  const [updated] = await db.update(llmProvidersTable).set(updates).where(eq(llmProvidersTable.id, id)).returning();
  if (!updated) { res.status(404).json({ error: "Provider not found" }); return; }

  if (parsed.data.status) {
    await db.update(providerHealthTable).set({ status: parsed.data.status }).where(eq(providerHealthTable.provider_id, id));
  }

  res.json(sanitize(updated));
});

// ===== Agentic API key management =====

// PUT /api/providers/:id/api-key — paste/update the key (encrypted at rest)
router.put("/:id/api-key", async (req, res) => {
  const { id } = req.params;
  if (!id) { res.status(400).json({ error: "Missing id" }); return; }

  const parsed = ApiKeyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "api_key must be a string of 4-2048 characters", code: "INPUT_ERROR" });
    return;
  }
  const trimmed = parsed.data.api_key.trim();
  const encrypted = encryptSecret(trimmed);
  const hint = maskKey(trimmed);

  const [updated] = await db.update(llmProvidersTable).set({
    api_key_encrypted: encrypted,
    api_key_hint: hint,
    last_test_status: "NEVER_TESTED",
    last_test_message: null,
    last_test_at: null,
    updated_at: new Date(),
  }).where(eq(llmProvidersTable.id, id)).returning();

  if (!updated) { res.status(404).json({ error: "Provider not found" }); return; }
  await auditLog(`provider:${id}`, "PROVIDER_KEY_UPDATED", `API key set for ${updated.name}`, { hint });
  res.json(sanitize(updated));
});

// DELETE /api/providers/:id/api-key — clear the stored key (falls back to env)
router.delete("/:id/api-key", async (req, res) => {
  const { id } = req.params;
  if (!id) { res.status(400).json({ error: "Missing id" }); return; }

  const [updated] = await db.update(llmProvidersTable).set({
    api_key_encrypted: null,
    api_key_hint: null,
    last_test_status: "NEVER_TESTED",
    last_test_message: null,
    last_test_at: null,
    updated_at: new Date(),
  }).where(eq(llmProvidersTable.id, id)).returning();

  if (!updated) { res.status(404).json({ error: "Provider not found" }); return; }
  await auditLog(`provider:${id}`, "PROVIDER_KEY_CLEARED", `API key cleared for ${updated.name}`, {});
  res.json(sanitize(updated));
});

// Express 5 widens `req.params.X` to `string | string[]` (proxies that send
// the same key twice put an array there). Our routes only ever consume a single
// id, so coerce to a plain string after the !id non-empty check.
function paramId(raw: string | string[] | undefined): string | null {
  if (!raw) return null;
  return Array.isArray(raw) ? (raw[0] ?? null) : raw;
}

// POST /api/providers/:id/test — agentic key validation against the live provider
router.post("/:id/test", expensiveLimiter, async (req, res) => {
  const id = paramId(req.params["id"]);
  if (!id) { res.status(400).json({ error: "Missing id" }); return; }

  const [provider] = await db.select().from(llmProvidersTable).where(eq(llmProvidersTable.id, id)).limit(1);
  if (!provider) { res.status(404).json({ error: "Provider not found" }); return; }

  const { key } = await resolveProviderKey(id, provider.name);
  if (!key && provider.name.toLowerCase() !== "ollama") {
    res.status(400).json({ ok: false, message: "No API key configured for this provider" });
    return;
  }

  const result = await testProviderKey(provider.name, key, provider.base_url ?? undefined);

  const now = new Date();
  await db.update(llmProvidersTable).set({
    last_test_status: result.ok ? "OK" : "FAILED",
    last_test_message: result.message,
    last_test_at: now,
    status: result.ok ? "HEALTHY" : "DEGRADED",
    updated_at: now,
  }).where(eq(llmProvidersTable.id, id));

  // providerHealthTable does not have a `last_check_at` column. Use the real
  // schema columns: stamp last_success or last_failure depending on outcome
  // (and updated_at fires on every write via defaultNow / our explicit set).
  await db.update(providerHealthTable).set({
    status: result.ok ? "HEALTHY" : "DEGRADED",
    ...(result.ok ? { last_success: now } : { last_failure: now }),
    updated_at: now,
  }).where(eq(providerHealthTable.provider_id, id));

  await auditLog(`provider:${id}`, "PROVIDER_TESTED", `${provider.name}: ${result.ok ? "OK" : "FAILED"}`, {
    status_code: result.status_code, message: result.message,
  });

  res.json(result);
});

// POST /api/providers/:id/discover-models — agentic auto-registration of provider's models
router.post("/:id/discover-models", expensiveLimiter, async (req, res) => {
  const id = paramId(req.params["id"]);
  if (!id) { res.status(400).json({ error: "Missing id" }); return; }

  const [provider] = await db.select().from(llmProvidersTable).where(eq(llmProvidersTable.id, id)).limit(1);
  if (!provider) { res.status(404).json({ error: "Provider not found" }); return; }

  const { key } = await resolveProviderKey(id, provider.name);
  if (!key && provider.name.toLowerCase() !== "ollama") {
    res.status(400).json({ error: "No API key configured" }); return;
  }

  const outcome = await discoverModels(provider.name, key, provider.base_url ?? undefined);
  if (!outcome.ok) {
    await db.update(llmProvidersTable).set({
      last_test_status: "FAILED",
      last_test_message: `Discovery failed: ${outcome.message}`,
      last_test_at: new Date(),
      updated_at: new Date(),
    }).where(eq(llmProvidersTable.id, id));
    await auditLog(`provider:${id}`, "PROVIDER_DISCOVERY_FAILED", `${provider.name}: ${outcome.message}`, {});
    res.status(502).json({ error: "Model discovery failed", message: outcome.message, discovered: 0, newly_registered: 0, models: [] });
    return;
  }
  const discovered = outcome.models;

  // Auto-register any newly discovered models that don't already exist for THIS provider.
  // The model schema uses cost_input/cost_output and a capability_tags[] array
  // — the legacy good_for_* / cost_per_*_token columns no longer exist.
  let registered = 0;
  for (const m of discovered) {
    const [existing] = await db.select().from(llmModelsTable)
      .where(and(
        eq(llmModelsTable.provider_id, id),
        eq(llmModelsTable.model_name, m.id),
      )).limit(1);
    if (existing) continue;
    try {
      const tags: string[] = [];
      if (/code|coder|deepseek|qwen-coder/i.test(m.id)) tags.push("coding");
      if (/sonnet|opus|gpt-4|gemini/i.test(m.id)) tags.push("reasoning");
      if (/opus|o1|sonnet|gpt-4o|gemini-2/i.test(m.id)) tags.push("reasoning");
      if ((m.context_window ?? 0) >= 100000) tags.push("long_context");
      // dedupe — multiple regex hits can push "reasoning" twice
      const capability_tags = Array.from(new Set(tags));

      await db.insert(llmModelsTable).values({
        id: randomUUID(),
        provider_id: id,
        model_name: m.id,
        context_window: m.context_window ?? 8192,
        cost_input: 0,
        cost_output: 0,
        capability_tags,
        enabled: true,
      });
      registered += 1;
    } catch (err) {
      logger.warn({ err, model: m.id }, "Failed to insert discovered model");
    }
  }

  await db.update(llmProvidersTable).set({
    discovered_models_count: discovered.length,
    updated_at: new Date(),
  }).where(eq(llmProvidersTable.id, id));

  await auditLog(`provider:${id}`, "PROVIDER_MODELS_DISCOVERED", `${provider.name}: ${discovered.length} models, ${registered} newly registered`, {});
  res.json({ discovered: discovered.length, newly_registered: registered, models: discovered });
});

// DELETE /api/providers/:id — remove a provider entirely
router.delete("/:id", async (req, res) => {
  const id = paramId(req.params["id"]);
  if (!id) { res.status(400).json({ error: "Missing id" }); return; }

  await db.delete(providerHealthTable).where(eq(providerHealthTable.provider_id, id));
  await db.delete(llmModelsTable).where(eq(llmModelsTable.provider_id, id));
  const [removed] = await db.delete(llmProvidersTable).where(eq(llmProvidersTable.id, id)).returning();
  if (!removed) { res.status(404).json({ error: "Provider not found" }); return; }
  await auditLog(`provider:${id}`, "PROVIDER_REMOVED", `Removed ${removed.name}`, {});
  res.json({ removed: true });
});

// Helper used internally — exported decryptor isn't exposed via HTTP
export async function getProviderKeyForCall(provider_id: string, provider_name: string): Promise<string> {
  const { key } = await resolveProviderKey(provider_id, provider_name);
  return key;
}

// Re-export used for type-narrowing in callers
export { decryptSecret };

export default router;
