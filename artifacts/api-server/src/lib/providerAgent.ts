import { logger } from "./logger.js";
import { safeFetch, SsrfBlockedError } from "./security/safeFetch.js";

/**
 * Agentic provider helpers — autonomously test API keys and discover models
 * directly from each provider's catalog.
 */

export type TestResult = {
  ok: boolean;
  status_code?: number;
  message: string;
  detected_provider?: string;
};

export type DiscoveredModel = {
  id: string;
  context_window?: number;
};

export type DiscoveryOutcome =
  | { ok: true; models: DiscoveredModel[] }
  | { ok: false; message: string };

export async function testProviderKey(provider_name: string, api_key: string, base_url?: string): Promise<TestResult> {
  const n = provider_name.toLowerCase();
  try {
    if (n === "openai") return await testOpenAI(api_key);
    if (n === "anthropic") return await testAnthropic(api_key);
    if (n === "gemini" || n === "google gemini") return await testGemini(api_key);
    if (n === "ollama") return await testOllama(base_url || "http://localhost:11434");
    // xAI: /v1/api-key is the dedicated self-introspection endpoint — it's
    // authenticated, returns the key owner without spending tokens, and works
    // the same whether you supply it as `xai-...` or a Bearer token.
    if (n === "xai (grok)" || n === "xai" || n === "grok") return await testXai(api_key);
    // Kimi / Moonshot: OpenAI-compatible /v1/models endpoint. Their
    // /v1/models can take 15-25s to respond (large model catalog), so
    // we give the test a wider timeout than the default 10s.
    if (n === "kimi (moonshot ai)" || n === "kimi" || n === "moonshot") {
      return await testGenericOpenAI("https://api.moonshot.cn/v1", api_key, 30000);
    }
    // Bitdeer AI: their /v1/models endpoint is even slower (sometimes
    // 30+ seconds), so we go to 45s to avoid false negatives.
    if (n === "bitdeer") return await testGenericOpenAI("https://api.bitdeer.com/v1", api_key, 45000);
    // NVIDIA NIM: OpenAI-compatible /v1/models endpoint.
    if (n.startsWith("nvidia nim")) {
      return await testGenericOpenAI("https://integrate.api.nvidia.com/v1", api_key, 30000);
    }
    if (base_url) return await testGenericOpenAI(base_url, api_key);
    return { ok: false, message: "Unknown provider — provide a base_url for generic OpenAI-compatible servers" };
  } catch (err) {
    logger.error({ err, provider_name }, "Provider key test failed");
    return { ok: false, message: (err as Error).message };
  }
}

export async function discoverModels(provider_name: string, api_key: string, base_url?: string): Promise<DiscoveryOutcome> {
  const n = provider_name.toLowerCase();
  try {
    if (n === "openai") return { ok: true, models: await listOpenAIModels(api_key) };
    if (n === "anthropic") return { ok: true, models: ANTHROPIC_KNOWN_MODELS };
    if (n === "gemini" || n === "google gemini") return { ok: true, models: await listGeminiModels(api_key) };
    if (n === "ollama") return { ok: true, models: await listOllamaModels(base_url || "http://localhost:11434") };
    if (base_url) return { ok: true, models: await listOpenAICompatibleModels(base_url, api_key) };
    return { ok: false, message: "Unknown provider — provide a base_url for generic OpenAI-compatible servers" };
  } catch (err) {
    logger.error({ err, provider_name }, "Model discovery failed");
    return { ok: false, message: (err as Error).message };
  }
}

// ---------- OpenAI ----------
async function testOpenAI(api_key: string): Promise<TestResult> {
  const r = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${api_key}` },
    signal: AbortSignal.timeout(10000),
  });
  if (r.status === 200) return { ok: true, status_code: 200, message: "Authenticated with OpenAI", detected_provider: "OpenAI" };
  if (r.status === 401) return { ok: false, status_code: 401, message: "Invalid OpenAI API key" };
  return { ok: false, status_code: r.status, message: `OpenAI returned HTTP ${r.status}` };
}

// ---------- xAI (Grok) ----------
// Uses the dedicated /v1/api-key self-introspection endpoint — it's
// authenticated, returns the key owner without spending tokens, and
// proves the credential is valid + unblocked.
async function testXai(api_key: string): Promise<TestResult> {
  const r = await fetch("https://api.x.ai/v1/api-key", {
    headers: { Authorization: `Bearer ${api_key}` },
    signal: AbortSignal.timeout(10000),
  });
  if (r.status === 200) return { ok: true, status_code: 200, message: "Authenticated with xAI", detected_provider: "xAI (Grok)" };
  if (r.status === 401 || r.status === 403) return { ok: false, status_code: r.status, message: "Invalid or blocked xAI key" };
  return { ok: false, status_code: r.status, message: `xAI returned HTTP ${r.status}` };
}

async function listOpenAIModels(api_key: string): Promise<DiscoveredModel[]> {
  const r = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${api_key}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`OpenAI list models returned HTTP ${r.status}`);
  const data = await r.json() as { data?: Array<{ id: string }> };
  const models = (data.data || [])
    .map((m) => m.id)
    .filter((id) => /^gpt-|^o1|^chatgpt-/.test(id))
    .filter((id) => !/realtime|audio|tts|whisper|embedding|dall|moderation/i.test(id));
  return models.map((id) => ({ id, context_window: defaultContextWindow(id) }));
}

// ---------- Anthropic ----------
async function testAnthropic(api_key: string): Promise<TestResult> {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": api_key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (r.status === 200) {
    return { ok: true, status_code: 200, message: "Authenticated with Anthropic", detected_provider: "Anthropic" };
  }
  if (r.status === 401 || r.status === 403) {
    return { ok: false, status_code: r.status, message: "Invalid Anthropic API key" };
  }
  // 400 = malformed request, but auth is what we care about — distinguish via response body
  if (r.status === 400) {
    try {
      const body = await r.json() as { error?: { type?: string; message?: string } };
      const errType = body?.error?.type || "";
      if (errType === "authentication_error" || errType === "permission_error") {
        return { ok: false, status_code: 400, message: body.error?.message || "Invalid Anthropic API key" };
      }
      // Auth succeeded; only the test payload was rejected (e.g. unknown model). Treat as authenticated.
      return { ok: true, status_code: 400, message: "Authenticated with Anthropic", detected_provider: "Anthropic" };
    } catch {
      return { ok: false, status_code: 400, message: "Anthropic returned HTTP 400 (could not parse body)" };
    }
  }
  return { ok: false, status_code: r.status, message: `Anthropic returned HTTP ${r.status}` };
}

// Replit AI Integrations Anthropic proxy supported models (per
// .local/skills/ai-integrations-anthropic/SKILL.md). The vendor 3.x IDs
// continue to work for users who supply their own direct Anthropic keys, but
// these are the canonical IDs surfaced in the "Discover models" UI.
const ANTHROPIC_KNOWN_MODELS: DiscoveredModel[] = [
  { id: "claude-opus-4-7", context_window: 200000 },
  { id: "claude-sonnet-4-6", context_window: 200000 },
  { id: "claude-haiku-4-5", context_window: 200000 },
];

// ---------- Gemini ----------
async function testGemini(api_key: string): Promise<TestResult> {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${api_key}`, {
    signal: AbortSignal.timeout(10000),
  });
  if (r.status === 200) return { ok: true, status_code: 200, message: "Authenticated with Google Gemini", detected_provider: "Google Gemini" };
  if (r.status === 400 || r.status === 401 || r.status === 403) {
    return { ok: false, status_code: r.status, message: "Invalid Gemini API key" };
  }
  return { ok: false, status_code: r.status, message: `Gemini returned HTTP ${r.status}` };
}

async function listGeminiModels(api_key: string): Promise<DiscoveredModel[]> {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${api_key}`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`Gemini list models returned HTTP ${r.status}`);
  const data = await r.json() as { models?: Array<{ name: string; supportedGenerationMethods?: string[]; inputTokenLimit?: number }> };
  return (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => ({ id: m.name.replace(/^models\//, ""), context_window: m.inputTokenLimit }));
}

// ---------- Ollama ----------
// Ollama legitimately runs on localhost. We allow loopback here only.
async function testOllama(base_url: string): Promise<TestResult> {
  try {
    const r = await safeFetch(`${base_url}/api/tags`, { allowLocalhost: true, timeoutMs: 5000 });
    if (r.status === 200) return { ok: true, status_code: 200, message: "Connected to Ollama", detected_provider: "Ollama" };
    return { ok: false, status_code: r.status, message: `Ollama not reachable at ${base_url}` };
  } catch (err) {
    if (err instanceof SsrfBlockedError) return { ok: false, message: `Blocked by SSRF guard: ${err.message}` };
    throw err;
  }
}

async function listOllamaModels(base_url: string): Promise<DiscoveredModel[]> {
  const r = await safeFetch(`${base_url}/api/tags`, { allowLocalhost: true, timeoutMs: 10000 });
  if (!r.ok) throw new Error(`Ollama list models returned HTTP ${r.status}`);
  const data = await r.json() as { models?: Array<{ name: string }> };
  return (data.models || []).map((m) => ({ id: m.name }));
}

// ---------- Generic OpenAI-compatible ----------
// User-supplied base_url. SSRF guard is mandatory; localhost is NOT allowed
// for arbitrary providers (Ollama has its own dedicated path above).
async function testGenericOpenAI(base_url: string, api_key: string, timeoutMs: number = 10000): Promise<TestResult> {
  const url = base_url.replace(/\/$/, "") + "/models";
  try {
    const r = await safeFetch(url, {
      headers: { Authorization: `Bearer ${api_key}` },
      timeoutMs,
    });
    if (r.status === 200) return { ok: true, status_code: 200, message: "Authenticated", detected_provider: "OpenAI-compatible" };
    if (r.status === 401) return { ok: false, status_code: 401, message: "Invalid API key" };
    return { ok: false, status_code: r.status, message: `Provider returned HTTP ${r.status}` };
  } catch (err) {
    if (err instanceof SsrfBlockedError) return { ok: false, message: `Blocked by SSRF guard: ${err.message}` };
    throw err;
  }
}

async function listOpenAICompatibleModels(base_url: string, api_key: string): Promise<DiscoveredModel[]> {
  const url = base_url.replace(/\/$/, "") + "/models";
  const r = await safeFetch(url, {
    headers: { Authorization: `Bearer ${api_key}` },
    timeoutMs: 15000,
  });
  if (!r.ok) throw new Error(`Provider list models returned HTTP ${r.status}`);
  const data = await r.json() as { data?: Array<{ id: string }> };
  return (data.data || []).map((m) => ({ id: m.id }));
}

function defaultContextWindow(model_id: string): number {
  if (model_id.includes("o1")) return 128000;
  if (model_id.includes("gpt-4o")) return 128000;
  if (model_id.includes("gpt-4-turbo")) return 128000;
  if (model_id.includes("gpt-4")) return 8192;
  if (model_id.includes("gpt-3.5")) return 16385;
  return 8192;
}
