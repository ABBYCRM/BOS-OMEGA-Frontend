import { promises as fs } from "node:fs";
import {
  EnterpriseAgentConfigFileSchema,
  type EnterpriseAgentConfigFile,
} from "@workspace/local-agent-contracts";

const ENV_OVERRIDE = "BOS_AGENT_CONFIG_PATH";
const DEFAULT_PATH_HINTS = [
  // The Windows MSI / GPO / RMM canonical drop site, documented in
  // docs/local-automation-agent/enterprise-config.md.
  "C:\\ProgramData\\BOS-Omega\\agent.config.json",
  // POSIX dev path used by the spec test matrix.
  "/etc/bos-omega/agent.config.json",
];

/**
 * Read and validate the enterprise agent config. Resolution order:
 *   1. `BOS_AGENT_CONFIG_PATH` env var (highest priority — pilot escape hatch)
 *   2. The first path in `DEFAULT_PATH_HINTS` that exists.
 *   3. `null` — agent falls back to interactive pair-code mode.
 *
 * NEVER silently degrade on a present-but-broken config. If the file
 * exists and fails validation we throw; the agent's bootstrap is
 * expected to surface the error and refuse to start.
 */
export async function loadEnterpriseConfig(
  overridePath?: string,
): Promise<EnterpriseAgentConfigFile | null> {
  const candidate =
    overridePath ?? process.env[ENV_OVERRIDE] ?? (await firstExisting(DEFAULT_PATH_HINTS));

  if (!candidate) return null;

  const raw = await fs.readFile(candidate, "utf8");
  const parsed = JSON.parse(raw);
  return EnterpriseAgentConfigFileSchema.parse(parsed);
}

async function firstExisting(paths: ReadonlyArray<string>): Promise<string | null> {
  for (const p of paths) {
    try {
      await fs.access(p);
      return p;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}
