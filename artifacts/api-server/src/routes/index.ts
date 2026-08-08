import { Router, type IRouter } from "express";
import { publicHealthRouter, protectedHealthRouter } from "./health.js";
import tasksRouter from "./tasks.js";
import providersRouter from "./providers.js";
import modelsRouter from "./models.js";
import auditRouter from "./audit.js";
import memoryRouter from "./memory.js";
import scratchpadRouter from "./scratchpad.js";
import conversationsRouter from "./conversations.js";
import latticeRouter from "./lattice.js";
import continuityBundleRouter from "./continuityBundle.js";
import personasRouter from "./personas.js";
import fallbackRouter from "./fallback.js";
import runsRouter from "./runs.js";
import triStateRouter from "./triState.js";
import authRouter from "./auth.js";
import uploadsRouter from "./uploads.js";
import usersRouter from "./users.js";
import overridesRouter from "./overrides.js";
import imageQuotaRouter from "./imageQuota.js";
import powershellRouter from "./powershell.js";
import v1Router from "./v1/index.js";
import apiTokensRouter from "./apiTokens.js";
import externalRouter from "./external.js";
import tuningRouter from "./tuning.js";
import { requireAuth } from "../lib/security/auth.js";
import { readLimiter, writeLimiter } from "../lib/security/rateLimit.js";

const router: IRouter = Router();

// ---- Public (unauthenticated) ----
// Liveness only — no data leak; safe for uptime monitors.
router.use(publicHealthRouter);

// Auth endpoints — own rate limiter on /login.
router.use("/auth", authRouter);

// ---- Token management (session-auth) — registered BEFORE the global
// requireAuth gate so that the unauthenticated boot is impossible to
// mistake for a token-auth surface. /api/tokens/* is the only place a
// caller can mint a new token; the token itself is what /api/external/*
// accepts.
router.use("/tokens", apiTokensRouter);

// ---- Rate limiter (read/write split) ----
// Applies to everything below — including the /v1 surface, where the
// public device-registration route lives. We intentionally rate-limit
// /v1 too because device register is anonymous and would otherwise be
// the easiest enumeration target on the API.
router.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    return readLimiter(req, res, next);
  }
  return writeLimiter(req, res, next);
});

// ---- Local-agent + enterprise surface ----
// /v1/devices/register is intentionally public (the front door for new
// agents). /v1/orgs/* gates itself on requireAuth + requireRole inside
// the v1 router so we don't accidentally pull org admin under
// pair-code-only auth.
router.use("/v1", v1Router);

// ---- External API surface (token-auth, separate from session-auth).
// All routes under /api/external/* require a Bearer token issued by
// /api/tokens. The token is hashed (sha256) at rest; plaintext is
// shown to the user exactly once on creation. Scopes gate write
// access to canon / scratchpad / continuity separately. See
// routes/external.ts for the full surface and middlewares/apiTokenAuth.ts
// for the auth chain. Registered BEFORE the global requireAuth gate
// so the session-cookie check does not short-circuit token auth.
router.use("/external", externalRouter);
// Tuning subsystem (mounted under /api/external/tuning). Lives next
// to /api/external/* so a single Bearer token covers the whole
// external surface: data (memory/conversations/tasks) + ops
// (tuning/tokens).
router.use("/external/tuning", tuningRouter);

// ---- Authenticated ----
// Everything below requires a valid admin session.
router.use(requireAuth);

router.use(protectedHealthRouter);
router.use("/tasks", tasksRouter);
router.use("/providers", providersRouter);
router.use("/models", modelsRouter);
router.use("/audit", auditRouter);
router.use("/memory", memoryRouter);
router.use("/scratchpad", scratchpadRouter);
router.use("/conversations", conversationsRouter);
router.use("/lattice", latticeRouter);
router.use("/continuity-bundle", continuityBundleRouter);
router.use("/personas", personasRouter);
router.use("/fallback-events", fallbackRouter);
router.use("/runs", runsRouter);
router.use("/tri-state", triStateRouter);
router.use("/uploads", uploadsRouter);
router.use("/users", usersRouter);
router.use("/overrides", overridesRouter);
router.use("/image-quota", imageQuotaRouter);
// Host PowerShell shell — opt-in via POWERSHELL_ENDPOINT_ENABLED=1,
// gated to super_admin only inside the router itself, audit-logged.
// See routes/powershell.ts for the full security posture.
router.use("/powershell", powershellRouter);

export default router;
