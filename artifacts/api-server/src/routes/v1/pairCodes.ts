import { Router } from "express";
import { z } from "zod";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import {
  db,
  bosPairCodesTable,
} from "@workspace/db";
import {
  requireRole,
  type AuthenticatedUser,
} from "../../lib/security/auth.js";
import { appendLocalAgentAudit } from "../../lib/localAgent/auditChain.js";

/**
 * Pair-code minting for INDIVIDUAL_CONSENT pairing.
 *
 * Mints a short, single-use, time-bounded code that a super_admin
 * hands to a laptop user once. The reference agent presents that code
 * to `POST /api/v1/devices/register` to complete pairing. Only the
 * SHA-256 of the code is persisted; the plaintext is shown in the
 * response body exactly once and is never recoverable from the DB.
 *
 * Format: 4 letter + digit groups separated by dashes (e.g.
 * `ABCD-1234-EFGH-5678`) so it is comfortable to read out over a
 * phone call without ambiguous characters. ~83 bits of entropy.
 *
 * Default TTL: 15 minutes. We deliberately keep this short — pair
 * codes are a hot credential and the operator pattern is "mint, hand
 * off, register" inside a single sitting.
 */

const router = Router();
router.use(requireRole("super_admin"));

const MintBodySchema = z.object({
  ttl_minutes: z.number().int().min(1).max(60 * 24).optional(),
});

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1

function mintPlainCode(): string {
  // 16 chars from a 32-symbol alphabet → 16 * log2(32) = 80 bits.
  const buf = randomBytes(16);
  const groups: string[] = [];
  for (let i = 0; i < 4; i++) {
    let group = "";
    for (let j = 0; j < 4; j++) {
      group += ALPHABET[buf[i * 4 + j] % ALPHABET.length];
    }
    groups.push(group);
  }
  return groups.join("-");
}

router.post("/", async (req, res) => {
  const parsed = MintBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      code: "INPUT_ERROR",
      issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
    });
    return;
  }

  const user = (req as { user?: AuthenticatedUser }).user;
  if (!user) {
    res.status(401).json({ error: "Unauthenticated", code: "UNAUTHENTICATED" });
    return;
  }

  const ttlMinutes = parsed.data.ttl_minutes ?? 15;
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);

  const plain = mintPlainCode();
  const codeHash = createHash("sha256").update(plain).digest("hex");
  const id = randomUUID();

  await db.insert(bosPairCodesTable).values({
    id,
    code_hash: codeHash,
    created_by_user_id: user.id,
    expires_at: expiresAt,
  });

  await appendLocalAgentAudit({
    device_id: null,
    org_id: null,
    actor_user_id: user.id,
    event_type: "PAIR_CODE_MINTED",
    payload: {
      pair_code_id: id,
      ttl_minutes: ttlMinutes,
      expires_at: expiresAt.toISOString(),
    },
    is_critical: true,
  });

  res.status(201).json({
    id,
    pair_code: plain,
    expires_at: expiresAt.toISOString(),
  });
});

export default router;
