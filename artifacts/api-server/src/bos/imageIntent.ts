/**
 * Task #83 — image-generation intent detection.
 *
 * Pure helper used by `pipeline.ts` to decide whether a user's prompt
 * should be routed to the image provider bridge instead of the standard
 * text execution engines. The detector is deliberately CONSERVATIVE:
 *
 *   - Requires both an explicit creation verb (generate/create/draw/...)
 *     AND an image noun (image/picture/photo/...) within a short window.
 *   - Refuses to match if the verb is "describe", "summarize", "edit",
 *     "find", "search", "translate", etc. — those route to the text
 *     engines so we don't intercept questions ABOUT images.
 *   - Borderline cases (e.g. "I want a picture of...") fall through to
 *     text. False negatives degrade gracefully (the model can answer in
 *     text and tell the user how to phrase the request); false positives
 *     would silently swallow a question into the image path with a
 *     useless rendering.
 *
 * The detector also extracts an optional size hint (landscape / portrait
 * / square) and surfaces the matched phrase so the audit chain can
 * explain why a given input was routed.
 */

export type GenerationSize = "1024x1024" | "1536x1024" | "1024x1536";

export interface ImageIntent {
  /** True when the input matched the strict generate-image grammar. */
  is_image_generation: boolean;
  /** Original input text — also used as the image-model prompt. */
  prompt: string;
  /** Verb+noun phrase that matched, recorded for audit attribution. */
  matched_phrase?: string;
  /** Cleaned subject of the request (post-verb, post-noun, post-connector). */
  cleaned_subject?: string;
  /** Pre-resolved size: defaults to square; bumps to landscape/portrait on hint. */
  size: GenerationSize;
}

// Verbs that unambiguously request CREATION of new visual content.
// "edit", "modify", "describe", "summarize", "find", "search", "show",
// "list", "load", "upload", "open", "save", "send" are intentionally
// excluded — they request OTHER actions on images.
const CREATION_VERBS = [
  "generate",
  "create",
  "draw",
  "render",
  "make",
  "design",
  "illustrate",
  "sketch",
  "produce",
  "paint",
  "compose",
  "imagine",
];

// Nouns that unambiguously refer to an output image. Plural forms covered
// by the trailing `s?` in the regex; words like "video", "audio", "code",
// "diagram" are intentionally NOT here — they belong to other modalities
// (video gen / code gen / etc.) which are explicitly out of Task #83 scope.
const IMAGE_NOUNS = [
  "image",
  "picture",
  "photo",
  "photograph",
  "illustration",
  "drawing",
  "painting",
  "sketch",
  "logo",
  "icon",
  "artwork",
  "render",
  "rendering",
  "scene",
  "thumbnail",
  "wallpaper",
  "poster",
  "banner",
  "portrait", // a "portrait of X" is unambiguously an image artifact
];

// Optional connector words allowed between verb and noun. Keeping this
// list tight prevents "create a list of pictures" from matching (no
// "list" connector → no match).
const CONNECTOR_TOKENS = [
  "an?", // a / an
  "the",
  "me",
  "us",
  "some",
  "one",
  "two",
  "three",
  "four",
  "five",
  // Adjective slot — short closed list of common style/quality adjectives so
  // "render a beautiful logo" matches but "render a list" does not.
  "nice",
  "cool",
  "cute",
  "simple",
  "detailed",
  "realistic",
  "cartoon",
  "anime",
  "abstract",
  "minimalist",
  "modern",
  "vintage",
  "professional",
  "high[- ]?quality",
  "beautiful",
  "stunning",
  "small",
  "large",
  "wide",
  "tall",
  "square",
  "landscape",
  "portrait",
  "color(?:ful)?",
  "black[- ]?and[- ]?white",
  // Explicit aspect-ratio tokens like "16:9", "9x16", "4 : 3" — accepted
  // as a connector so prompts like "render a 16:9 banner image" parse.
  "\\d+\\s*[:x]\\s*\\d+",
];

const CONNECTOR_GROUP =
  `(?:${CONNECTOR_TOKENS.join("|")})`;

const VERB_GROUP = `(?:${CREATION_VERBS.join("|")})`;
const NOUN_GROUP = `(?:${IMAGE_NOUNS.join("|")})`;

// Verb, then up to FOUR connector tokens (so "make me a beautiful detailed
// realistic painting" still matches), then the noun (singular or plural).
// `\b` boundaries on both ends prevent partial-word matches
// ("regenerate" ≠ "generate"; "imagery" ≠ "image").
const INTENT_REGEX = new RegExp(
  `\\b${VERB_GROUP}\\b\\s+(?:${CONNECTOR_GROUP}\\s+){0,4}${NOUN_GROUP}s?\\b`,
  "i",
);

// Words that, when present anywhere in the prompt, force a text route
// even if a verb+noun phrase matched. These are EDIT or DESCRIBE
// intents the image-generation path cannot serve.
const NEGATIVE_CONTEXT = [
  /\bedit\s+(?:my|the|this|that)\s+\w*(?:image|picture|photo|portrait|painting|drawing|illustration|artwork|banner|logo|icon)/i,
  /\bdescribe\s+(?:this|the|my|that)\s+\w*(?:image|picture|photo|portrait|painting|drawing|illustration|artwork|banner|logo|icon)/i,
  /\bsummarize\s+(?:this|the|my|that)\s+\w*(?:image|picture|photo|portrait|painting|drawing|illustration|artwork|banner|logo|icon)/i,
  /\bwhat[' ]?s\s+(?:in|on)\s+(?:this|the|my|that)\s+\w*(?:image|picture|photo|portrait|painting|drawing|illustration|artwork|banner|logo|icon)/i,
  /\bremove\s+(?:the\s+)?background/i,
];

/**
 * Detect whether `input` is a request to GENERATE a new image.
 * Returns a stable shape regardless of outcome so callers can reference
 * `result.size` etc. without conditional access.
 */
export function detectImageIntent(input: string): ImageIntent {
  const text = (input ?? "").trim();
  const fallback: ImageIntent = {
    is_image_generation: false,
    prompt: text,
    size: "1024x1024",
  };
  if (!text) return fallback;

  for (const neg of NEGATIVE_CONTEXT) {
    if (neg.test(text)) return fallback;
  }

  const m = text.match(INTENT_REGEX);
  if (!m) return fallback;

  const matched_phrase = m[0];
  const idx = text.toLowerCase().indexOf(matched_phrase.toLowerCase());
  let remainder = text.slice(idx + matched_phrase.length).trim();
  remainder = remainder
    .replace(/^(?:of|for|showing|that\s+shows|depicting|with|featuring|about)\s+/i, "")
    .replace(/[.!?]+$/g, "")
    .trim();

  // Size hint extraction. Order matters: explicit aspect ratios beat
  // the looser "wide"/"tall" adjectives so a prompt like "render a tall
  // 16:9 banner" lands on landscape (the explicit ratio wins).
  let size: GenerationSize = "1024x1024";
  if (/\b(?:16\s*[:x]\s*9|landscape|wide|widescreen|banner|horizontal)\b/i.test(text)) {
    size = "1536x1024";
  } else if (/\b(?:9\s*[:x]\s*16|portrait|tall|vertical|story)\b/i.test(text)) {
    size = "1024x1536";
  }

  return {
    is_image_generation: true,
    prompt: text,
    matched_phrase,
    cleaned_subject: remainder.length > 0 ? remainder : text,
    size,
  };
}
