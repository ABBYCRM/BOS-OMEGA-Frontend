/**
 * @workspace/reference-agent
 *
 * The non-Windows reference implementation of the Local Automation
 * Agent. Used by:
 *   - The spec test matrix (Task #25) as the System Under Test.
 *   - The dev console (Task #24) for local round-trips.
 *   - This task (#32) to prove the dual-mode pairing path works
 *     against the same agent code — interactive pair-code AND
 *     enrollment-secret — without copy/paste.
 *
 * The runtime here is deliberately minimal: HTTP + JSON, no native
 * Windows calls. The Windows-native agent (Task #26) will share this
 * file's TS types via @workspace/local-agent-contracts but will live
 * in a different package because it links native code.
 */

export { ReferenceAgent } from "./agent.js";
export { loadEnterpriseConfig } from "./enterpriseConfig.js";
export { startInteractivePairing } from "./interactivePairing.js";
export { startEnrollmentPairing } from "./enrollmentPairing.js";
export type { ReferenceAgentOptions } from "./agent.js";
