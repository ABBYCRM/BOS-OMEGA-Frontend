import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";
import { seed } from "./db/seed.js";
import { seedSuperAdminIfEmpty, ensureOwnerSuperAdmin } from "./lib/security/auth.js";
import { errorHandler, notFoundHandler } from "./lib/security/errors.js";

const app: Express = express();

// Behind the Replit proxy — req.ip should be the real client, not 127.0.0.1
app.set("trust proxy", 1);

// HTTP security headers (CSP, HSTS, X-Frame-Options, X-Content-Type-Options, etc.)
// Defaults are aggressive — appropriate for a JSON API with no inline scripts.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: "same-site" },
    referrerPolicy: { policy: "no-referrer" },
    hsts: { maxAge: 15552000, includeSubDomains: true, preload: false },
  }),
);

// CORS: same-origin only by default. Operators can opt into a strict allowlist
// via ALLOWED_ORIGINS (comma-separated). No wildcards, no credentials with `*`.
const allowedOriginsRaw = process.env["ALLOWED_ORIGINS"] ?? "";
const allowedOrigins = allowedOriginsRaw
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
app.use(
  cors({
    origin(origin, cb) {
      // Same-origin requests have no Origin header — allow.
      if (!origin) return cb(null, true);
      if (allowedOrigins.length === 0) return cb(null, false);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// 1mb body cap — generous for JSON, tight enough to deny memory-exhaustion abuse.
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

app.use("/api", router);

app.use(notFoundHandler);
app.use(errorHandler);

// Seed providers/models first so the users-table seed runs against a fully
// migrated DB. Both seeds are awaited via bootstrap() so callers (index.ts)
// can hold off on listening until the super-admin row exists. This
// guarantees the very first authenticated request can never race the
// "if users empty, create super_admin" check.
export async function bootstrap(): Promise<void> {
  try {
    await seed();
  } catch (err) {
    logger.error({ err }, "Seed failed");
  }
  try {
    await seedSuperAdminIfEmpty();
  } catch (err) {
    logger.fatal({ err }, "Super-admin seed failed");
    process.exit(1);
  }
  // Owner default super_admin: re-asserted on every boot so the owner can
  // never be locked out, regardless of what's in the users table. Failures
  // here fail boot for the same reason as the seed above — silent skip
  // defeats the always-on guarantee.
  try {
    await ensureOwnerSuperAdmin();
  } catch (err) {
    logger.fatal({ err }, "Owner super_admin upsert failed");
    process.exit(1);
  }
}

export default app;
