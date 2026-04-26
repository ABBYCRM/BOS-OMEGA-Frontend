/**
 * Tiny CLI entry point. Used by the dev console (Task #24) and by
 * spec-test fixtures. Two modes:
 *
 *   reference-agent --mode interactive --server <url> --pair-code <code>
 *   reference-agent --mode enrollment   --config <path>
 *
 * The CLI is intentionally minimal — argument parsing is via a hand-
 * rolled scan rather than a dep, both to keep the install footprint
 * tight and to avoid a runtime dep on a parser package that the
 * Windows native agent (Task #26) wouldn't otherwise need.
 */

import { startInteractivePairing } from "./interactivePairing.js";
import { startEnrollmentPairing } from "./enrollmentPairing.js";
import { type WindowsSessionInfo } from "@workspace/local-agent-contracts";

function syntheticSession(): WindowsSessionInfo {
  return {
    sid: `S-REF-${process.pid}-${Date.now().toString(36)}`,
    username: process.env["USER"] ?? "reference-agent",
    session_id: 1,
    is_remote_session: false,
    is_admin_session: false,
  };
}

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx < 0 || idx === process.argv.length - 1) return undefined;
  return process.argv[idx + 1];
}

async function main(): Promise<void> {
  const mode = getArg("mode") ?? "interactive";
  if (mode === "interactive") {
    const server = getArg("server") ?? "http://localhost:5000";
    const pair_code = getArg("pair-code") ?? "ABCDEF";
    const agent = await startInteractivePairing({
      server_url: server,
      pair_code,
      display_name: "reference-agent",
      hostname: null,
      device_pubkey: "ref-pubkey",
      signed_request_secret: "ref-secret-do-not-use-in-prod",
      getWindowsSession: syntheticSession,
    });
    console.log("[reference-agent] interactive pairing OK", { agent: typeof agent });
    return;
  }
  if (mode === "enrollment") {
    const cfg = getArg("config");
    const agent = await startEnrollmentPairing({
      ...(cfg !== undefined ? { override_config_path: cfg } : {}),
      display_name: "reference-agent-enroll",
      hostname: null,
      device_pubkey: "ref-pubkey",
      signed_request_secret: "ref-secret-do-not-use-in-prod",
      getWindowsSession: syntheticSession,
    });
    console.log("[reference-agent] enrollment pairing OK", { agent: typeof agent });
    return;
  }
  throw new Error(`Unknown mode: ${mode}`);
}

main().catch((err: unknown) => {
  console.error("[reference-agent] fatal", err);
  process.exit(1);
});
