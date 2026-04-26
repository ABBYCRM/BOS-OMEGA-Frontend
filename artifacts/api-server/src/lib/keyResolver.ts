import { db } from "@workspace/db";
import { llmProvidersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createHash } from "crypto";
import { decryptSecret } from "./secrets.js";

export interface ResolvedKey {
  key: string;
  source: "db" | "env" | "legacy" | "proxy" | "none";
  base_url?: string;
  /**
   * R-5: non-reversible 4+4-character SHA-256 fingerprint of the resolved key
   * (e.g. "ab12…ef90"). Empty string when no key is present. Stable across
   * calls so the audit chain can show "is this the same key as last week?"
   * without ever exposing the key itself or any prefix of it.
   */
  key_fingerprint: string;
}

/**
 * R-5: short, non-reversible fingerprint of an API key. NEVER returns or
 * exposes the key or any prefix of the key. The 4+4 hex slices come from
 * a SHA-256 digest, so 64 bits of entropy are visible while the original
 * value remains computationally infeasible to recover from the fingerprint.
 */
export function fingerprintKey(key: string): string {
  if (!key) return "";
  const h = createHash("sha256").update(key).digest("hex");
  return `${h.slice(0, 4)}…${h.slice(-4)}`;
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
      if (key) return { key, source: "db", key_fingerprint: fingerprintKey(key) };
    }
    if (row?.api_key_env) {
      const key = process.env[row.api_key_env];
      if (key) return { key, source: "env", key_fingerprint: fingerprintKey(key) };
    }
  }
  const legacy = canonicalEnvFor(provider_name);
  if (legacy) {
    const key = process.env[legacy];
    if (key) return { key, source: "legacy", key_fingerprint: fingerprintKey(key) };
  }
  const proxy = proxyFor(provider_name);
  if (proxy) return proxy;
  return { key: "", source: "none", key_fingerprint: "" };
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
    if (key && base_url) return { key, source: "proxy", base_url, key_fingerprint: fingerprintKey(key) };
  }
  if (n === "anthropic") {
    const key = process.env["AI_INTEGRATIONS_ANTHROPIC_API_KEY"];
    const base_url = process.env["AI_INTEGRATIONS_ANTHROPIC_BASE_URL"];
    if (key && base_url) return { key, source: "proxy", base_url, key_fingerprint: fingerprintKey(key) };
  }
  if (n === "gemini" || n === "google gemini") {
    const key = process.env["AI_INTEGRATIONS_GEMINI_API_KEY"];
    const base_url = process.env["AI_INTEGRATIONS_GEMINI_BASE_URL"];
    if (key && base_url) return { key, source: "proxy", base_url, key_fingerprint: fingerprintKey(key) };
  }
  return null;
}
