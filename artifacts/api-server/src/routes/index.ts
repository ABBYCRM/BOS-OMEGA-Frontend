import { Router, type IRouter } from "express";
import { publicHealthRouter, protectedHealthRouter } from "./health.js";
import tasksRouter from "./tasks.js";
import providersRouter from "./providers.js";
import modelsRouter from "./models.js";
import auditRouter from "./audit.js";
import memoryRouter from "./memory.js";
import fallbackRouter from "./fallback.js";
import runsRouter from "./runs.js";
import triStateRouter from "./triState.js";
import authRouter from "./auth.js";
import uploadsRouter from "./uploads.js";
import usersRouter from "./users.js";
import overridesRouter from "./overrides.js";
import { requireAuth } from "../lib/security/auth.js";
import { readLimiter, writeLimiter } from "../lib/security/rateLimit.js";

const router: IRouter = Router();

// ---- Public (unauthenticated) ----
// Liveness only — no data leak; safe for uptime monitors.
router.use(publicHealthRouter);

// Auth endpoints — own rate limiter on /login.
router.use("/auth", authRouter);

// ---- Authenticated ----
// Everything below requires a valid admin session. The split limiter pattern
// applies a tighter cap to mutating verbs.
router.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    return readLimiter(req, res, next);
  }
  return writeLimiter(req, res, next);
});
router.use(requireAuth);

router.use(protectedHealthRouter);
router.use("/tasks", tasksRouter);
router.use("/providers", providersRouter);
router.use("/models", modelsRouter);
router.use("/audit", auditRouter);
router.use("/memory", memoryRouter);
router.use("/fallback-events", fallbackRouter);
router.use("/runs", runsRouter);
router.use("/tri-state", triStateRouter);
router.use("/uploads", uploadsRouter);
router.use("/users", usersRouter);
router.use("/overrides", overridesRouter);

export default router;
