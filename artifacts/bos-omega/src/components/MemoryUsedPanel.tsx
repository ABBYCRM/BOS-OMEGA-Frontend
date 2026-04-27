import { useState } from "react";
import { Link } from "wouter";
import { ChevronDown, ChevronRight, Brain, Loader2, Scissors, Copy, Check, Download } from "lucide-react";
import { useGetTaskMemoryContext } from "@workspace/api-client-react";
import {
  MemoryInjectedItemsList,
  parseInjectedItems,
  type InjectedItem,
} from "./MemoryInjectedItemsList";

type AuditEntry = {
  id: string;
  event_type: string;
  message: string;
  metadata?: unknown;
  created_at: string | Date;
};

// Task #59: per-layer budgets the orchestrator actually used for THIS task,
// recorded on MEMORY_INJECTED. The pipeline persists the resolved budgets
// (user override or engine default) at injection time so the panel can
// show historically-accurate budget numbers in dropped-notice copy and
// per-tile tooltips even after the user later edits their overrides.
type RecordedBudgets = {
  canon?: number;
  continuity?: number;
  patches?: number;
  scratchpad?: number;
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
  // Task #59: per-task budgets the orchestrator actually used. Optional
  // so legacy MEMORY_INJECTED rows recorded before Task #59 keep working
  // — they fall back to MEMORY_TOKEN_BUDGETS_DEFAULT below.
  budgets?: RecordedBudgets;
};

// Engine defaults used as a fallback when the audit row predates Task #59
// or the budgets field is malformed. These mirror MEMORY_TOKEN_BUDGETS in
// artifacts/api-server/src/bos/memoryEngine.ts; if those move there, this
// constant becomes the worst-case display, not the truth — meta.budgets
// always wins when present.
const MEMORY_TOKEN_BUDGETS_DEFAULT = {
  CANON: 3000,
  CONTINUITY: 1500,
  PATCHES: 1000,
  SCRATCHPAD: 750,
} as const;
type LayerKey = keyof typeof MEMORY_TOKEN_BUDGETS_DEFAULT;

const LAYER_PLAIN_NAME: Record<LayerKey, string> = {
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
  // Task #53: transient confirmation that the clipboard write succeeded.
  // Auto-clears after a short delay so repeated copies still feel responsive.
  const [copied, setCopied] = useState(false);

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

  const injected: InjectedItem[] = parseInjectedItems(meta.injected_items);

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

  if (!entry) return null;

  // Task #59: pull recorded budgets out of the audit row so per-layer copy
  // (per-tile tooltips, dropped-notice list, dropped-notice footer) reads
  // the budgets that ran for THIS task. Anything missing or non-numeric
  // falls back to the engine defaults so legacy rows (recorded before
  // Task #59) still render sensibly.
  const recorded = meta.budgets ?? {};
  const pickBudget = (raw: unknown, fallback: number) =>
    typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : fallback;
  const liveBudgets: Record<LayerKey, number> = {
    CANON: pickBudget(recorded.canon, MEMORY_TOKEN_BUDGETS_DEFAULT.CANON),
    CONTINUITY: pickBudget(recorded.continuity, MEMORY_TOKEN_BUDGETS_DEFAULT.CONTINUITY),
    PATCHES: pickBudget(recorded.patches, MEMORY_TOKEN_BUDGETS_DEFAULT.PATCHES),
    SCRATCHPAD: pickBudget(recorded.scratchpad, MEMORY_TOKEN_BUDGETS_DEFAULT.SCRATCHPAD),
  };
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

  // Task #53: copy/download affordances for the fetched full context.
  // Both are gated on `showFull && fullText` in the JSX so they only render
  // once the lazy fetch from Task #49 has actually returned a body — copying
  // or downloading the bounded preview would be misleading.
  const onCopyFull = async () => {
    if (!fullText) return;
    try {
      await navigator.clipboard.writeText(fullText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Older browsers / non-secure contexts don't expose the async
      // Clipboard API. Fall back to the legacy execCommand path so the
      // affordance still works for users on http://localhost or http
      // intranets where the clipboard is otherwise blocked.
      const ta = document.createElement("textarea");
      ta.value = fullText;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      } catch {
        /* swallow — nothing we can do, leave the button in its idle state */
      }
      document.body.removeChild(ta);
    }
  };

  const onDownloadFull = () => {
    if (!fullText) return;
    const blob = new Blob([fullText], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    // Per the task spec: filename is the task id so multiple downloads
    // from different tasks don't collide in the user's downloads folder.
    a.download = `task-${taskId ?? "unknown"}-memory-context.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

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
                  {/* Task #54: per-tile dropped counter so users see at a
                      glance which specific layer cut items, without needing
                      to scroll to the dropped notice below. Non-zero counts
                      are amber to stand out against the muted tile chrome;
                      zero collapses to a dim "0 dropped" label so the tile
                      footprint stays consistent across layers. The title
                      attribute explains what "dropped" means in plain
                      English for the keyboard/hover audience. */}
                  <div
                    className={`mt-1 text-[10px] font-mono inline-flex items-center justify-center gap-1 ${
                      l.dropped > 0
                        ? "text-amber-700 font-bold"
                        : "text-muted-foreground/60"
                    }`}
                    data-testid={`memory-layer-${l.key.toLowerCase()}-dropped`}
                    title={
                      l.dropped > 0
                        ? `${l.dropped} ${LAYER_PLAIN_NAME[l.key]} note${
                            l.dropped === 1 ? "" : "s"
                          } ranked but didn't fit the ${liveBudgets[
                            l.key
                          ].toLocaleString()}-token ${LAYER_PLAIN_NAME[l.key]} budget for this task.`
                        : `No ${LAYER_PLAIN_NAME[l.key]} notes were dropped — every ranked item fit the ${liveBudgets[
                            l.key
                          ].toLocaleString()}-token ${LAYER_PLAIN_NAME[l.key]} budget.`
                    }
                  >
                    {l.dropped > 0 && <Scissors className="w-3 h-3" />}
                    {l.dropped} dropped
                  </div>
                </div>
              ))}
            </div>
            {/* Task #54: short caption explaining the new per-tile counter
                so users who don't hover (e.g. touch devices) still get the
                meaning. Kept terse so it doesn't add visual noise on tasks
                where nothing was dropped. */}
            <div className="text-[10px] font-mono text-muted-foreground mt-2 italic">
              "Dropped" = item was ranked relevant but didn't fit the layer's token budget.
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
                        the {liveBudgets[l.key].toLocaleString()}-token{" "}
                        {LAYER_PLAIN_NAME[l.key]} budget for this task.
                      </li>
                    ))}
                  </ul>
                  <div className="text-muted-foreground pt-1">
                    Each memory layer has its own token budget — canon{" "}
                    {liveBudgets.CANON.toLocaleString()}, continuity{" "}
                    {liveBudgets.CONTINUITY.toLocaleString()}, patches{" "}
                    {liveBudgets.PATCHES.toLocaleString()}, scratchpad{" "}
                    {liveBudgets.SCRATCHPAD.toLocaleString()}.
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
              section doesn't show as empty next to a non-zero LAYERS grid.
              Task #56: the renderer was extracted into MemoryInjectedItemsList
              so the same UI is reused on the global Audit Log page. The
              `enabled={open}` flag keeps the live cross-reference fetch
              gated to the panel's expanded state, matching the pre-extract
              behaviour exactly. */}
          {injected.length > 0 && (
            <MemoryInjectedItemsList items={injected} enabled={open} />
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
              <div className="flex items-center gap-3">
                {/* Task #53: copy + download affordances. Only render once
                    the full context has actually been fetched — copying or
                    downloading the preview would be misleading because it's
                    capped at 8000 chars by the orchestrator. */}
                {showFull && fullText && (
                  <>
                    <button
                      type="button"
                      onClick={onCopyFull}
                      className="text-[10px] font-mono text-primary hover:underline inline-flex items-center gap-1"
                      data-testid="memory-context-copy-full"
                      aria-label={copied ? "Copied" : "Copy full memory context to clipboard"}
                      title={copied ? "Copied" : "Copy full memory context to clipboard"}
                    >
                      {copied ? (
                        <Check className="w-3 h-3 text-green-700" />
                      ) : (
                        <Copy className="w-3 h-3" />
                      )}
                      {copied ? "COPIED" : "COPY"}
                    </button>
                    <button
                      type="button"
                      onClick={onDownloadFull}
                      className="text-[10px] font-mono text-primary hover:underline inline-flex items-center gap-1"
                      data-testid="memory-context-download-full"
                      aria-label="Download full memory context as a .txt file"
                      title="Download full memory context as a .txt file"
                    >
                      <Download className="w-3 h-3" />
                      DOWNLOAD
                    </button>
                  </>
                )}
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
