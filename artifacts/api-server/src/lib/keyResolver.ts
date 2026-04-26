import { db } from "@workspace/db";
import { llmProvidersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { decryptSecret } from "./secrets.js";

export interface ResolvedKey {
  key: string;
  source: "db" | "env" | "legacy" | "proxy" | "none";
  base_url?: string;
}

/**
 * Resolve the API key for a provider with this priority:
 *   1. DB-stored encrypted key (set via the Settings UI — the agentic path)
 *   2. Environment variable referenced by api_key_env
 *   3. Legacy hardcoded env var by canonical name (OPENAI_API_KEY etc.)
 *   4. Replit AI Integrations proxy (AI_INTEGRATIONS_*_BASE_URL + AI_INTEGRATIONS_*_API_KEY)
 *
 * When `source==="proxy"`, the returned `base_url` MUST be honored by the
 * adapter (instead of the hardcoded vendor URL) and the `key` is the
 * proxy-issued credential, not a vendor key.
 *
 * Returns `{key:""}` when no key is available — caller should switch to mock mode.
 */
export async function resolveProviderKey(
  provider_id: string | undefined,
  provider_name: string,
): Promise<ResolvedKey> {
  if (provider_id) {
    const [row] = await db.select().from(llmProvidersTable).where(eq(llmProvidersTable.id, provider_id)).limit(1);
    if (row?.api_key_encrypted) {
      const key = decryptSecret(row.api_key_encrypted);
      if (key) return { key, source: "db" };
    }
    if (row?.api_key_env) {
      const key = process.env[row.api_key_env];
      if (key) return { key, source: "env" };
    }
  }
  const legacy = canonicalEnvFor(provider_name);
  if (legacy) {
    const key = process.env[legacy];
    if (key) return { key, source: "legacy" };
  }
  const proxy = proxyFor(provider_name);
  if (proxy) return proxy;
  return { key: "", source: "none" };
}

export function canonicalEnvFor(provider_name: string): string | null {
  const n = provider_name.toLowerCase();
  if (n === "openai") return "OPENAI_API_KEY";
  if (n === "anthropic") return "ANTHROPIC_API_KEY";
  if (n === "gemini" || n === "google gemini") return "GEMINI_API_KEY";
  return null;
}

/**
 * Replit AI Integrations proxy fallback. When the workspace has provisioned
 * the integration, both an API key and a base URL are set as env vars and
 * we route through them — no vendor key required and charges go to Replit
 * credits.
 */
export function proxyFor(provider_name: string): ResolvedKey | null {
  const n = provider_name.toLowerCase();
  if (n === "openai") {
    const key = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
    const base_url = process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"];
    if (key && base_url) return { key, source: "proxy", base_url };
  }
  if (n === "anthropic") {
    const key = process.env["AI_INTEGRATIONS_ANTHROPIC_API_KEY"];
    const base_url = process.env["AI_INTEGRATIONS_ANTHROPIC_BASE_URL"];
    if (key && base_url) return { key, source: "proxy", base_url };
  }
  if (n === "gemini" || n === "google gemini") {
    const key = process.env["AI_INTEGRATIONS_GEMINI_API_KEY"];
    const base_url = process.env["AI_INTEGRATIONS_GEMINI_BASE_URL"];
    if (key && base_url) return { key, source: "proxy", base_url };
  }
  return null;
}
