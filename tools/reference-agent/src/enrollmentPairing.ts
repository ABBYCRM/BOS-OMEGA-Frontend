import { ReferenceAgent, type ReferenceAgentOptions, type ReferenceAgentFetch } from "./agent.js";
import {
  type InstallMode,
  type WindowsSessionInfo,
  LOCAL_AGENT_CONTRACT_VERSION,
  EnterpriseAgentConfigFileSchema,
} from "@workspace/local-agent-contracts";
import { loadEnterpriseConfig } from "./enterpriseConfig.js";

/**
 * Enrollment-secret pairing path. The agent is launched without an
 * interactive operator (silent MSI / GPO / Intune Win32 app), reads
 * its enterprise config from disk, and posts the org enrollment
 * secret to
 * `/api/v1/devices/register?install_mode=ADMIN_DEPLOYMENT`. The
 * server returns the device_id and the resolved org_id; the agent
 * never has to know its org_id ahead of time (the config only knows
 * the secret).
 *
 * The same `ReferenceAgent` runtime is used for both pairing modes —
 * after registration the steady-state loop is identical.
 */
export type EnrollmentPairingArgs = {
  override_config_path?: string;
  display_name: string;
  hostname: string | null;
  device_pubkey: string;
  signed_request_secret: string;
  getWindowsSession: () => WindowsSessionInfo;
  fetchImpl?: ReferenceAgentFetch;
};

export async function startEnrollmentPairing(
  args: EnrollmentPairingArgs,
): Promise<ReferenceAgent> {
  const cfg = await loadEnterpriseConfig(args.override_config_path);
  if (!cfg) {
    throw new Error(
      "No enterprise config found. Set BOS_AGENT_CONFIG_PATH or place agent.config.json at the documented location.",
    );
  }
  // Defensive re-validate: even when `loadEnterpriseConfig` already
  // validated, a caller that builds a config in-memory and passes it
  // into a custom path would otherwise bypass the schema. Keeping the
  // validation here means the pairing path is the gate.
  EnterpriseAgentConfigFileSchema.parse(cfg);

  const installMode: InstallMode = "ADMIN_DEPLOYMENT";

  const opts: ReferenceAgentOptions = {
    server_url: cfg.server_url,
    device_id: "<pending>",
    org_id: null,
    install_mode: installMode,
    signed_request_secret: args.signed_request_secret,
    display_name: args.display_name,
    hostname: args.hostname,
    device_pubkey: args.device_pubkey,
    getWindowsSession: args.getWindowsSession,
    fetchImpl: args.fetchImpl,
  };
  const agent = new ReferenceAgent(opts);
  await agent.registerDevice({
    install_mode: installMode,
    org_enrollment_secret: cfg.org_enrollment_secret,
    contract_version: LOCAL_AGENT_CONTRACT_VERSION,
  });
  return agent;
}
