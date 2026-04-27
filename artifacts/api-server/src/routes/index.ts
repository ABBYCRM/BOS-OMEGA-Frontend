import { Router, type IRouter } from "express";
import { publicHealthRouter, protectedHealthRouter } from "./health.js";
import tasksRouter from "./tasks.js";
import providersRouter from "./providers.js";
import modelsRouter from "./models.js";
import auditRouter from "./audit.js";
import memoryRouter from "./memory.js";
import personasRouter from "./personas.js";
import fallbackRouter from "./fallback.js";
import runsRouter from "./runs.js";
import triStateRouter from "./triState.js";
import authRouter from "./auth.js";
import uploadsRouter from "./uploads.js";
import usersRouter from "./users.js";
import overridesRouter from "./overrides.js";
import v1Router from "./v1/index.js";
import { requireAuth } from "../lib/security/auth.js";
import { readLimiter, writeLimiter } from "../lib/security/rateLimit.js";

const router: IRouter = Router();

// ---- Public (unauthenticated) ----
// Liveness only — no data leak; safe for uptime monitors.
router.use(publicHealthRouter);

// Auth endpoints — own rate limiter on /login.
router.use("/auth", authRouter);

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

// ---- Authenticated ----
// Everything below requires a valid admin session.
router.use(requireAuth);

router.use(protectedHealthRouter);
router.use("/tasks", tasksRouter);
router.use("/providers", providersRouter);
router.use("/models", modelsRouter);
router.use("/audit", auditRouter);
router.use("/memory", memoryRouter);
router.use("/personas", personasRouter);
router.use("/fallback-events", fallbackRouter);
router.use("/runs", runsRouter);
router.use("/tri-state", triStateRouter);
router.use("/uploads", uploadsRouter);
router.use("/users", usersRouter);
router.use("/overrides", overridesRouter);

export default router;
