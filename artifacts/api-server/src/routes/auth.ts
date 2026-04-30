import { Router } from "express";
import {
  verifyUserCredentials,
  issueSessionCookie,
  clearSessionCookie,
  readSessionCookie,
  getUserById,
  signupUser,
} from "../lib/security/auth.js";
import { loginLimiter, signupLimiter } from "../lib/security/rateLimit.js";
import { logger } from "../lib/logger.js";
import { auditLog } from "../bos/auditEngine.js";

const router = Router();

router.get("/me", async (req, res) => {
  // /me is a cheap polling endpoint — must not 401 unauthenticated pollers
  // (the SPA's auth-gate would loop). Return authenticated:false instead.
  // Use the same validator + secret-resolution path as requireAuth so an
  // ephemeral SESSION_SECRET fallback works consistently across both paths.
  const session = readSessionCookie(req);
  if (!session) {
    res.json({ authenticated: false });
    return;
  }
  // Re-check the user against the DB so a disabled account is reported as
  // unauthenticated even if the cookie is still valid.
  const user = await getUserById(session.uid);
  if (!user) {
    res.json({ authenticated: false });
    return;
  }
  res.json({
    authenticated: true,
    user: { id: user.id, email: user.email, role: user.role },
  });
});

router.post("/login", loginLimiter, async (req, res) => {
  const body = req.body as { email?: unknown; password?: unknown } | undefined;
  const ip = req.ip ?? "unknown";

  const user = await verifyUserCredentials(body?.email, body?.password);
  if (!user) {
    logger.warn(
      { ip, ua: req.headers["user-agent"] ?? null, event: "AUTH_LOGIN_FAILED" },
      "Failed login attempt",
    );
    void auditLog(undefined, "AUTH_LOGIN_FAILED", "Failed login attempt", {
      ip,
      email: typeof body?.email === "string" ? body.email : null,
    });
    res.status(401).json({ error: "Invalid credentials", code: "INVALID_CREDENTIALS" });
    return;
  }

  issueSessionCookie(res, user);
  logger.info(
    { ip, ua: req.headers["user-agent"] ?? null, uid: user.id, event: "AUTH_LOGIN_SUCCESS" },
    "Login success",
  );
  void auditLog(undefined, "AUTH_LOGIN_SUCCESS", `User ${user.email} signed in`, {
    actor_user_id: user.id,
    role: user.role,
    ip,
  });
  res.json({
    ok: true,
    user: { id: user.id, email: user.email, role: user.role },
  });
});

router.post("/signup", signupLimiter, async (req, res) => {
  const body = req.body as { email?: unknown; password?: unknown } | undefined;
  const ip = req.ip ?? "unknown";
  const result = await signupUser(body?.email, body?.password);

  if (!result.ok) {
    const status = result.error.kind === "email_taken" ? 409 : 400;
    const code =
      result.error.kind === "email_taken"
        ? "EMAIL_TAKEN"
        : result.error.kind === "invalid_email"
          ? "INVALID_EMAIL"
          : "WEAK_PASSWORD";
    void auditLog(undefined, "AUTH_SIGNUP_FAILED", `Signup rejected (${code})`, {
      ip,
      email: typeof body?.email === "string" ? body.email : null,
      reason: code,
    });
    res.status(status).json({ error: code, code });
    return;
  }

  issueSessionCookie(res, result.user);
  logger.info(
    { ip, ua: req.headers["user-agent"] ?? null, uid: result.user.id, event: "AUTH_SIGNUP_SUCCESS" },
    "Signup success",
  );
  void auditLog(undefined, "AUTH_SIGNUP_SUCCESS", `User ${result.user.email} signed up`, {
    actor_user_id: result.user.id,
    role: result.user.role,
    ip,
  });
  res.status(201).json({
    ok: true,
    user: { id: result.user.id, email: result.user.email, role: result.user.role },
  });
});

router.post("/logout", (req, res) => {
  clearSessionCookie(res);
  logger.info({ ip: req.ip ?? "unknown", event: "AUTH_LOGOUT" }, "Logout");
  res.json({ ok: true });
});

export default router;
