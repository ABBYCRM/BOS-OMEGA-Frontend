import { useState } from "react";
import { ChevronDown, ChevronRight, Brain, Loader2 } from "lucide-react";
import { useGetTaskMemoryContext } from "@workspace/api-client-react";

type AuditEntry = {
  id: string;
  event_type: string;
  message: string;
  metadata?: unknown;
  created_at: string | Date;
};

type MemoryMeta = {
  canon_items?: number;
  continuity_items?: number;
  patches_items?: number;
  scratchpad_items?: number;
  memory_context_chars?: number;
  section_headers?: string[];
  memory_context_preview?: string;
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

  const meta: MemoryMeta =
    entry.metadata && typeof entry.metadata === "object"
      ? (entry.metadata as MemoryMeta)
      : {};

  const layers = [
    { key: "CANON", count: meta.canon_items ?? 0 },
    { key: "CONTINUITY", count: meta.continuity_items ?? 0 },
    { key: "PATCHES", count: meta.patches_items ?? 0 },
    { key: "SCRATCHPAD", count: meta.scratchpad_items ?? 0 },
  ];
  const total = layers.reduce((s, l) => s + l.count, 0);
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
