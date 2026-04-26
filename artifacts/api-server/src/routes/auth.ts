import { Router } from "express";
import {
  verifyPassword,
  issueSessionCookie,
  clearSessionCookie,
  isAuthenticated,
} from "../lib/security/auth.js";
import { loginLimiter } from "../lib/security/rateLimit.js";
import { logger } from "../lib/logger.js";

const router = Router();

router.get("/me", (req, res) => {
  res.json({ authenticated: isAuthenticated(req) });
});

router.post("/login", loginLimiter, async (req, res) => {
  const body = req.body as { password?: unknown } | undefined;
  const password = typeof body?.password === "string" ? body.password : "";
  const ip = req.ip ?? "unknown";

  const ok = await verifyPassword(password);
  if (!ok) {
    logger.warn(
      { ip, ua: req.headers["user-agent"] ?? null, event: "AUTH_LOGIN_FAILED" },
      "Failed admin login attempt",
    );
    res.status(401).json({ error: "Invalid credentials", code: "INVALID_CREDENTIALS" });
    return;
  }

  issueSessionCookie(res);
  logger.info(
    { ip, ua: req.headers["user-agent"] ?? null, event: "AUTH_LOGIN_SUCCESS" },
    "Admin login success",
  );
  res.json({ ok: true });
});

router.post("/logout", (req, res) => {
  clearSessionCookie(res);
  logger.info({ ip: req.ip ?? "unknown", event: "AUTH_LOGOUT" }, "Admin logout");
  res.json({ ok: true });
});

export default router;
