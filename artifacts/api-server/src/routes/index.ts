import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import tasksRouter from "./tasks.js";
import providersRouter from "./providers.js";
import modelsRouter from "./models.js";
import auditRouter from "./audit.js";
import memoryRouter from "./memory.js";
import fallbackRouter from "./fallback.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/tasks", tasksRouter);
router.use("/providers", providersRouter);
router.use("/models", modelsRouter);
router.use("/audit", auditRouter);
router.use("/memory", memoryRouter);
router.use("/fallback-events", fallbackRouter);

export default router;
