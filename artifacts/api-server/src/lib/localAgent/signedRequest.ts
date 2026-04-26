import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import {
  WindowsSessionInfoSchema,
  type WindowsSessionInfo,
} from "@workspace/local-agent-contracts";

/**
 * Local-agent signed-request middleware (foundation laid by Task #32,
 * full surface owned by Task #22).
 *
 * Every request from a paired Windows agent carries:
 *   - `X-BOS-Device-Id` — the agent's device id.
 *   - `X-BOS-Signature` — HMAC-SHA256 over `${ts}.${method}.${path}.${body}`.
 *   - `X-BOS-Timestamp` — RFC-3339 timestamp; we reject anything more
 *     than 5 minutes off the wall clock to limit replay windows.
 *   - `X-BOS-Windows-Session` — base64url-encoded JSON conforming to
 *     `WindowsSessionInfoSchema`. Persisted on the matching task row so
 *     forensics can answer "which session ran this?".
 *
 * The middleware:
 *   1. Validates header presence and shape.
 *   2. Recomputes the HMAC against a per-device secret looked up via
 *      `lookupDeviceSecret` and rejects mismatches in constant time.
 *   3. Parses + validates the windows_session header.
 *   4. Attaches `req.bosLocalAgent = { device_id, windows_session }`
 *      for downstream handlers.
 *
 * Cross-session approval reuse (a token issued for SID A consumed by
 * SID B on the same device) is enforced one layer up in the policy
 * engine (`evaluateExecutionGate`) and surfaced to the audit log as
 * `SESSION_BINDING_MISMATCH`.
 */

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export type LocalAgentRequestContext = {
  device_id: string;
  windows_session: WindowsSessionInfo;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      bosLocalAgent?: LocalAgentRequestContext;
    }
  }
}

export type DeviceSecretLookup = (deviceId: string) => Promise<string | null>;

export function makeLocalAgentSignedRequestMiddleware(
  lookupDeviceSecret: DeviceSecretLookup,
) {
  return async function localAgentSignedRequest(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const deviceId = req.header("X-BOS-Device-Id");
    const sig = req.header("X-BOS-Signature");
    const tsHeader = req.header("X-BOS-Timestamp");
    const sessHeader = req.header("X-BOS-Windows-Session");

    if (!deviceId || !sig || !tsHeader || !sessHeader) {
      res.status(401).json({
        error: "Missing local-agent signed request headers",
        code: "LOCAL_AGENT_HEADERS_MISSING",
      });
      return;
    }

    const ts = Date.parse(tsHeader);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > MAX_CLOCK_SKEW_MS) {
      res.status(401).json({
        error: "Timestamp out of acceptable skew window",
        code: "LOCAL_AGENT_TIMESTAMP_SKEW",
      });
      return;
    }

    let session: WindowsSessionInfo;
    try {
      const decoded = Buffer.from(sessHeader, "base64url").toString("utf8");
      session = WindowsSessionInfoSchema.parse(JSON.parse(decoded));
    } catch {
      // Malformed session info is hard-rejected. The reason is wired
      // through to the audit log via the `SESSION_INFO_MALFORMED`
      // rejection reason in @workspace/local-agent-contracts.
      res.status(400).json({
        error: "Malformed X-BOS-Windows-Session header",
        code: "SESSION_INFO_MALFORMED",
      });
      return;
    }

    const secret = await lookupDeviceSecret(deviceId);
    if (!secret) {
      res.status(401).json({
        error: "Unknown device",
        code: "LOCAL_AGENT_UNKNOWN_DEVICE",
      });
      return;
    }

    // Body is expected to be the raw JSON the client sent. We re-stringify
    // from the parsed body to canonicalize whitespace; any production
    // deployment that wants byte-exact signing should switch to a raw-body
    // capture in the JSON parser. The signing scheme is owned by Task #22
    // and may evolve there.
    const body = req.body && Object.keys(req.body).length > 0
      ? JSON.stringify(req.body)
      : "";
    const expected = createHmac("sha256", secret)
      .update(`${tsHeader}.${req.method}.${req.path}.${body}`)
      .digest("base64url");

    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      res.status(401).json({
        error: "Bad signature",
        code: "LOCAL_AGENT_BAD_SIGNATURE",
      });
      return;
    }

    req.bosLocalAgent = { device_id: deviceId, windows_session: session };
    next();
  };
}
