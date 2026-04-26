import { ReferenceAgent, type ReferenceAgentOptions, type ReferenceAgentFetch } from "./agent.js";
import {
  type InstallMode,
  type WindowsSessionInfo,
  LOCAL_AGENT_CONTRACT_VERSION,
} from "@workspace/local-agent-contracts";

/**
 * Interactive pair-code path. The human operator types a 6-character
 * code surfaced in the bos-omega Local Agent → Pairing screen. The
 * agent posts that code to
 * `/api/v1/devices/register?install_mode=INDIVIDUAL_CONSENT` and
 * receives back its server-assigned `device_id`. The org_id for an
 * INDIVIDUAL_CONSENT install is always `null`.
 *
 * On the wire side this is identical to enrollment-secret pairing;
 * only the auth token (pair_code vs org_enrollment_secret) changes.
 * Keeping them in separate files makes the two consent flows easier
 * to audit independently.
 */
export type InteractivePairingArgs = {
  server_url: string;
  pair_code: string;
  display_name: string;
  hostname: string | null;
  device_pubkey: string;
  signed_request_secret: string;
  getWindowsSession: () => WindowsSessionInfo;
  fetchImpl?: ReferenceAgentFetch;
};

export async function startInteractivePairing(
  args: InteractivePairingArgs,
): Promise<ReferenceAgent> {
  const installMode: InstallMode = "INDIVIDUAL_CONSENT";

  // The constructor takes placeholder ids; `registerDevice` overwrites
  // them with the server-issued values before returning. This way the
  // caller never sees pre-registration state.
  const opts: ReferenceAgentOptions = {
    server_url: args.server_url,
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
    pair_code: args.pair_code,
    contract_version: LOCAL_AGENT_CONTRACT_VERSION,
  });
  return agent;
}
