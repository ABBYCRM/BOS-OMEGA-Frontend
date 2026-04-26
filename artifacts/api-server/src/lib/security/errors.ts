import type { Request, Response, NextFunction } from "express";
import { logger } from "../logger.js";

/**
 * Global error handler. Sanitizes responses so internal stack traces, file
 * paths, and ORM errors are never leaked to clients. Real error details are
 * logged server-side with the request id for forensic correlation.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  const reqId = (req as { id?: string }).id ?? "unknown";
  logger.error({ err, reqId, path: req.path, method: req.method }, "Request failed");

  if (res.headersSent) {
    return;
  }

  // Honor explicit status codes set by middleware (e.g. rate-limit, auth)
  const status = res.statusCode && res.statusCode >= 400 ? res.statusCode : 500;
  res.status(status).json({
    error: status >= 500 ? "Internal server error" : "Request failed",
    code: "INTERNAL_ERROR",
    request_id: reqId,
  });
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
}
