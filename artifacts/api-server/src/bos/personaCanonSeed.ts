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
  A: { title: "Legal Counsel", content: PERSONA_PROMPTS.legal },
  B: { title: "Engineer / Coder", content: PERSONA_PROMPTS.engineering },
  C: { title: "Cyber Analyst", content: PERSONA_PROMPTS.cyber },
};

/**
 * Idempotent seed: inserts only the slots that are missing. User edits are
 * never overwritten because we look up by deterministic id and skip rows
 * that already exist.
 */
export async function seedPersonaSlots(): Promise<void> {
  for (const slot of PERSONA_SLOTS) {
    const id = personaSlotId(slot);
    try {
      const existing = await db
        .select({ id: memoryItemsTable.id })
        .from(memoryItemsTable)
        .where(eq(memoryItemsTable.id, id))
        .limit(1);

      if (existing.length > 0) continue;

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
    } catch (err) {
      // Non-fatal: missing slots simply mean the corresponding button has
      // no overlay until an admin creates one via /api/personas.
      logger.error({ err, slot }, "Persona slot seed failed");
    }
  }
}
