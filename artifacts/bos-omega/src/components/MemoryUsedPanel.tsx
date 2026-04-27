import { useState } from "react";
import { Link } from "wouter";
import { ChevronDown, ChevronRight, Brain, Loader2, ExternalLink, AlertCircle, Scissors } from "lucide-react";
import { useGetTaskMemoryContext, useListMemory } from "@workspace/api-client-react";

type AuditEntry = {
  id: string;
  event_type: string;
  message: string;
  metadata?: unknown;
  created_at: string | Date;
};

// Task #50: per-item provenance the orchestrator records on MEMORY_INJECTED.
// `id` is the memory_items.id at the moment of injection — we cross-reference
// it against the live useListMemory() response so deleted/edited rows are
// shown as "no longer available" instead of producing a broken link.
type InjectedItem = {
  id: string;
  layer: string;
  title: string;
};

type MemoryMeta = {
  canon_items?: number;
  continuity_items?: number;
  patches_items?: number;
  scratchpad_items?: number;
  // Task #51: per-layer dropped counts the orchestrator records on
  // MEMORY_INJECTED (added in Task #48). When > 0, the layer had ranked
  // items that did not fit its token budget — the panel uses these to
  // answer "why didn't the AI use my note?" in plain English.
  canon_dropped?: number;
  continuity_dropped?: number;
  patches_dropped?: number;
  scratchpad_dropped?: number;
  memory_context_chars?: number;
  section_headers?: string[];
  memory_context_preview?: string;
  injected_items?: InjectedItem[];
};

// Mirror of MEMORY_TOKEN_BUDGETS from
// artifacts/api-server/src/bos/memoryEngine.ts. Kept inline (rather than
// imported) because the API server is a separate artifact; if those values
// change there, update them here too. Tested values as of Task #51:
// canon=3000, continuity=1500, patches=1000, scratchpad=750.
const MEMORY_TOKEN_BUDGETS = {
  CANON: 3000,
  CONTINUITY: 1500,
  PATCHES: 1000,
  SCRATCHPAD: 750,
} as const;

const LAYER_PLAIN_NAME: Record<keyof typeof MEMORY_TOKEN_BUDGETS, string> = {
  CANON: "canon",
  CONTINUITY: "continuity",
  PATCHES: "patches",
  SCRATCHPAD: "scratchpad",
};

const LAYER_COLORS: Record<string, string> = {
  CANON: "text-amber-700",
  CONTINUITY: "text-blue-700",
  PATCHES: "text-purple-700",
  SCRATCHPAD: "text-green-700",
};

export function MemoryUsedPanel({
  audit,
  taskId,
}: {
  audit: AuditEntry[];
  // Task #49: when provided, the panel offers a "View full context" affordance
  // that lazy-loads the un-truncated memory_context from
  // GET /api/tasks/:id/memory-context. The fetch is gated by the same task
  // visibility filter as GET /api/tasks/:id, so the affordance is safe to
  // wire from any task page that already passed the visibility check.
  // Omitted in unit tests that exercise the rendering shell only.
  taskId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [showFull, setShowFull] = useState(false);

  // Find the orchestrator-level MEMORY_INJECTED event. Task #46's pipeline
  // emits exactly one per task today, but if a future re-run produces more
  // we want the most recent one so the panel stays consistent with the
  // backend `/memory-context` route, which orders by `created_at desc`.
  // findLast falls back to find() for any audit array shape; the audit
  // array is already created_at-ascending so the last match is the newest.
  const entry =
    [...audit].reverse().find((e) => e.event_type === "MEMORY_INJECTED");

  const meta: MemoryMeta =
    entry?.metadata && typeof entry.metadata === "object"
      ? (entry.metadata as MemoryMeta)
      : {};

  const injected: InjectedItem[] = Array.isArray(meta.injected_items)
    ? meta.injected_items.filter(
        (i): i is InjectedItem =>
          !!i &&
          typeof i === "object" &&
          typeof (i as InjectedItem).id === "string" &&
          typeof (i as InjectedItem).title === "string" &&
          typeof (i as InjectedItem).layer === "string",
      )
    : [];

  // Task #49: only fire the lazy fetch when the user has both opened the
  // panel AND clicked "View full context". Without the panel-open guard the
  // request would also be made for the collapsed state.
  const fullQuery = useGetTaskMemoryContext(taskId ?? "", {
    query: {
      queryKey: [`/api/tasks/${taskId}/memory-context`],
      enabled: !!taskId && open && showFull,
      retry: false,
      staleTime: 60_000,
    },
  });

  // Task #50: cross-reference injected ids against the live memory_items
  // list so we can mark deleted rows as "no longer available". Gated on
  // `open && injected.length > 0` so closed panels (and tasks recorded
  // before this task that have no injected_items) make zero extra requests.
  const liveMemoryQuery = useListMemory({
    query: {
      queryKey: ["/api/memory"],
      enabled: open && injected.length > 0,
      retry: false,
      staleTime: 60_000,
    },
  });
  const liveIds: Set<string> | null = liveMemoryQuery.data
    ? new Set(liveMemoryQuery.data.map((m) => m.id))
    : null;
  // Surface a small inline notice if the cross-reference itself failed,
  // so users know that "no longer available" markers may be missing —
  // we still render links optimistically rather than mass-flagging items.
  const liveLookupFailed =
    open && injected.length > 0 && liveMemoryQuery.isError;

  if (!entry) return null;

  const layers = [
    {
      key: "CANON" as const,
      count: meta.canon_items ?? 0,
      dropped: meta.canon_dropped ?? 0,
    },
    {
      key: "CONTINUITY" as const,
      count: meta.continuity_items ?? 0,
      dropped: meta.continuity_dropped ?? 0,
    },
    {
      key: "PATCHES" as const,
      count: meta.patches_items ?? 0,
      dropped: meta.patches_dropped ?? 0,
    },
    {
      key: "SCRATCHPAD" as const,
      count: meta.scratchpad_items ?? 0,
      dropped: meta.scratchpad_dropped ?? 0,
    },
  ];
  const total = layers.reduce((s, l) => s + l.count, 0);
  // Task #51: any layer with dropped > 0 means the orchestrator ranked
  // notes that didn't fit the per-layer token budget. Surface those so
  // users don't have to dig through audit JSON to answer "why didn't
  // the AI use my note?". Negative or non-numeric dropped values are
  // coerced to 0 above so this filter is safe.
  const droppedLayers = layers.filter((l) => l.dropped > 0);
  const headers = Array.isArray(meta.section_headers) ? meta.section_headers : [];
  const preview =
    typeof meta.memory_context_preview === "string" ? meta.memory_context_preview : "";
  const chars = typeof meta.memory_context_chars === "number" ? meta.memory_context_chars : 0;

  // The bounded preview is capped at 8000 chars in the pipeline. If the
  // recorded full size exceeds that, the preview is necessarily truncated
  // and the affordance is meaningful. If chars <= preview.length, the
  // preview already shows everything and we can hide the button to avoid
  // a no-op fetch.
  const previewIsTruncated = chars > preview.length;
  const fullText = fullQuery.data?.memory_context ?? null;
  const fullChars = fullQuery.data?.chars ?? null;
  const fullTruncated = fullQuery.data?.truncated ?? false;

  return (
    <div
      className="bg-card border border-card-border rounded-lg"
      data-testid="memory-used-panel"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="memory-used-panel-body"
        className="w-full flex items-center gap-3 p-4 text-left hover:bg-secondary/40 transition-colors rounded-lg"
        data-testid="memory-used-panel-toggle"
      >
        {open ? (
          <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
        )}
        <Brain className="w-4 h-4 text-primary flex-shrink-0" />
        <h3 className="text-[10px] font-mono text-muted-foreground tracking-wider">
          MEMORY USED
        </h3>
        <div className="ml-auto flex items-center gap-3 flex-wrap justify-end">
          {layers.map((l) => (
            <span key={l.key} className="font-mono text-[10px] text-muted-foreground">
              {l.key}:{" "}
              <span
                className={`font-bold ${
                  l.count > 0 ? LAYER_COLORS[l.key] : "text-muted-foreground"
                }`}
              >
                {l.count}
              </span>
            </span>
          ))}
          <span className="font-mono text-[10px] text-muted-foreground border-l border-border pl-3">
            {chars} chars
          </span>
          {/* Task #51: collapsed-state hint so users notice the dropped
              notice exists without having to expand the panel first. */}
          {droppedLayers.length > 0 && (
            <span
              className="font-mono text-[10px] text-amber-700 border-l border-border pl-3 inline-flex items-center gap-1"
              data-testid="memory-dropped-header-badge"
              title="Some stored notes ranked but didn't fit the budget"
            >
              <Scissors className="w-3 h-3" />
              {droppedLayers.reduce((s, l) => s + l.dropped, 0)} dropped
            </span>
          )}
        </div>
      </button>

      {open && (
        <div
          id="memory-used-panel-body"
          className="px-4 pb-4 space-y-4 border-t border-border pt-4"
          data-testid="memory-used-panel-body"
        >
          <div>
            <div className="text-[10px] font-mono text-muted-foreground tracking-wider mb-2">
              LAYERS
            </div>
            <div className="grid grid-cols-4 gap-2">
              {layers.map((l) => (
                <div
                  key={l.key}
                  className="border border-border bg-secondary rounded p-3 text-center"
                  data-testid={`memory-layer-${l.key.toLowerCase()}`}
                >
                  <div
                    className={`text-lg font-mono font-bold ${
                      l.count > 0 ? LAYER_COLORS[l.key] : "text-muted-foreground"
                    }`}
                  >
                    {l.count}
                  </div>
                  <div className="text-[10px] font-mono text-muted-foreground">
                    {l.key}
                  </div>
                </div>
              ))}
            </div>
            {total === 0 && (
              <div className="text-[11px] font-mono text-muted-foreground mt-2">
                No stored memory items were retrieved for this task.
              </div>
            )}
          </div>

          {/* Task #51: per-layer dropped notice. The orchestrator records
              how many ranked items were cut to fit each layer's token
              budget; surfacing that here answers "why didn't the AI use
              my note?" without forcing users into the audit JSON. The
              section is hidden entirely when no layer dropped anything,
              and is also hidden on legacy tasks recorded before Task #48
              shipped (their metadata has no *_dropped fields, which we
              coerce to 0 above). */}
          {droppedLayers.length > 0 && (
            <div
              className="rounded border border-amber-500/40 bg-amber-500/10 p-3"
              data-testid="memory-dropped-notice"
            >
              <div className="flex items-start gap-2">
                <Scissors className="w-4 h-4 text-amber-700 flex-shrink-0 mt-0.5" />
                <div className="space-y-1.5 text-[11px] font-mono text-foreground leading-snug">
                  <div className="font-bold text-amber-700">
                    Some of your stored notes didn't fit this task's memory budget.
                  </div>
                  <ul
                    className="list-disc pl-5 space-y-0.5"
                    data-testid="memory-dropped-list"
                  >
                    {droppedLayers.map((l) => (
                      <li
                        key={l.key}
                        data-testid={`memory-dropped-${l.key.toLowerCase()}`}
                      >
                        <span className={`font-bold ${LAYER_COLORS[l.key]}`}>
                          {l.dropped}
                        </span>{" "}
                        of your {LAYER_PLAIN_NAME[l.key]} note
                        {l.dropped === 1 ? "" : "s"} ranked but didn't fit
                        the {MEMORY_TOKEN_BUDGETS[l.key].toLocaleString()}-token{" "}
                        {LAYER_PLAIN_NAME[l.key]} budget for this task.
                      </li>
                    ))}
                  </ul>
                  <div className="text-muted-foreground pt-1">
                    Each memory layer has its own token budget — canon{" "}
                    {MEMORY_TOKEN_BUDGETS.CANON.toLocaleString()}, continuity{" "}
                    {MEMORY_TOKEN_BUDGETS.CONTINUITY.toLocaleString()}, patches{" "}
                    {MEMORY_TOKEN_BUDGETS.PATCHES.toLocaleString()}, scratchpad{" "}
                    {MEMORY_TOKEN_BUDGETS.SCRATCHPAD.toLocaleString()}.
                    Items are picked top-ranked first; anything that pushed a
                    layer over its budget was cut. Trim or merge lower-priority
                    notes in{" "}
                    <Link
                      href="/memory"
                      className="text-primary hover:underline"
                      data-testid="memory-dropped-manager-link"
                    >
                      Memory Manager
                    </Link>{" "}
                    to make room.
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Task #50: per-item provenance — each entry links to the source
              row in the Memory Manager. Items not present in the live list
              are rendered as "no longer available" instead of broken links.
              Hidden entirely on legacy tasks (recorded before #50) so the
              section doesn't show as empty next to a non-zero LAYERS grid. */}
          {injected.length > 0 && (
            <div>
              <div className="text-[10px] font-mono text-muted-foreground tracking-wider mb-2 flex items-center gap-2">
                <span>ITEMS INJECTED ({injected.length})</span>
                {liveLookupFailed && (
                  <span
                    className="not-italic text-amber-700 inline-flex items-center gap-1"
                    data-testid="memory-injected-lookup-failed"
                    title="Couldn't verify which items still exist; links may be stale"
                  >
                    <AlertCircle className="w-3 h-3" />
                    couldn't verify items
                  </span>
                )}
              </div>
              <ul
                className="space-y-1.5"
                data-testid="memory-injected-items"
              >
                {injected.map((item, i) => {
                  const layer_key = item.layer.toUpperCase();
                  const color =
                    LAYER_COLORS[layer_key] ?? "text-muted-foreground";
                  // Three states for the cross-reference:
                  //   - liveIds === null   → live list still loading (or
                  //     errored). Render a link optimistically; the Memory
                  //     Manager will simply not auto-scroll if the row is
                  //     gone, which is acceptable degradation.
                  //   - liveIds.has(id)    → row exists, link is safe.
                  //   - !liveIds.has(id)   → row was deleted after the task
                  //     ran. Render as plain "(no longer available)" text
                  //     so we don't ship a broken anchor.
                  const available = liveIds === null || liveIds.has(item.id);
                  return (
                    <li
                      key={`${item.id}-${i}`}
                      className="flex items-start gap-2 font-mono text-[11px] leading-snug"
                      data-testid={`memory-injected-item-${item.id}`}
                    >
                      <span
                        className={`shrink-0 w-[88px] uppercase tracking-wide ${color}`}
                      >
                        {layer_key}
                      </span>
                      {available ? (
                        <Link
                          href={`/memory#item-${item.id}`}
                          className="text-primary hover:underline inline-flex items-center gap-1 break-all"
                          data-testid={`memory-injected-link-${item.id}`}
                        >
                          <span>{item.title || "(untitled)"}</span>
                          <ExternalLink className="w-3 h-3 shrink-0" />
                        </Link>
                      ) : (
                        <span
                          className="text-muted-foreground italic inline-flex items-center gap-1 break-all"
                          data-testid={`memory-injected-missing-${item.id}`}
                          title="The source memory row was deleted after this task ran"
                        >
                          <AlertCircle className="w-3 h-3 shrink-0 text-amber-700" />
                          <span className="line-through">
                            {item.title || "(untitled)"}
                          </span>
                          <span className="not-italic text-[10px] text-amber-700">
                            no longer available
                          </span>
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <div>
            <div className="text-[10px] font-mono text-muted-foreground tracking-wider mb-2">
              SECTIONS RENDERED ({headers.length})
            </div>
            {headers.length > 0 ? (
              <div
                className="flex flex-wrap gap-1.5"
                data-testid="memory-section-headers"
              >
                {headers.map((h, i) => (
                  <span
                    key={`${h}-${i}`}
                    className="font-mono text-[10px] px-2 py-1 rounded border border-border bg-secondary text-foreground"
                  >
                    {h}
                  </span>
                ))}
              </div>
            ) : (
              <div className="text-[11px] font-mono text-muted-foreground">
                No sections rendered.
              </div>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] font-mono text-muted-foreground tracking-wider">
                {showFull ? "FULL CONTEXT" : "CONTEXT PREVIEW"}
                {!showFull && previewIsTruncated && (
                  <span className="ml-2 text-amber-700 normal-case tracking-normal">
                    (truncated to {preview.length} of {chars} chars)
                  </span>
                )}
                {showFull && fullTruncated && (
                  <span className="ml-2 text-amber-700 normal-case tracking-normal">
                    (legacy task — only the {preview.length}-char preview was stored)
                  </span>
                )}
              </div>
              {/* Affordance only renders when we have a taskId to fetch
                  against AND the preview is actually shorter than the
                  recorded full size. */}
              {taskId && previewIsTruncated && (
                showFull ? (
                  <button
                    type="button"
                    onClick={() => setShowFull(false)}
                    className="text-[10px] font-mono text-primary hover:underline"
                    data-testid="memory-context-show-preview"
                  >
                    SHOW PREVIEW
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setShowFull(true)}
                    className="text-[10px] font-mono text-primary hover:underline flex items-center gap-1"
                    data-testid="memory-context-view-full"
                  >
                    VIEW FULL CONTEXT
                  </button>
                )
              )}
            </div>
            {showFull ? (
              fullQuery.isLoading ? (
                <div
                  className="bg-secondary border border-border rounded p-3 text-[11px] font-mono text-muted-foreground flex items-center gap-2"
                  data-testid="memory-context-full-loading"
                >
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Loading full context...
                </div>
              ) : fullQuery.isError ? (
                <div
                  className="bg-red-500/10 border border-red-500/30 rounded p-3 text-[11px] font-mono text-red-700"
                  data-testid="memory-context-full-error"
                >
                  Failed to load full context. Showing preview instead.
                  <pre className="mt-2 whitespace-pre-wrap text-foreground">{preview}</pre>
                </div>
              ) : fullText ? (
                <pre
                  className="bg-secondary border border-border rounded p-3 text-[11px] font-mono text-foreground overflow-x-auto whitespace-pre-wrap max-h-96 overflow-y-auto"
                  data-testid="memory-context-full"
                >
                  {fullText}
                </pre>
              ) : (
                <div className="text-[11px] font-mono text-muted-foreground">
                  No context available.
                </div>
              )
            ) : preview ? (
              <pre
                className="bg-secondary border border-border rounded p-3 text-[11px] font-mono text-foreground overflow-x-auto whitespace-pre-wrap max-h-96 overflow-y-auto"
                data-testid="memory-context-preview"
              >
                {preview}
              </pre>
            ) : (
              <div className="text-[11px] font-mono text-muted-foreground">
                No preview available.
              </div>
            )}
            {showFull && fullText && fullChars !== null && (
              <div className="text-[10px] font-mono text-muted-foreground mt-2">
                Showing {fullText.length} of {fullChars} chars.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
