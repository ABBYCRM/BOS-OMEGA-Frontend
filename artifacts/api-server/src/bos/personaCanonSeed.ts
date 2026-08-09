/**
 * BOP.PERSONA_SLOTS.v1 — three editable persona overlays as canon-style memory rows.
 *
 * Three reserved slots A/B/C live in `memory_items` with layer="persona".
 * Each row's `title` is the user-facing button label and `content` is the
 * prompt overlay applied to every model call when that slot is selected.
 * The user can rename a slot or rewrite its purpose at any time via the
 * /api/personas route — defaults are only inserted when the slot is absent,
 * so user edits survive every restart.
 *
 * Defaults mirror the original hardcoded Legal/Engineer/Cyber overlays so
 * existing behaviour is preserved on first boot.
 */

import { db, memoryItemsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { PERSONA_PROMPTS } from "../providers/prompts.js";
import {
  PERSONA_SLOTS,
  PERSONA_LAYER,
  PERSONA_AUTHORITY_LEVEL,
  personaSlotId,
  type PersonaSlot,
} from "./personaSlotConstants.js";

// Re-export the pure constants so existing imports (routes, pipeline) keep
// working without churn while unit tests can pull them from the no-deps
// module directly.
export {
  PERSONA_SLOTS,
  PERSONA_LAYER,
  PERSONA_AUTHORITY_LEVEL,
  personaSlotId,
  type PersonaSlot,
};

interface SlotDefault {
  title: string;
  content: string;
}

const SLOT_DEFAULTS: Record<PersonaSlot, SlotDefault> = {
  // 2026-08-09: each persona got the 'lens not cage' rule. If the task
  // isn't actually a [legal/engineering/security] question, the persona
  // answers the task directly without producing a generic skeleton
  // structured for a different domain. See artifacts/api-server/src/
  // providers/prompts.ts for the source-of-truth copy that mirrors this.
  A: { title: "Legal Counsel", content: PERSONA_PROMPTS.legal },
  B: { title: "Engineer / Coder", content: PERSONA_PROMPTS.engineering },
  C: { title: "Cyber Analyst", content: PERSONA_PROMPTS.cyber },
};

/**
 * Idempotent seed: inserts only the slots that are missing. User edits are
 * never overwritten because we look up by deterministic id and skip rows
 * that already exist.
 *
 * 2026-08-09: added a one-shot migration that detects installs whose
 * persona content still contains the old 'lens-not-cage' prefix was
 * missing. The check is a substring test on the persona's `content`
 * field — if it doesn't contain the lens-not-cage marker, the row is
 * overwritten with the current SLOT_DEFAULTS. This runs once per boot
 * per affected slot (idempotent on subsequent boots once the marker
 * is present).
 */
const PERSONA_LENS_NOT_CAGE_MARKER = "lens, not a cage";
const PERSONA_CONTENT_VERSION = "2026-08-09-lens-not-cage-v1";

export async function seedPersonaSlots(): Promise<void> {
  for (const slot of PERSONA_SLOTS) {
    const id = personaSlotId(slot);
    try {
      const existing = await db
        .select({ id: memoryItemsTable.id, content: memoryItemsTable.content })
        .from(memoryItemsTable)
        .where(eq(memoryItemsTable.id, id))
        .limit(1);

      if (existing.length === 0) {
        const def = SLOT_DEFAULTS[slot];
        await db.insert(memoryItemsTable).values({
          id,
          user_id: null,
          layer: PERSONA_LAYER,
          title: def.title,
          content: def.content,
          authority_level: PERSONA_AUTHORITY_LEVEL,
        });
        logger.info({ id, slot, title: def.title }, "Persona slot seeded");
        continue;
      }

      // 2026-08-09 migration: if the existing content doesn't carry
      // the lens-not-cage marker, the row predates the rule that
      // prevents persona hijacking. Overwrite with the current default
      // so a fresh boot brings installs up to date without a manual
      // PATCH.
      const cur = existing[0]!;
      if (!cur.content.includes(PERSONA_LENS_NOT_CAGE_MARKER)) {
        const def = SLOT_DEFAULTS[slot];
        await db
          .update(memoryItemsTable)
          .set({ title: def.title, content: def.content, updated_at: new Date() })
          .where(eq(memoryItemsTable.id, id));
        logger.info(
          { id, slot, marker: PERSONA_CONTENT_VERSION },
          "Persona slot migrated to lens-not-cage default",
        );
      }
    } catch (err) {
      // Non-fatal: missing slots simply mean the corresponding button has
      // no overlay until an admin creates one via /api/personas.
      logger.error({ err, slot }, "Persona slot seed failed");
    }
  }
}
