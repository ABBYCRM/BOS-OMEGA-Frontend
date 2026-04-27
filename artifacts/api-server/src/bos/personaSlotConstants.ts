/**
 * BOP.PERSONA_SLOTS.v1 — pure constants and id helper for the three persona
 * overlay slots (A, B, C).
 *
 * Lives in its own no-deps module so unit tests (which run via the bare
 * `node --experimental-strip-types` loader and cannot resolve the
 * @workspace/db schema directory) can import these directly. The seed and
 * route modules re-export them.
 */

export const PERSONA_SLOTS = ["A", "B", "C"] as const;
export type PersonaSlot = (typeof PERSONA_SLOTS)[number];

export const PERSONA_LAYER = "persona";
export const PERSONA_AUTHORITY_LEVEL = 8;

/** Deterministic id used for upsert + slot lookup. Stable contract — the
 *  seed's idempotency relies on it producing the same id every boot. */
export function personaSlotId(slot: PersonaSlot): string {
  return `persona_slot_${slot.toLowerCase()}`;
}
