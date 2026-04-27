/**
 * BOP.FRONT_DOOR.v1_PRODUCTION — Canon Governance Patch
 *
 * Inserts the front-door classification rule into the CANON memory layer
 * so it's part of the model's authoritative governance memory, not just
 * a hard-coded backend behaviour. Idempotent: re-runs on every boot but
 * only writes when the canon row is absent.
 *
 * Atomic with the feature: if you remove the front-door interpreter from
 * the pipeline, you should also remove (or update) this canon entry.
 */

import { db, memoryItemsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { logger } from "../lib/logger.js";

const CANON_TITLE = "BOS-OMEGA Front Door Classification Rule";
const CANON_AUTHORITY_LEVEL = 10;

const CANON_CONTENT = [
  "BOS-OMEGA must classify every incoming user input through the Front Door",
  "Interpreter BEFORE any Tri-State (GO/HOLD/ABORT) reasoning is performed.",
  "",
  "Routes and behaviour:",
  "  - GREETING        → friendly acknowledgement + example prompts; engine NOT invoked.",
  "  - EMPTY           → ask for input + example prompts; engine NOT invoked.",
  "  - UNDER_SPECIFIED → ask for missing object/context + examples; engine NOT invoked.",
  "  - LIKELY_NON_TASK → explain BOS scope + examples; engine NOT invoked.",
  "  - VALID_TASK      → forward to BOS reasoning engine.",
  "",
  "Safety rule: when classifier confidence is below 0.70, route to the",
  "BOS engine anyway. False blocking real work is worse than a slightly",
  "inefficient engine call.",
  "",
  "Only inputs the Front Door classifies as VALID_TASK (or low-confidence",
  "ambiguous) may reach Tri-State reasoning. The engine's HOLD verdicts",
  "are reserved for genuine task-shaped inputs that lack required context",
  "or fail validation — they must never be triggered by greetings or empty",
  "input.",
].join("\n");

export async function seedFrontDoorCanon(): Promise<void> {
  try {
    const existing = await db
      .select({ id: memoryItemsTable.id })
      .from(memoryItemsTable)
      .where(
        and(
          eq(memoryItemsTable.layer, "canon"),
          eq(memoryItemsTable.title, CANON_TITLE),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      logger.info({ id: existing[0]?.id }, "Front-door canon row already present; skipping seed");
      return;
    }

    const id = randomUUID();
    await db.insert(memoryItemsTable).values({
      id,
      user_id: null,
      layer: "canon",
      title: CANON_TITLE,
      content: CANON_CONTENT,
      authority_level: CANON_AUTHORITY_LEVEL,
    });
    logger.info({ id, title: CANON_TITLE }, "Front-door canon governance rule seeded");
  } catch (err) {
    // Non-fatal: the front door still functions in code. Log loudly so
    // operators can investigate.
    logger.error({ err }, "Front-door canon seed failed");
  }
}
