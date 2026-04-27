// BOP.PERSONA_SLOTS.v1 — persona-overlay text formatter.
//
// The pipeline resolves the active persona slot row (memory_items, layer
// "persona") to a {title, content} pair, then wraps them in a deterministic
// header so every model call sees an unambiguous, single context pass that
// composes with — never replaces — the BOS Master Prompt Kernel.
//
// Pure (no IO, no DB, no env): unit-testable via the bare strip-types loader.

export interface PersonaOverlayInput {
  title: string;
  content: string;
}

/**
 * Wrap a persona slot's title + content as the DOMAIN PERSONA overlay
 * appended after the master prompt. Returns "" when content is empty so
 * callers can fall back to the legacy persona id without a special case.
 */
export function buildPersonaOverlay(input: PersonaOverlayInput | null | undefined): string {
  if (!input) return "";
  const title = input.title.trim();
  const content = input.content.trim();
  if (content.length === 0) return "";
  const header = title.length > 0 ? title.toUpperCase() : "UNTITLED";
  return `\n\n=== DOMAIN PERSONA: ${header} ===\n${content}`;
}
