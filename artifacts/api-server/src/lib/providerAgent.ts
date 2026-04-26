import { logger } from "./logger.js";

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
      model: "claude-3-5-haiku-20241022",
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

const ANTHROPIC_KNOWN_MODELS: DiscoveredModel[] = [
  { id: "claude-sonnet-4-5", context_window: 200000 },
  { id: "claude-opus-4-1", context_window: 200000 },
  { id: "claude-3-5-sonnet-20241022", context_window: 200000 },
  { id: "claude-3-5-haiku-20241022", context_window: 200000 },
  { id: "claude-3-opus-20240229", context_window: 200000 },
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
async function testOllama(base_url: string): Promise<TestResult> {
  const r = await fetch(`${base_url}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (r.status === 200) return { ok: true, status_code: 200, message: "Connected to Ollama", detected_provider: "Ollama" };
  return { ok: false, status_code: r.status, message: `Ollama not reachable at ${base_url}` };
}

async function listOllamaModels(base_url: string): Promise<DiscoveredModel[]> {
  const r = await fetch(`${base_url}/api/tags`, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`Ollama list models returned HTTP ${r.status}`);
  const data = await r.json() as { models?: Array<{ name: string }> };
  return (data.models || []).map((m) => ({ id: m.name }));
}

// ---------- Generic OpenAI-compatible ----------
async function testGenericOpenAI(base_url: string, api_key: string): Promise<TestResult> {
  const url = base_url.replace(/\/$/, "") + "/models";
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${api_key}` },
    signal: AbortSignal.timeout(10000),
  });
  if (r.status === 200) return { ok: true, status_code: 200, message: "Authenticated", detected_provider: "OpenAI-compatible" };
  if (r.status === 401) return { ok: false, status_code: 401, message: "Invalid API key" };
  return { ok: false, status_code: r.status, message: `Provider returned HTTP ${r.status}` };
}

async function listOpenAICompatibleModels(base_url: string, api_key: string): Promise<DiscoveredModel[]> {
  const url = base_url.replace(/\/$/, "") + "/models";
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${api_key}` },
    signal: AbortSignal.timeout(15000),
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
