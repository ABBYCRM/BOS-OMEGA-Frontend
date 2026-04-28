import { Router, type Request, type Response } from "express";
import { createHash } from "crypto";
import { runPowerShell } from "../tools/runPowerShell.js";
import { requireRole } from "../lib/security/auth.js";
import { auditLog } from "../bos/auditEngine.js";
import { logger } from "../lib/logger.js";

const powershellRouter = Router();

// Hard cap on the command string size we'll accept. PowerShell scripts
// fit well inside this; anything bigger is almost certainly an attempt
// to dump a binary payload through the endpoint.
const MAX_COMMAND_BYTES = 4 * 1024;

/**
 * POST /api/powershell — host PowerShell execution endpoint.
 *
 * Security posture (matches the rest of the platform):
 *
 *   1. Mounted *under* the `/api` requireAuth gate in routes/index.ts,
 *      so anonymous callers never reach this handler.
 *   2. Additionally gated to `super_admin` only. Regular `admin` users
 *      cannot run host commands.
 *   3. Opt-in via the `POWERSHELL_ENDPOINT_ENABLED` env flag — the
 *      surface is OFF by default. Operators must consciously turn it
 *      on by setting the flag in their environment.
 *   4. Every invocation (success and failure) is written to the audit
 *      chain with the actor user_id, role, IP, and a hashed command
 *      summary so the SOC2-ready audit trail captures host activity.
 *   5. Command body is capped at 4 KB. Output buffer is capped at 1 MB
 *      and the wall-clock timeout is 30 s (enforced by runPowerShell).
 *
 * Body: { "command": "<powershell expression>" }
 * Response: { "output": "<stdout>" } on success.
 */
powershellRouter.use(requireRole("super_admin"));

powershellRouter.post("/", async (req: Request, res: Response) => {
  if (process.env.POWERSHELL_ENDPOINT_ENABLED !== "1") {
    res.status(404).json({
      error: "PowerShell endpoint is disabled in this environment",
      code: "POWERSHELL_DISABLED",
      hint: "Set POWERSHELL_ENDPOINT_ENABLED=1 in the environment to enable.",
    });
    return;
  }

  const command = (req.body ?? {}).command;
  if (!command || typeof command !== "string" || !command.trim()) {
    res.status(400).json({
      error: "Missing or invalid `command` string",
      code: "INVALID_BODY",
    });
    return;
  }
  if (Buffer.byteLength(command, "utf8") > MAX_COMMAND_BYTES) {
    res.status(413).json({
      error: `Command exceeds ${MAX_COMMAND_BYTES}-byte cap`,
      code: "COMMAND_TOO_LARGE",
    });
    return;
  }

  const actor = req.user!;
  const ip = req.ip ?? "unknown";
  const command_bytes = Buffer.byteLength(command, "utf8");
  // Truncated preview (120 chars) for human-readable scanning, plus a
  // SHA-256 of the full command so the audit row can be deterministically
  // matched against an external command corpus during a forensic review
  // without ever persisting the raw bytes.
  const command_preview =
    command.length > 120 ? command.slice(0, 117) + "..." : command;
  const command_sha256 = createHash("sha256").update(command, "utf8").digest("hex");

  try {
    const output = await runPowerShell(command);
    const output_bytes = Buffer.byteLength(output, "utf8");
    void auditLog(undefined, "POWERSHELL_EXECUTED", `super_admin ran PowerShell command`, {
      actor_user_id: actor.id,
      actor_email: actor.email,
      role: actor.role,
      ip,
      command_preview,
      command_sha256,
      command_bytes,
      output_bytes,
      outcome: "ok",
    });
    logger.info(
      { uid: actor.id, ip, event: "POWERSHELL_EXECUTED", command_bytes, output_bytes },
      "PowerShell command executed",
    );
    res.json({ output });
    return;
  } catch (err) {
    // Generic, redacted failure surface: never persist or return raw
    // command output. runPowerShell is contracted to throw only
    // category-level messages (timeout / overflow / exit code / no
    // binary), so the audit row + HTTP body carry only that, plus the
    // SHA-256 + preview for forensic correlation.
    const raw = err instanceof Error ? err.message : "PowerShell execution failed";
    const safeMessage = raw.replace(/\s+/g, " ").trim().slice(0, 200);
    void auditLog(undefined, "POWERSHELL_FAILED", `PowerShell command rejected`, {
      actor_user_id: actor.id,
      actor_email: actor.email,
      role: actor.role,
      ip,
      command_preview,
      command_sha256,
      command_bytes,
      outcome: "error",
      error: safeMessage,
    });
    logger.warn(
      { uid: actor.id, ip, event: "POWERSHELL_FAILED", command_bytes, err: safeMessage },
      "PowerShell command failed",
    );
    res.status(500).json({ error: safeMessage, code: "POWERSHELL_FAILED" });
    return;
  }
});

export default powershellRouter;
