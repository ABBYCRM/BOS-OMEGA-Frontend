import { Router } from "express";
import { z } from "zod";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  bosOrgsTable,
  bosDevicesTable,
  bosPairCodesTable,
} from "@workspace/db";
import { appendLocalAgentAudit } from "../../lib/localAgent/auditChain.js";
import { evaluateInstallModeChange } from "@workspace/local-agent-policy";
import {
  InstallModeSchema,
  type InstallMode,
} from "@workspace/local-agent-contracts";

/**
 * Device registration. Two install modes — see
 * `docs/local-automation-agent/enterprise-config.md`:
 *
 *   - `INDIVIDUAL_CONSENT` (default): the operator types a 6-char pair
 *     code surfaced in bos-omega → Local Agent → Pairing. The pair-
 *     code redemption surface itself is owned by Task #23; this route
 *     only validates the install_mode shape and persists the row in
 *     the org-aware schema.
 *
 *   - `ADMIN_DEPLOYMENT`: the agent presents an org enrollment secret
 *     read from `agent.config.json`. The server hashes the secret and
 *     looks it up against `bos_orgs.enrollment_secret_hash`. On match
 *     the device is permanently bound to the org.
 *
 * This endpoint is public on purpose — it is the front door for new
 * devices. Abuse is bounded by the existing per-IP write rate limiter
 * applied at the parent router level. A real production deployment
 * SHOULD additionally front this with a network ACL when serving
 * managed fleets.
 */

const router = Router();

const RegisterBodySchema = z.object({
  install_mode: InstallModeSchema,
  pair_code: z.string().min(4).max(64).optional(),
  org_enrollment_secret: z.string().min(32).max(512).optional(),
  device_pubkey: z.string().min(32).max(4096),
  display_name: z.string().min(1).max(200),
  hostname: z.string().min(1).max(255).optional(),
  contract_version: z.string().min(1).max(32),
});

router.post("/register", async (req, res) => {
  const parsed = RegisterBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      code: "INPUT_ERROR",
      issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
    });
    return;
  }

  // The query-string copy of install_mode lets MDM authors point at a
  // canonical URL per mode without having to template the body. The
  // body is still authoritative — if both are present they must match.
  const queryMode = req.query["install_mode"];
  if (typeof queryMode === "string") {
    const q = InstallModeSchema.safeParse(queryMode);
    if (!q.success || q.data !== parsed.data.install_mode) {
      res.status(400).json({
        error: "install_mode query and body disagree",
        code: "INSTALL_MODE_MISMATCH",
      });
      return;
    }
  }

  const installMode: InstallMode = parsed.data.install_mode;

  // Enforce the install-mode change guard at the gateway: a device key
  // that previously paired as ADMIN_DEPLOYMENT cannot re-pair as
  // INDIVIDUAL_CONSENT. The reverse direction (individual → admin) is
  // allowed and represents a personal install joining a managed fleet.
  const [existingByKey] = await db
    .select()
    .from(bosDevicesTable)
    .where(eq(bosDevicesTable.device_pubkey, parsed.data.device_pubkey))
    .limit(1);
  if (existingByKey) {
    const guard = evaluateInstallModeChange(
      existingByKey.install_mode as InstallMode,
      installMode,
    );
    if (guard.kind === "rejected") {
      await appendLocalAgentAudit({
        device_id: existingByKey.id,
        org_id: existingByKey.org_id,
        actor_user_id: null,
        event_type: "DEVICE_INSTALL_MODE_CHANGE_DENIED",
        payload: {
          from: existingByKey.install_mode,
          to: installMode,
          reason: guard.reason,
        },
        is_critical: true,
      });
      res.status(403).json({ error: guard.detail, code: guard.reason });
      return;
    }
  }

  let orgId: string | null = null;
  if (installMode === "ADMIN_DEPLOYMENT") {
    if (!parsed.data.org_enrollment_secret) {
      res.status(400).json({
        error: "org_enrollment_secret is required for ADMIN_DEPLOYMENT",
        code: "ENROLLMENT_SECRET_REQUIRED",
      });
      return;
    }
    const hash = createHash("sha256").update(parsed.data.org_enrollment_secret).digest("hex");
    const [org] = await db
      .select()
      .from(bosOrgsTable)
      .where(eq(bosOrgsTable.enrollment_secret_hash, hash))
      .limit(1);
    if (!org) {
      // No targeted info leak — same shape regardless of why.
      res.status(401).json({
        error: "Enrollment secret rejected",
        code: "ENROLLMENT_SECRET_REJECTED",
      });
      return;
    }
    if (org.status !== "active") {
      res.status(403).json({
        error: "Org is not active",
        code: "ORG_NOT_ACTIVE",
      });
      return;
    }
    orgId = org.id;

    // Tenancy boundary: an already-paired device that was previously
    // bound to an org cannot be rebound to a different org by re-
    // registering with a different secret. Admin-deployed devices are
    // permanently org-bound; legitimate moves require an out-of-band
    // privileged migration (not exposed on this public route).
    if (existingByKey && existingByKey.org_id && existingByKey.org_id !== orgId) {
      await appendLocalAgentAudit({
        device_id: existingByKey.id,
        org_id: existingByKey.org_id,
        actor_user_id: null,
        event_type: "DEVICE_INSTALL_MODE_CHANGE_DENIED",
        payload: {
          attempted_org_id: orgId,
          current_org_id: existingByKey.org_id,
          reason: "ORG_REBIND_FORBIDDEN",
        },
        is_critical: true,
      });
      res.status(403).json({
        error: "Device is already bound to a different org",
        code: "ORG_REBIND_FORBIDDEN",
      });
      return;
    }
  } else {
    // INDIVIDUAL_CONSENT path: a super_admin must have minted a pair
    // code in the Local Agent UI (POST /api/v1/pair-codes) and handed
    // the plaintext to the laptop user. We hash the presented code,
    // look it up, and atomically mark it consumed to defeat parallel
    // redemption races.
    if (!parsed.data.pair_code) {
      res.status(400).json({
        error: "pair_code is required for INDIVIDUAL_CONSENT",
        code: "PAIR_CODE_REQUIRED",
      });
      return;
    }
    const codeHash = createHash("sha256")
      .update(parsed.data.pair_code)
      .digest("hex");
    const consumedAt = new Date();
    const claimResult = await db
      .update(bosPairCodesTable)
      .set({
        consumed_at: consumedAt,
        consumed_by_device_id: existingByKey?.id ?? null,
      })
      .where(
        and(
          eq(bosPairCodesTable.code_hash, codeHash),
          isNull(bosPairCodesTable.consumed_at),
        ),
      )
      .returning({
        id: bosPairCodesTable.id,
        expires_at: bosPairCodesTable.expires_at,
      });
    const claimed = claimResult[0];
    if (!claimed) {
      // Either no such code, already consumed, or already expired
      // before we got here. Return the same shape regardless to avoid
      // a probing oracle.
      res.status(401).json({
        error: "Pair code rejected",
        code: "PAIR_CODE_REJECTED",
      });
      return;
    }
    if (claimed.expires_at <= consumedAt) {
      // Race: we won the consume but the row was already past its
      // expiry. Surface the same opaque error to the caller; the row
      // stays consumed (single-use), so it cannot be re-tried.
      res.status(401).json({
        error: "Pair code rejected",
        code: "PAIR_CODE_REJECTED",
      });
      return;
    }
  }

  const id = existingByKey?.id ?? randomUUID();
  // Mint a fresh per-device HMAC signing secret on every (re-)pair.
  // This rotates the secret on re-registration, returning the new
  // value to the caller exactly once. Persisted as plaintext for now
  // (Task #22 will wrap with at-rest encryption + key rotation).
  const signingSecret = randomBytes(32).toString("hex");
  if (existingByKey) {
    await db
      .update(bosDevicesTable)
      .set({
        org_id: orgId ?? existingByKey.org_id,
        install_mode: installMode,
        display_name: parsed.data.display_name,
        hostname: parsed.data.hostname ?? existingByKey.hostname,
        contract_version: parsed.data.contract_version,
        signing_secret: signingSecret,
        last_seen_at: new Date(),
      })
      .where(eq(bosDevicesTable.id, id));
  } else {
    await db.insert(bosDevicesTable).values({
      id,
      org_id: orgId,
      install_mode: installMode,
      display_name: parsed.data.display_name,
      hostname: parsed.data.hostname ?? null,
      device_pubkey: parsed.data.device_pubkey,
      signing_secret: signingSecret,
      paired_by_user_id: null,
      contract_version: parsed.data.contract_version,
      status: "active",
    });
  }

  await appendLocalAgentAudit({
    device_id: id,
    org_id: orgId,
    actor_user_id: null,
    event_type: "DEVICE_PAIRED",
    payload: {
      install_mode: installMode,
      display_name: parsed.data.display_name,
      hostname: parsed.data.hostname ?? null,
      contract_version: parsed.data.contract_version,
      reused_existing_key: !!existingByKey,
    },
    is_critical: true,
  });

  res.status(201).json({
    device_id: id,
    org_id: orgId,
    install_mode: installMode,
    // Returned exactly once. The agent must persist this in its
    // OS-protected state file; subsequent calls are signed with it.
    signing_secret: signingSecret,
  });
});

export default router;
