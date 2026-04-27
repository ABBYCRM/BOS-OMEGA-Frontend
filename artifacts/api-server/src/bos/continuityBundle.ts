/**
 * Task #64 — Cross-AI continuity bundle.
 *
 * Pure functions (no DB, no Express) for building and parsing a
 * `bos-omega.continuity-bundle.v1` text artifact. The bundle is a
 * single self-contained text block scoped to ONE task or ONE
 * conversation that a user can:
 *
 *   (a) paste into another AI (ChatGPT / Claude / Gemini) — the
 *       receiving model reads the human-readable Markdown above the
 *       fenced JSON trailer and gets the same canon, persona, scratchpad
 *       and recent turns; OR
 *   (b) paste back into BOS-OMEGA — POST /api/continuity-bundle/import
 *       parses the embedded JSON envelope, recomputes the sha256
 *       fidelity hash, and rehydrates the scratchpad / continuity rows
 *       under the importer's user_id and creates a new "Imported …"
 *       conversation seeded with the prior turns.
 *
 * This is DELIBERATELY a different format from `MEMORY_LATTICE_V1`:
 *
 *   - Lattice is account-wide and JSON-heavy (the user's whole memory
 *     store + last 20 conversations).
 *   - Continuity bundles are thread-scoped and human-readable-first
 *     (the receiving AI is the primary consumer; the JSON trailer is
 *     a strict reconstruction aid).
 *
 * Layout:
 *   1. `BUNDLE_HEADER_PREAMBLE` (Markdown — explains intent to a
 *      receiving AI that knows nothing about BOS-OMEGA).
 *   2. Markdown sections in fixed order:
 *        ## Canon          (hash + summary lines)
 *        ## Persona Slot   (slot id + title + content; "(none)" when null)
 *        ## Layer Budgets  (token caps per layer)
 *        ## Scratchpad     (bullet list — pinned and auto rows)
 *        ## Continuity     (bullet list — relevance-ranked items)
 *        ## Conversation Turns
 *      Sections render even when empty so a receiving AI sees the
 *      structure consistently and a human can spot "scratchpad: empty".
 *   3. Closing fenced block:
 *        ```bos-omega.continuity-bundle.v1
 *        {pretty-printed JSON envelope}
 *        ```
 *      Pretty-printing is for human readability; the integrity hash is
 *      computed against a SEPARATE canonical-JSON serialization of the
 *      payload (sorted keys, no whitespace) with `fidelity_hash` field
 *      excluded:
 *
 *        FIDELITY_HASH = sha256(canonicalJSON(payload \ {fidelity_hash}))
 *
 *      The canonicalization rules (sort keys recursively, drop
 *      undefined object fields, preserve array order, no whitespace)
 *      MUST match `latticeFormat.canonicalJSON` exactly so we can
 *      re-use the proven helper.
 */

import { createHash } from "crypto";
import { z } from "zod";

// Strict structural validation for the parsed JSON envelope. Catches
// hash-valid-but-malformed payloads (e.g. `canon: null`, missing
// `budgets`, scratchpad row without `id`) BEFORE the import/preview
// routes start dereferencing nested fields. Without this guard a
// malformed bundle could pass `parseContinuityBundle` and crash the
// route with a 500, instead of returning a structured 400. We keep
// the schema permissive on optional fields (it accepts arbitrary
// extra keys) but strict on required nesting.
const BundleCanonSchema = z.object({
  hash: z.string().min(1),
  summary: z.string(),
  items_count: z.number().int().nonnegative(),
});
const BundlePersonaSlotSchema = z.object({
  slot: z.union([z.literal("A"), z.literal("B"), z.literal("C")]),
  title: z.string(),
  content: z.string(),
});
const BundleBudgetsSchema = z.object({
  canon: z.number().int().nonnegative(),
  continuity: z.number().int().nonnegative(),
  patches: z.number().int().nonnegative(),
  scratchpad: z.number().int().nonnegative(),
});
const BundleScratchpadItemSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  content: z.string(),
  authority_level: z.number().int(),
  source: z.string(),
  source_task_id: z.string().nullable(),
  created_at: z.string(),
});
const BundleContinuityItemSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  content: z.string(),
  authority_level: z.number().int(),
});
const BundleTurnSchema = z.object({
  task_id: z.string().min(1),
  created_at: z.string(),
  user_input: z.string(),
  assistant_output: z.string(),
  tri_state: z.string(),
  task_type: z.string(),
  mode: z.string(),
});
const ContinuityBundlePayloadSchema = z.object({
  format_version: z.string(),
  exported_at: z.string(),
  source_session_id: z.string(),
  scope: z.union([z.literal("task"), z.literal("conversation")]),
  task_id: z.string().nullable().optional(),
  conversation_id: z.string().nullable().optional(),
  conversation_title: z.string().nullable().optional(),
  canon: BundleCanonSchema,
  persona_slot: BundlePersonaSlotSchema.nullable(),
  budgets: BundleBudgetsSchema,
  scratchpad: z.array(BundleScratchpadItemSchema),
  continuity: z.array(BundleContinuityItemSchema),
  turns: z.array(BundleTurnSchema),
  fidelity_hash: z.string(),
}).passthrough();

/**
 * Recursive deterministic JSON serialization. Object keys are sorted at
 * every level; arrays preserve order; undefined fields are dropped; the
 * output has no whitespace. Duplicated from `latticeFormat.canonicalJSON`
 * verbatim (and pinned by the same contract tests in lattice_unit.mjs +
 * continuity_bundle_unit.mjs) so this module has ZERO internal imports
 * and can be exercised by the bare-node strip-types unit-test runner
 * without dragging the whole `@workspace/db` resolver chain in.
 */
export function canonicalJSON(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : "null";
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const parts = value.map((v) => canonicalJSON(v === undefined ? null : v));
    return `[${parts.join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(obj[k])}`);
    return `{${parts.join(",")}}`;
  }
  return "null";
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Compute the fidelity hash of a payload by stripping the
 * `fidelity_hash` field, canonicalizing, and hashing. Exported separately
 * so import verification uses the exact same code path as export production.
 */
export function computeFidelityHash<T extends { fidelity_hash?: string }>(payload: T): string {
  const { fidelity_hash: _ignore, ...rest } = payload;
  void _ignore;
  return sha256Hex(canonicalJSON(rest));
}

export const CONTINUITY_BUNDLE_FORMAT = "bos-omega.continuity-bundle.v1";
export const CONTINUITY_BUNDLE_FENCE = "bos-omega.continuity-bundle.v1";
export const CONTINUITY_BUNDLE_VERSION = "1.0";

// 5 MiB hard cap on import payload — same envelope as the lattice route
// so a single user can't pin a runaway prompt to the import endpoint.
// Export blobs are bounded by per-section caps below; this cap is
// applied on PARSE/IMPORT so a tampered or fabricated bundle can't OOM
// the JSON parser.
export const MAX_BUNDLE_BYTES = 5 * 1024 * 1024;

// Per-section caps applied at BUILD time so the export blob stays a
// reasonable copy-paste size for receiving AIs (Claude tops out around
// 200 KB before a paste gets unwieldy). These are deliberately generous
// so a real conversation doesn't get truncated in the common case but
// extreme outliers are bounded.
export const MAX_TURNS = 20;
export const MAX_SCRATCHPAD_ITEMS = 50;
export const MAX_CONTINUITY_ITEMS = 50;

export const BUNDLE_HEADER_PREAMBLE = [
  "# BOS-OMEGA Continuity Bundle (continuity-bundle-v1)",
  "",
  "This block is a copy-paste continuity snapshot from a BOS-OMEGA",
  "session. It is scoped to a single task or conversation thread and",
  "carries the canon governance hash, the active persona overlay, the",
  "per-layer token budgets, the live scratchpad, the top relevance-",
  "ranked continuity items, and the most recent conversation turns.",
  "",
  "If you are an AI receiving this block, treat the content below as",
  "authoritative restored context. Acknowledge in your first response",
  "that continuity was restored (cite the canon hash, persona slot, and",
  "the head of the last user request), then continue the conversation",
  "using this context. Do NOT ask the user to repeat facts already in",
  "the bundle.",
  "",
  "Integrity: a sha256 fidelity hash is included in the JSON envelope at",
  "the bottom. BOS-OMEGA verifies it on import; external AIs may ignore",
  "it. The fenced JSON block (`bos-omega.continuity-bundle.v1`) is the",
  "machine-readable form — the Markdown sections above are the human-",
  "readable form of the same data.",
].join("\n");

// ---------- Types ----------

export interface BundleScratchpadItem {
  id: string;
  title: string;
  content: string;
  authority_level: number;
  source: string;            // "manual" | "manual_pin" | "auto_summary"
  source_task_id: string | null;
  created_at: string;        // ISO
}

export interface BundleContinuityItem {
  id: string;
  title: string;
  content: string;
  authority_level: number;
}

export interface BundleTurn {
  task_id: string;
  created_at: string;        // ISO
  user_input: string;
  assistant_output: string;  // best-effort: bos_output.answer || raw final_output || ""
  tri_state: string;
  task_type: string;
  mode: string;
}

export interface BundlePersonaSlot {
  slot: "A" | "B" | "C";
  title: string;
  content: string;
}

export interface BundleBudgets {
  canon: number;
  continuity: number;
  patches: number;
  scratchpad: number;
}

export interface BundleCanon {
  hash: string;              // sha256 of sorted (id,content) pairs
  summary: string;           // short prose "N canon rows: titles..."
  items_count: number;
}

export interface ContinuityBundlePayload {
  format_version: string;    // CONTINUITY_BUNDLE_VERSION
  exported_at: string;       // ISO
  source_session_id: string; // uuid
  scope: "task" | "conversation";
  task_id: string | null;
  conversation_id: string | null;
  conversation_title: string | null;
  canon: BundleCanon;
  persona_slot: BundlePersonaSlot | null;
  budgets: BundleBudgets;
  scratchpad: BundleScratchpadItem[];
  continuity: BundleContinuityItem[];
  turns: BundleTurn[];
  fidelity_hash?: string;
}

export interface ContinuityBundleStats {
  scratchpad_count: number;
  continuity_count: number;
  turns_count: number;
  bytes: number;
  approx_tokens: number;
}

// ---------- Canon hash helper ----------

/**
 * Deterministic canon hash so a receiving AI (or BOS-OMEGA itself on
 * re-import) can verify "the canon governing this bundle is the same
 * canon governing the current session". Sorted by id so insertion
 * order doesn't perturb the hash.
 */
export interface CanonRow { id: string; title: string; content: string; }
export function computeCanonHash(rows: CanonRow[]): string {
  const sorted = [...rows].sort((a, b) => a.id.localeCompare(b.id));
  const blob = sorted.map((r) => `${r.id}\u0000${r.title}\u0000${r.content}`).join("\u0001");
  return sha256Hex(blob);
}

export function summarizeCanon(rows: CanonRow[]): string {
  if (rows.length === 0) return "(no canon rows loaded)";
  const titles = rows
    .slice()
    .sort((a, b) => a.title.localeCompare(b.title))
    .slice(0, 8)
    .map((r) => r.title);
  const more = rows.length > 8 ? `, +${rows.length - 8} more` : "";
  return `${rows.length} canon row${rows.length === 1 ? "" : "s"}: ${titles.join(", ")}${more}`;
}

// ---------- Build ----------

function inline(s: string): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}
function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function renderScratchpad(items: BundleScratchpadItem[]): string {
  if (items.length === 0) return "_(scratchpad is empty)_";
  return items
    .map((it) => {
      const tag = it.source === "manual_pin" ? "Pin" : it.source === "auto_summary" ? "Auto" : "Note";
      return `- **[${tag} | auth=${it.authority_level}]** ${inline(it.title)} — ${inline(it.content)}`;
    })
    .join("\n");
}

function renderContinuity(items: BundleContinuityItem[]): string {
  if (items.length === 0) return "_(no continuity items selected)_";
  return items
    .map((it) => `- **[${inline(it.title)} | auth=${it.authority_level}]** ${inline(it.content)}`)
    .join("\n");
}

function renderTurns(turns: BundleTurn[]): string {
  if (turns.length === 0) return "_(no recent turns)_";
  return turns
    .map((t, i) => {
      const idx = String(i + 1).padStart(2, "0");
      return [
        `### Turn ${idx} — ${t.task_id} (${t.task_type}/${t.tri_state}, ${t.created_at})`,
        `**User:** ${inline(t.user_input)}`,
        "",
        `**Assistant:** ${inline(t.assistant_output) || "_(no answer recorded)_"}`,
      ].join("\n");
    })
    .join("\n\n");
}

function renderPersona(p: BundlePersonaSlot | null): string {
  if (!p) return "_(no persona slot active)_";
  return [
    `**Slot ${p.slot}** — ${inline(p.title)}`,
    "",
    "```",
    p.content.trim(),
    "```",
  ].join("\n");
}

function renderBudgets(b: BundleBudgets): string {
  return [
    `- canon: **${b.canon}** tokens`,
    `- continuity: **${b.continuity}** tokens`,
    `- patches: **${b.patches}** tokens`,
    `- scratchpad: **${b.scratchpad}** tokens`,
  ].join("\n");
}

function renderCanon(c: BundleCanon): string {
  return [
    `- **hash:** \`${c.hash}\``,
    `- **rows loaded:** ${c.items_count}`,
    `- **summary:** ${inline(c.summary)}`,
  ].join("\n");
}

export interface BuildContinuityBundleResult {
  blob: string;
  hash: string;
  byte_size: number;
  payload: ContinuityBundlePayload;   // includes fidelity_hash
  stats: ContinuityBundleStats;
}

/**
 * Build the human + machine bundle. Caps section sizes per the
 * MAX_* constants so the blob stays paste-friendly even when the
 * source thread is very long.
 */
export function buildContinuityBundle(
  inputPayload: Omit<ContinuityBundlePayload, "fidelity_hash" | "format_version">,
): BuildContinuityBundleResult {
  // Cap arrays at build time. Order is preserved so callers can sort
  // upstream (most-recent-first for turns is the convention).
  const scratchpad = inputPayload.scratchpad.slice(0, MAX_SCRATCHPAD_ITEMS);
  const continuity = inputPayload.continuity.slice(0, MAX_CONTINUITY_ITEMS);
  const turns = inputPayload.turns.slice(0, MAX_TURNS);

  const payload: ContinuityBundlePayload = {
    ...inputPayload,
    format_version: CONTINUITY_BUNDLE_VERSION,
    scratchpad,
    continuity,
    turns,
  };
  const hash = computeFidelityHash(payload);
  const sealed = { ...payload, fidelity_hash: hash };

  const sections = [
    BUNDLE_HEADER_PREAMBLE,
    "",
    `## Canon`,
    renderCanon(payload.canon),
    "",
    `## Persona Slot`,
    renderPersona(payload.persona_slot),
    "",
    `## Layer Budgets`,
    renderBudgets(payload.budgets),
    "",
    `## Scratchpad (${scratchpad.length} item${scratchpad.length === 1 ? "" : "s"})`,
    renderScratchpad(scratchpad),
    "",
    `## Continuity (${continuity.length} item${continuity.length === 1 ? "" : "s"})`,
    renderContinuity(continuity),
    "",
    `## Conversation Turns (last ${turns.length})`,
    renderTurns(turns),
    "",
    "## Machine-readable trailer",
    "",
    "```" + CONTINUITY_BUNDLE_FENCE,
    JSON.stringify(sealed, null, 2),
    "```",
    "",
  ];

  const blob = sections.join("\n");
  const byte_size = Buffer.byteLength(blob, "utf8");
  const approx_tokens = Math.ceil(byte_size / 4);

  return {
    blob,
    hash,
    byte_size,
    payload: sealed,
    stats: {
      scratchpad_count: scratchpad.length,
      continuity_count: continuity.length,
      turns_count: turns.length,
      bytes: byte_size,
      approx_tokens,
    },
  };
}

// ---------- Parse ----------

export class BundleParseError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "BundleParseError";
    this.code = code;
  }
}

export interface ParsedContinuityBundle {
  payload: ContinuityBundlePayload;   // includes fidelity_hash from envelope
  recomputed_hash: string;
  hash_ok: boolean;
}

const FENCE_RE = new RegExp(
  "```" + CONTINUITY_BUNDLE_FENCE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\n([\\s\\S]*?)\\n```",
);

export function parseContinuityBundle(input: string): ParsedContinuityBundle {
  if (typeof input !== "string") {
    throw new BundleParseError("BUNDLE_NOT_STRING", "bundle input must be a string");
  }
  const bytes = Buffer.byteLength(input, "utf8");
  if (bytes > MAX_BUNDLE_BYTES) {
    throw new BundleParseError(
      "BUNDLE_TOO_LARGE",
      `bundle exceeds ${MAX_BUNDLE_BYTES} bytes (got ${bytes})`,
    );
  }

  const match = input.match(FENCE_RE);
  if (!match || !match[1]) {
    throw new BundleParseError(
      "BUNDLE_NO_FENCE",
      `No \`${CONTINUITY_BUNDLE_FENCE}\` fenced JSON block found in bundle`,
    );
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(match[1]);
  } catch (err) {
    throw new BundleParseError(
      "BUNDLE_BAD_JSON",
      `JSON envelope is malformed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new BundleParseError("BUNDLE_BAD_SHAPE", "JSON envelope must be an object");
  }
  const obj = envelope as Record<string, unknown>;

  if (obj["format_version"] !== CONTINUITY_BUNDLE_VERSION) {
    throw new BundleParseError(
      "BUNDLE_UNSUPPORTED_VERSION",
      `Unsupported continuity bundle format_version: ${String(obj["format_version"])} (expected ${CONTINUITY_BUNDLE_VERSION})`,
    );
  }

  const fidelity_hash = obj["fidelity_hash"];
  if (typeof fidelity_hash !== "string" || !/^[a-f0-9]{64}$/.test(fidelity_hash)) {
    throw new BundleParseError(
      "BUNDLE_NO_HASH",
      "JSON envelope is missing valid fidelity_hash (expected 64-char sha256 hex)",
    );
  }

  // Validate required structural fields. We deliberately do NOT
  // sanity-check every nested item shape here — that's the import
  // route's job (it has to enforce per-row defaults like authority_level
  // anyway). The parser's contract is "is this a v1 bundle with a valid
  // hash" — semantic field validation happens in the importer.
  for (const required of ["scope", "canon", "budgets", "scratchpad", "continuity", "turns"]) {
    if (!(required in obj)) {
      throw new BundleParseError(
        "BUNDLE_MISSING_FIELD",
        `JSON envelope is missing required field: ${required}`,
      );
    }
  }
  const scope = obj["scope"];
  if (scope !== "task" && scope !== "conversation") {
    throw new BundleParseError(
      "BUNDLE_BAD_SCOPE",
      `JSON envelope scope must be "task" or "conversation" (got ${String(scope)})`,
    );
  }
  for (const arrField of ["scratchpad", "continuity", "turns"] as const) {
    if (!Array.isArray(obj[arrField])) {
      throw new BundleParseError(
        "BUNDLE_BAD_FIELD_TYPE",
        `JSON envelope field "${arrField}" must be an array`,
      );
    }
  }

  // Strict structural validation. The earlier presence/array checks
  // are deliberately retained for stable error codes on the most
  // common malformations, but they don't cover nested object shape
  // (e.g. `canon: null`, `budgets: { canon: "x" }`, scratchpad row
  // missing `id`). Without this Zod pass, a hash-valid-but-malformed
  // bundle would slip through to preview/import where the routes
  // dereference `payload.canon.hash` etc and 500. Refuse loudly with
  // a structured 400 instead.
  const validated = ContinuityBundlePayloadSchema.safeParse(obj);
  if (!validated.success) {
    const issues = validated.error.issues.slice(0, 3).map((i) => {
      const path = i.path.length > 0 ? i.path.join(".") : "(root)";
      return `${path}: ${i.message}`;
    }).join("; ");
    throw new BundleParseError(
      "BUNDLE_BAD_SHAPE",
      `JSON envelope failed structural validation: ${issues}`,
    );
  }

  const recomputed = computeFidelityHash(obj);
  return {
    payload: validated.data as ContinuityBundlePayload,
    recomputed_hash: recomputed,
    hash_ok: recomputed === fidelity_hash,
  };
}

// ---------- Diff helper for Rehydrate preview ----------

export interface BundlePreview {
  scope: "task" | "conversation";
  hash_ok: boolean;
  recomputed_hash: string;
  declared_hash: string;
  canon_hash: string;
  canon_match: boolean | null;       // null if local canon hash is unavailable
  persona_slot: BundlePersonaSlot | null;
  budgets: BundleBudgets;
  counts: {
    scratchpad: number;
    continuity: number;
    turns: number;
  };
  conflicts: {
    /** scratchpad ids that already exist locally (will overwrite on import) */
    scratchpad_overwrites: string[];
    /** continuity ids that already exist locally (will overwrite on import) */
    continuity_overwrites: string[];
  };
  byte_size: number;
}

export function previewContinuityBundle(
  parsed: ParsedContinuityBundle,
  byte_size: number,
  opts: {
    /** Hash of the importer's currently loaded canon, if available. */
    local_canon_hash?: string | null;
    /** Set of memory_item ids already owned by the importer so the UI
     *  can warn before overwriting. Empty set is fine — diff reports zero
     *  conflicts and the import becomes a pure insert. */
    existing_scratchpad_ids?: Set<string>;
    existing_continuity_ids?: Set<string>;
  } = {},
): BundlePreview {
  const p = parsed.payload;
  const existingS = opts.existing_scratchpad_ids ?? new Set<string>();
  const existingC = opts.existing_continuity_ids ?? new Set<string>();
  return {
    scope: p.scope,
    hash_ok: parsed.hash_ok,
    recomputed_hash: parsed.recomputed_hash,
    declared_hash: p.fidelity_hash ?? "",
    canon_hash: p.canon.hash,
    canon_match: opts.local_canon_hash == null ? null : opts.local_canon_hash === p.canon.hash,
    persona_slot: p.persona_slot,
    budgets: p.budgets,
    counts: {
      scratchpad: p.scratchpad.length,
      continuity: p.continuity.length,
      turns: p.turns.length,
    },
    conflicts: {
      scratchpad_overwrites: p.scratchpad.filter((it) => existingS.has(it.id)).map((it) => it.id),
      continuity_overwrites: p.continuity.filter((it) => existingC.has(it.id)).map((it) => it.id),
    },
    byte_size,
  };
}
