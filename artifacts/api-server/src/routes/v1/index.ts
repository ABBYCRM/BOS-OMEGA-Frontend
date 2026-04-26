import { Router, type IRouter } from "express";
import orgsRouter from "./orgs.js";
import devicesRouter from "./devices.js";
import pairCodesRouter from "./pairCodes.js";
import taskRequestsRouter from "./taskRequests.js";
import { requireAuth } from "../../lib/security/auth.js";

/**
 * `/api/v1/...` — the local-agent and enterprise surface.
 *
 * Layout:
 *   - `/v1/devices/register` is PUBLIC (the front door for new agents).
 *     Auth-by-pair-code or auth-by-enrollment-secret happens inside the
 *     handler. Per-IP rate limiting is inherited from the parent
 *     router's split limiter.
 *   - `/v1/orgs/...` requires an authenticated super_admin. Mounted
 *     behind requireAuth here so the org routes don't have to repeat
 *     it themselves.
 *
 * Future routes from Tasks #21-25 (`/v1/policies`, `/v1/approvals`,
 * `/v1/executions`) will land here without changing this file's
 * shape. `/v1/task-requests` is mounted today as the integration
 * point for the signed-request middleware (windows_session
 * persistence + cross-session enforcement).
 */

const v1Router: IRouter = Router();

v1Router.use("/devices", devicesRouter);

// Task-request submission from paired agents. Mounts the
// signed-request middleware (HMAC + clock-skew + WindowsSessionInfo
// parse) so every downstream handler inherits the local-agent
// identity check. Task #21 will extend this surface; the
// middleware seam stays.
v1Router.use("/task-requests", taskRequestsRouter);

// Org admin routes — every handler self-asserts requireRole("super_admin"),
// but we still gate the whole subtree behind requireAuth so unauthenticated
// requests get a 401 rather than reaching the role check with no user.
v1Router.use("/orgs", requireAuth, orgsRouter);

// Pair-code minting — super_admin-only. Plain text returned exactly
// once in the response body; only the SHA-256 is persisted. Codes are
// redeemed at /v1/devices/register for INDIVIDUAL_CONSENT installs.
v1Router.use("/pair-codes", requireAuth, pairCodesRouter);

export default v1Router;
