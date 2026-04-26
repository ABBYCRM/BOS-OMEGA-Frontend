import { db } from "@workspace/db";
import { llmProvidersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { decryptSecret } from "./secrets.js";

/**
 * Resolve the API key for a provider with this priority:
 *   1. DB-stored encrypted key (set via the Settings UI — the agentic path)
 *   2. Environment variable referenced by api_key_env
 *   3. Legacy hardcoded env var by canonical name (OPENAI_API_KEY etc.)
 *
 * Returns "" when no key is available — caller should switch to mock mode.
 */
export async function resolveProviderKey(
  provider_id: string | undefined,
  provider_name: string,
): Promise<{ key: string; source: "db" | "env" | "legacy" | "none" }> {
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
  return { key: "", source: "none" };
}

export function canonicalEnvFor(provider_name: string): string | null {
  const n = provider_name.toLowerCase();
  if (n === "openai") return "OPENAI_API_KEY";
  if (n === "anthropic") return "ANTHROPIC_API_KEY";
  if (n === "gemini" || n === "google gemini") return "GEMINI_API_KEY";
  return null;
}
