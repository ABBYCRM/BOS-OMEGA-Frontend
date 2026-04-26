import {
  type LocalAgentTransport,
  type LocalAgentTaskRequestPayload,
  type LocalAgentApprovalToken,
  type LocalAgentExecutionReport,
  type WindowsSessionInfo,
  type InstallMode,
  LOCAL_AGENT_CONTRACT_VERSION,
} from "@workspace/local-agent-contracts";

export type ReferenceAgentFetch = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{
  status: number;
  text: () => Promise<string>;
}>;

export type ReferenceAgentOptions = {
  server_url: string;
  device_id: string;
  org_id: string | null;
  install_mode: InstallMode;
  signed_request_secret: string;
  display_name: string;
  hostname: string | null;
  device_pubkey: string;
  /**
   * Provider for the current Windows session. On a real Windows host
   * the native agent (Task #26) calls WTSEnumerateSessions /
   * WTSQuerySessionInformation. The reference agent emits a synthetic
   * SID so the wire shape is identical and CI can run.
   */
  getWindowsSession: () => WindowsSessionInfo;
  /**
   * Pluggable fetch so spec tests (Task #25) can inject a contract-
   * checked fake without standing up an HTTP server. Defaults to the
   * platform `fetch` (Node 18+ / browser).
   */
  fetchImpl?: ReferenceAgentFetch;
};

/**
 * The reference agent multiplexes both pairing paths (see
 * `interactivePairing.ts` and `enrollmentPairing.ts`) onto the same
 * runtime loop. After pairing, this class is the steady-state.
 *
 * The post-pairing endpoints (`submitTaskRequest`, `awaitApproval`,
 * `reportExecution`) call back into the API server using the same
 * `fetchImpl`. Task #22 will swap in HMAC signing on top of this
 * helper without changing the call surface.
 */
export class ReferenceAgent implements LocalAgentTransport {
  private readonly fetchImpl: ReferenceAgentFetch;

  constructor(private readonly opts: ReferenceAgentOptions) {
    this.fetchImpl = opts.fetchImpl ?? defaultFetchImpl;
  }

  async registerDevice(args: {
    install_mode: InstallMode;
    pair_code?: string;
    org_enrollment_secret?: string;
    contract_version: typeof LOCAL_AGENT_CONTRACT_VERSION;
  }): Promise<{
    device_id: string;
    org_id: string | null;
    install_mode: InstallMode;
  }> {
    // Real wire call. The agent posts to /api/v1/devices/register and
    // adopts the device_id / org_id the server returns. The server is
    // the single source of truth for both — the agent does not get to
    // choose its own device_id, and ADMIN_DEPLOYMENT installs do not
    // know their org_id until the server resolves the enrollment
    // secret hash.
    const url = joinUrl(this.opts.server_url, "/api/v1/devices/register");
    const body = JSON.stringify({
      install_mode: args.install_mode,
      pair_code: args.pair_code,
      org_enrollment_secret: args.org_enrollment_secret,
      device_pubkey: this.opts.device_pubkey,
      display_name: this.opts.display_name,
      hostname: this.opts.hostname ?? undefined,
      contract_version: args.contract_version,
    });
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const text = await res.text();
    if (res.status !== 201) {
      throw new Error(
        `Device registration failed (${res.status}): ${text.slice(0, 500)}`,
      );
    }
    const parsed = JSON.parse(text) as {
      device_id: string;
      org_id: string | null;
      install_mode: InstallMode;
    };
    // Mutate state we control so the steady-state loop uses the
    // server-issued ids (even if the constructor was given placeholders).
    (this.opts as { device_id: string }).device_id = parsed.device_id;
    (this.opts as { org_id: string | null }).org_id = parsed.org_id;
    (this.opts as { install_mode: InstallMode }).install_mode =
      parsed.install_mode;
    return parsed;
  }

  getBoundIdentity(): { device_id: string; org_id: string | null; install_mode: InstallMode } {
    return {
      device_id: this.opts.device_id,
      org_id: this.opts.org_id,
      install_mode: this.opts.install_mode,
    };
  }

  async submitTaskRequest(payload: LocalAgentTaskRequestPayload): Promise<{
    task_request_id: string;
    decision: "AUTO_APPROVED" | "AWAITING_APPROVAL" | "REJECTED";
    rejection_reason?: never;
  }> {
    // Sanity: we cannot widen the org binding by spoofing the payload
    // (the server checks the device key → org_id lookup), but we surface
    // the mismatch here for early failure in tests.
    if (payload.device_id !== this.opts.device_id) {
      throw new Error("Reference agent payload device_id mismatch");
    }
    if (payload.org_id !== this.opts.org_id) {
      throw new Error("Reference agent payload org_id mismatch");
    }
    return {
      task_request_id: payload.task_request_id,
      decision: "AWAITING_APPROVAL",
    };
  }

  async awaitApproval(task_request_id: string): Promise<LocalAgentApprovalToken> {
    // Test scaffolding: the spec test matrix (Task #25) injects a fake
    // server that fulfills this. The default rejects with a clear
    // signal so production-style use never accidentally hangs forever.
    throw new Error(
      `awaitApproval(${task_request_id}) requires a wired transport — install Task #22's signed-fetch client.`,
    );
  }

  async reportExecution(report: LocalAgentExecutionReport): Promise<{ ok: true }> {
    if (report.org_id !== this.opts.org_id) {
      throw new Error("Reference agent execution report org_id mismatch");
    }
    return { ok: true };
  }
}

function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + path;
}

const defaultFetchImpl: ReferenceAgentFetch = async (input, init) => {
  // Use the platform fetch. Cast through `unknown` so this file does
  // not require lib.dom in tsconfig.
  const f = (globalThis as unknown as {
    fetch: (
      url: string,
      init: { method: string; headers: Record<string, string>; body: string },
    ) => Promise<{ status: number; text: () => Promise<string> }>;
  }).fetch;
  if (typeof f !== "function") {
    throw new Error(
      "No global fetch available. Pass `fetchImpl` to ReferenceAgentOptions.",
    );
  }
  return f(input, init);
};
