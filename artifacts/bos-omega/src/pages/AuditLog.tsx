import { useState } from "react";
import { useListAuditLogs } from "@workspace/api-client-react";
import { formatDate } from "@/lib/utils";
import { ScrollText, ChevronDown, ChevronRight } from "lucide-react";
import {
  MemoryInjectedItemsList,
  parseInjectedItems,
} from "@/components/MemoryInjectedItemsList";

const eventTypeColors: Record<string, string> = {
  TASK_RECEIVED: "text-blue-700",
  INPUT_GATE_RESULT: "text-cyan-400",
  TASK_CLASSIFIED: "text-violet-700",
  TRI_STATE_EVALUATED: "text-yellow-400",
  MODEL_SELECTED: "text-green-700",
  LLM_CALL_STARTED: "text-primary",
  LLM_CALL_COMPLETED: "text-green-700",
  LLM_CALL_FAILED: "text-red-700",
  VALIDATION_COMPLETED: "text-amber-700",
  REPAIR_APPLIED: "text-orange-700",
  FALLBACK_TRIGGERED: "text-red-700",
  PARALLEL_EXECUTION_STARTED: "text-cyan-400",
  PARALLEL_EXECUTION_COMPLETED: "text-cyan-400",
  MERGE_COMPLETED: "text-green-700",
  TASK_COMPLETED: "text-green-700",
  TASK_ABORTED: "text-red-500",
  TASK_HELD: "text-amber-700",
  CIRCUIT_BREAKER_OPENED: "text-red-500",
  CIRCUIT_BREAKER_CLOSED: "text-green-700",
  MEMORY_INJECTED: "text-primary",
};

export function AuditLog() {
  const { data = [], isLoading } = useListAuditLogs({ limit: 200 });
  // Task #56: track which audit rows the user has expanded so we can show
  // human-readable detail (per-item provenance for MEMORY_INJECTED, raw
  // JSON metadata otherwise) without forcing every row open by default.
  // Keyed by audit row id so expanding one row never affects another.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggle = (id: string) =>
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <ScrollText className="w-4 h-4 text-primary" />
        <h1 className="text-xl font-serif font-semibold text-foreground tracking-tight">Audit log</h1>
        <span className="text-[11px] font-mono text-muted-foreground">({data.length} entries)</span>
      </div>

      <div className="bg-card border border-card-border rounded-lg overflow-hidden">
        <div className="px-4 py-2 border-b border-border bg-secondary">
          <div className="grid grid-cols-[16px_1fr_1fr_2fr_1fr] gap-4 text-[10px] font-mono text-muted-foreground tracking-wider">
            <span></span>
            <span>TIMESTAMP</span>
            <span>EVENT TYPE</span>
            <span>MESSAGE</span>
            <span>TASK ID</span>
          </div>
        </div>
        <div className="max-h-[600px] overflow-y-auto">
          {isLoading ? (
            <div className="p-4 text-xs font-mono text-muted-foreground">Loading audit logs...</div>
          ) : data.length === 0 ? (
            <div className="p-8 text-center text-xs font-mono text-muted-foreground">No audit entries yet.</div>
          ) : (
            data.map((log, i) => {
              // Task #56: every row with metadata can be expanded to see the
              // raw payload; MEMORY_INJECTED rows additionally render the
              // same per-item provenance UI (clickable layer chips +
              // Memory-Manager deep-links + "no longer available" markers)
              // shipped by Task #50 on the Task Detail page.
              const meta =
                log.metadata && typeof log.metadata === "object"
                  ? (log.metadata as Record<string, unknown>)
                  : null;
              const isMemoryInjected = log.event_type === "MEMORY_INJECTED";
              const injectedItems = isMemoryInjected
                ? parseInjectedItems(meta?.injected_items)
                : [];
              const expandable = !!meta;
              const isOpen = expandable && !!expanded[log.id];
              return (
                <div
                  key={log.id}
                  className={`border-b border-border/30 last:border-0 ${i % 2 === 0 ? "" : "bg-muted/5"}`}
                  data-testid={`audit-row-${log.id}`}
                >
                  {expandable ? (
                    <button
                      type="button"
                      onClick={() => toggle(log.id)}
                      aria-expanded={isOpen}
                      aria-controls={`audit-row-body-${log.id}`}
                      className="w-full px-4 py-2 text-left hover:bg-muted/10 transition-colors"
                      data-testid={`audit-row-toggle-${log.id}`}
                    >
                      <div className="grid grid-cols-[16px_1fr_1fr_2fr_1fr] gap-4 text-xs font-mono items-center">
                        {isOpen ? (
                          <ChevronDown className="w-3 h-3 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="w-3 h-3 text-muted-foreground" />
                        )}
                        <span className="text-muted-foreground text-[10px]">{formatDate(log.created_at)}</span>
                        <span className={eventTypeColors[log.event_type] || "text-muted-foreground"}>{log.event_type}</span>
                        <span className="text-foreground">{log.message}</span>
                        <span className="text-primary text-[10px]">{log.task_id ? log.task_id.slice(0, 8) + "..." : "—"}</span>
                      </div>
                    </button>
                  ) : (
                    <div className="px-4 py-2 hover:bg-muted/10 transition-colors">
                      <div className="grid grid-cols-[16px_1fr_1fr_2fr_1fr] gap-4 text-xs font-mono items-center">
                        <span />
                        <span className="text-muted-foreground text-[10px]">{formatDate(log.created_at)}</span>
                        <span className={eventTypeColors[log.event_type] || "text-muted-foreground"}>{log.event_type}</span>
                        <span className="text-foreground">{log.message}</span>
                        <span className="text-primary text-[10px]">{log.task_id ? log.task_id.slice(0, 8) + "..." : "—"}</span>
                      </div>
                    </div>
                  )}

                  {isOpen && meta && (
                    <div
                      id={`audit-row-body-${log.id}`}
                      className="px-4 pb-4 pt-2 border-t border-border/30 bg-muted/5 space-y-3"
                      data-testid={`audit-row-body-${log.id}`}
                    >
                      {/* Task #56: human-readable, clickable per-item
                          provenance for MEMORY_INJECTED rows. Reuses the
                          same renderer as the Task Detail "Memory used"
                          panel so deleted rows show as "no longer
                          available" instead of broken links, and every
                          remaining item deep-links into the Memory
                          Manager via /memory#item-<id>. Hidden on legacy
                          MEMORY_INJECTED rows (recorded before Task #50)
                          that have no injected_items field — the raw
                          metadata block below still renders so users can
                          see whatever else was logged. */}
                      {isMemoryInjected && injectedItems.length > 0 && (
                        <MemoryInjectedItemsList
                          items={injectedItems}
                          enabled={isOpen}
                        />
                      )}
                      <div>
                        <div className="text-[10px] font-mono text-muted-foreground tracking-wider mb-1">
                          METADATA
                        </div>
                        <pre
                          className="bg-secondary border border-border rounded p-3 text-[11px] font-mono text-foreground overflow-x-auto whitespace-pre-wrap max-h-72 overflow-y-auto"
                          data-testid={`audit-row-metadata-${log.id}`}
                        >
                          {JSON.stringify(meta, null, 2)}
                        </pre>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
