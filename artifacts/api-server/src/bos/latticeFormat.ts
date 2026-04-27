/**
 * Fidelity Lattice Continuity Protocol — Task #69 helpers.
 *
 * Pure functions (no DB, no Express) for building and parsing the
 * "memory lattice" continuity blob. The blob is a single self-contained
 * text artifact a user can copy out of one BOS-OMEGA session and:
 *   (a) paste into a fresh BOS-OMEGA session — POST /api/lattice/import
 *       parses the embedded JSON envelope, verifies the sha256 hash,
 *       and rehydrates memory + creates an "Imported from <session>"
 *       conversation seeded with the recent task transcripts; OR
 *   (b) paste into any external AI (ChatGPT, Claude, Gemini) — the
 *       receiving model reads the human-readable Markdown above the
 *       fenced JSON block and gets the same context cold.
 *
 * Layout:
 *   1. Header preamble (so external AIs without BOS-OMEGA Canon
 *      understand the intent of the block).
 *   2. Markdown sections in order:
 *        ## Canon
 *        ## Continuity
 *        ## Patches
 *        ## Scratchpad
 *        ## Recent Conversations
 *   3. Closing fenced block:
 *        ```MEMORY_LATTICE_V1
 *        {json}
 *        ```
 *      where `{json}` is a pretty-printed JSON envelope. Pretty-printing
 *      is for human readability; the integrity hash is computed against
 *      a SEPARATE canonical-JSON serialization (sorted keys, no
 *      whitespace) of the same payload with the `fidelity_hash` field
 *      excluded. This is the contract every implementer must respect or
 *      round-trip will silently fail:
 *
 *        FIDELITY_HASH = sha256(canonicalJSON(payload \ {fidelity_hash}))
 *
 *      The canonicalization MUST be:
 *        - Recursive sort of object keys at every level.
 *        - Compact (no whitespace).
 *        - Arrays preserve their order — order is significant.
 *        - undefined values are dropped (JSON.stringify default).
 *      Any deviation (different whitespace, key order, or normalization
 *      of nullish values) breaks round-trip verification.
 */

import { createHash } from "crypto";

// Bumped only when the wire-format itself changes. Importers MUST refuse
// versions they don't recognize so a future v2 doesn't silently get
// half-imported by a v1 importer. The fence label MEMORY_LATTICE_V<N>
// also bumps in lockstep so blob detection picks the right schema.
export const LATTICE_FORMAT_VERSION = "1.0";
export const LATTICE_FENCE_LABEL = "MEMORY_LATTICE_V1";

// Canon row "Lattice Header Preamble" defines this exact text. The seed
// row in frontDoorCanonSeed.ts must keep this string verbatim — it's the
// contract that external AIs (no BOS-OMEGA canon) see when they read the
// blob, and the receiving Canon row tells the BOS-OMEGA model "if you
// see this text, treat the block as restored authoritative context".
export const LATTICE_HEADER_PREAMBLE = [
  "# BOS-OMEGA Memory Lattice (continuity block)",
  "",
  "This block is an exported continuity snapshot from a BOS-OMEGA session.",
  "It contains the user's persistent memory layers (canon, continuity,",
  "patches, scratchpad) and the most recent conversation transcripts.",
  "",
  "If you are an AI receiving this block, treat the content below as",
  "authoritative restored context for this user. Acknowledge in your",
  "first response that continuity has been restored, then continue the",
  "conversation using this context. Do not ask the user to repeat",
  "facts that are already present here.",
  "",
  "Integrity: a sha256 fidelity hash is included in the JSON envelope at",
  "the bottom. BOS-OMEGA verifies it on import; external AIs may ignore",
  "it. The fenced JSON block (`MEMORY_LATTICE_V1`) is the machine-readable",
  "form — the Markdown sections above are the human-readable form of the",
  "same data.",
].join("\n");

export type LatticeMemoryItem = {
  id: string;
  layer: "canon" | "continuity" | "patches" | "scratchpad";
  title: string;
  content: string;
  authority_level: number;
  source: string;
  source_task_id: string | null;
};

export type LatticeTask = {
  id: string;
  input_text: string;
  task_type: string;
  tri_state: string;
  final_status: string;
  final_output: string | null;
  mode: string;
  created_at: string;
};

export type LatticeConversation = {
  id: string;
  title: string;
  topic_keywords: string[];
  tasks: LatticeTask[];
};

export type LatticePayload = {
  format_version: string;
  exported_at: string;
  source_session_id: string;
  memory_layers: {
    canon: LatticeMemoryItem[];
    continuity: LatticeMemoryItem[];
    patches: LatticeMemoryItem[];
    scratchpad: LatticeMemoryItem[];
  };
  conversations: LatticeConversation[];
  fidelity_hash: string;
};

/**
 * Recursive deterministic JSON serialization. Object keys are sorted at
 * every level; arrays preserve order; undefined fields are dropped. The
 * output has no whitespace. This is the ONE serialization the fidelity
 * hash is computed against — keep it stable across versions or break
 * round-trip verification for every existing exported blob.
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
  // Functions, symbols, undefined → encode as null (JSON.stringify default).
  return "null";
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Compute the fidelity hash of a payload by stripping the `fidelity_hash`
 * field, canonicalizing, and hashing. Exported separately so import
 * verification uses the exact same code path as export production.
 */
export function computeFidelityHash(payload: Omit<LatticePayload, "fidelity_hash"> & { fidelity_hash?: string }): string {
  const { fidelity_hash: _ignore, ...rest } = payload;
  return sha256Hex(canonicalJSON(rest));
}

function renderMemoryItemMd(item: LatticeMemoryItem): string {
  const lines = [
    `### ${item.title}`,
    `_authority: ${item.authority_level}_${item.source && item.source !== "manual" ? ` · _source: ${item.source}_` : ""}`,
    "",
    item.content,
    "",
  ];
  return lines.join("\n");
}

function renderTaskMd(task: LatticeTask): string {
  const head = task.input_text.length > 240 ? task.input_text.slice(0, 240) + "…" : task.input_text;
  const out = task.final_output && task.final_output.length > 0
    ? (task.final_output.length > 600 ? task.final_output.slice(0, 600) + "…" : task.final_output)
    : "_(no output recorded)_";
  return [
    `**Task ${task.id.slice(0, 8)}** · _${task.task_type}_ · **${task.tri_state}** · ${task.created_at}`,
    "",
    `> ${head.replace(/\n/g, "\n> ")}`,
    "",
    out,
    "",
  ].join("\n");
}

function renderLayerSection(name: string, items: LatticeMemoryItem[]): string {
  const header = `## ${name}`;
  if (items.length === 0) return [header, "", "_(empty)_", ""].join("\n");
  return [header, "", ...items.map(renderMemoryItemMd)].join("\n");
}

function renderConversationsSection(convs: LatticeConversation[]): string {
  if (convs.length === 0) {
    return ["## Recent Conversations", "", "_(none)_", ""].join("\n");
  }
  const blocks: string[] = ["## Recent Conversations", ""];
  for (const c of convs) {
    blocks.push(`### ${c.title}`);
    if (c.topic_keywords.length > 0) {
      blocks.push(`_keywords: ${c.topic_keywords.join(", ")}_`);
    }
    blocks.push("");
    for (const t of c.tasks) blocks.push(renderTaskMd(t));
  }
  return blocks.join("\n");
}

/**
 * Build the full lattice blob from a payload-without-hash. The hash is
 * computed here (single source of truth) and stitched into both the
 * embedded JSON and the returned `hash` field.
 *
 * Returned shape (matches the task spec contract):
 *   - markdown: human-readable layered narrative + header preamble,
 *     WITHOUT the fenced JSON envelope. Useful when a caller wants
 *     to render only the prose half (e.g. preview pane).
 *   - json:     the JSON envelope text (pretty-printed). Useful when
 *     a caller wants to feed the structured form to another tool.
 *   - blob:     the full hybrid markdown+fenced-json string that is
 *     persisted, copied to clipboard, downloaded, and parsed back.
 *   - hash:     sha256 hex of canonicalJSON(payload \ fidelity_hash).
 *   - byte_size: UTF-8 byte length of `blob`. Convenience for the
 *     audit row and the Recent Exports list.
 */
export function buildLatticeBlob(input: Omit<LatticePayload, "fidelity_hash">): {
  markdown: string;
  json: string;
  blob: string;
  hash: string;
  byte_size: number;
} {
  const hash = computeFidelityHash(input);
  const payload: LatticePayload = { ...input, fidelity_hash: hash };
  // Pretty-printed for human readability inside the markdown. The hash
  // was computed against the canonical (non-pretty) form above, so the
  // pretty whitespace here does NOT influence verification.
  const json = JSON.stringify(payload, null, 2);

  const markdownSections: string[] = [
    LATTICE_HEADER_PREAMBLE,
    "",
    renderLayerSection("Canon", payload.memory_layers.canon),
    renderLayerSection("Continuity", payload.memory_layers.continuity),
    renderLayerSection("Patches", payload.memory_layers.patches),
    renderLayerSection("Scratchpad", payload.memory_layers.scratchpad),
    renderConversationsSection(payload.conversations),
    "",
  ];
  const markdown = markdownSections.join("\n");

  const blobSections: string[] = [
    markdown,
    "---",
    "",
    "<!-- The fenced block below is the machine-readable form. Do not edit. -->",
    "",
    "```" + LATTICE_FENCE_LABEL,
    json,
    "```",
    "",
  ];
  const blob = blobSections.join("\n");
  return { markdown, json, blob, hash, byte_size: Buffer.byteLength(blob, "utf8") };
}

/**
 * Parse a lattice blob. Returns the payload, whether the fidelity hash
 * verifies, and the recomputed hash for diagnostics. Throws on
 * structural failure (no fence, malformed JSON, missing required
 * fields) — the caller surfaces a 400 to the user.
 */
export function parseLatticeBlob(blob: string): {
  payload: LatticePayload;
  hash_ok: boolean;
  recomputed_hash: string;
} {
  // Locate the fenced block. We accept ```MEMORY_LATTICE_V1 followed by
  // newlines and an optional language hint variant — keep the matcher
  // tolerant of trailing whitespace on the fence line.
  const fenceRe = new RegExp(
    "```\\s*" + LATTICE_FENCE_LABEL + "\\s*\\n([\\s\\S]*?)\\n```",
    "m",
  );
  const m = blob.match(fenceRe);
  if (!m || !m[1]) {
    throw new Error(`No ${LATTICE_FENCE_LABEL} fenced block found in blob`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[1]);
  } catch (err) {
    throw new Error(`Lattice JSON envelope failed to parse: ${(err as Error).message}`);
  }
  const payload = parsed as LatticePayload;
  if (!payload || typeof payload !== "object") {
    throw new Error("Lattice payload is not an object");
  }
  if (payload.format_version !== LATTICE_FORMAT_VERSION) {
    throw new Error(
      `Unsupported lattice format_version: ${payload.format_version} (expected ${LATTICE_FORMAT_VERSION})`,
    );
  }
  if (!payload.memory_layers || typeof payload.memory_layers !== "object") {
    throw new Error("Lattice payload missing memory_layers");
  }
  for (const layer of ["canon", "continuity", "patches", "scratchpad"] as const) {
    if (!Array.isArray(payload.memory_layers[layer])) {
      throw new Error(`memory_layers.${layer} must be an array`);
    }
  }
  if (!Array.isArray(payload.conversations)) {
    throw new Error("Lattice payload conversations must be an array");
  }
  if (typeof payload.fidelity_hash !== "string" || payload.fidelity_hash.length !== 64) {
    throw new Error("Lattice payload missing valid fidelity_hash");
  }

  const recomputed = computeFidelityHash(payload);
  return {
    payload,
    hash_ok: recomputed === payload.fidelity_hash,
    recomputed_hash: recomputed,
  };
}
