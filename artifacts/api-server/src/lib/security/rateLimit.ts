import rateLimit from "express-rate-limit";

/**
 * Rate limiters for BOS-Omega.
 *
 * Tiers:
 *   - loginLimiter: 10 attempts per 15min per IP. Brute-force defence on /auth/login.
 *   - writeLimiter: 60 mutating requests per minute per IP. Defence against
 *     scripted abuse on POST/PUT/PATCH/DELETE endpoints.
 *   - expensiveLimiter: 30 per minute per IP. For endpoints that trigger
 *     outbound LLM calls or model discovery (real money on the line).
 *   - readLimiter: 600 per minute per IP. Generous default for GET routes.
 *
 * Keys are per-IP. In production behind a proxy, the `trust proxy` setting
 * in app.ts ensures req.ip reflects the real client.
 */

const standard = {
  standardHeaders: "draft-7" as const,
  legacyHeaders: false,
  validate: { trustProxy: false, ip: false },
};

export const loginLimiter = rateLimit({
  ...standard,
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: { error: "Too many login attempts. Try again later.", code: "RATE_LIMITED" },
  skipSuccessfulRequests: true,
});

export const signupLimiter = rateLimit({
  ...standard,
  windowMs: 60 * 60 * 1000,
  limit: 5,
  message: { error: "Too many signup attempts. Try again later.", code: "RATE_LIMITED" },
});

export const writeLimiter = rateLimit({
  ...standard,
  windowMs: 60 * 1000,
  limit: 60,
  message: { error: "Too many requests. Slow down.", code: "RATE_LIMITED" },
});

export const expensiveLimiter = rateLimit({
  ...standard,
  windowMs: 60 * 1000,
  limit: 30,
  message: { error: "Too many expensive requests. Slow down.", code: "RATE_LIMITED" },
});

export const readLimiter = rateLimit({
  ...standard,
  windowMs: 60 * 1000,
  limit: 600,
});
