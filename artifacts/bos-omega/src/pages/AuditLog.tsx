import { useMemo, useState } from "react";
import { useListAuditLogs } from "@workspace/api-client-react";
import { formatDate } from "@/lib/utils";
import {
  ScrollText,
  ChevronDown,
  ChevronRight,
  Terminal,
} from "lucide-react";
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
  // Task #107: host-command (PowerShell) events get their own colours so
  // operators can spot them in the timeline at a glance — green for
  // successful invocations, red for rejected/failed ones (matching the
  // outcome convention used by LLM_CALL_COMPLETED / LLM_CALL_FAILED).
  POWERSHELL_EXECUTED: "text-green-700",
  POWERSHELL_FAILED: "text-red-700",
};

// Task #107: server-side event names emitted by POST /api/powershell.
// Keep in sync with artifacts/api-server/src/routes/powershell.ts.
const POWERSHELL_EVENT_TYPES = new Set([
  "POWERSHELL_EXECUTED",
  "POWERSHELL_FAILED",
]);

// Task #107: helper for the inline PowerShell summary strip. The
// metadata blob is `Record<string, unknown>` (per the AuditLogMetadata
// schema), so each field is narrowed defensively before render — older
// rows or future schema changes shouldn't crash the page.
function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

// Task #72: page size for the "Load older entries" button. Each click
// grows the in-place window by this many rows (rather than appending
// pages) so any scroll position / expand state is preserved by react-
// query's normal cache and re-render. 200 matches the legacy hard-coded
// cap so the first paint is unchanged for users who never click
// "Load older entries".
const PAGE_SIZE = 200;

export function AuditLog() {
  // Task #72: track the current window size. We keep `offset=0` and
  // grow `limit` so the UI always shows a single contiguous window
  // newest-first. This keeps per-row expand state stable across
  // "Load older entries" clicks.
  const [limit, setLimit] = useState(PAGE_SIZE);
  const { data, isLoading, isFetching } = useListAuditLogs({ limit });
  const allEntries = data?.entries ?? [];
  const total = data?.total ?? 0;

  // Task #107: client-side "PowerShell only" filter chip. We filter the
  // already-loaded window rather than refetching with a server param so
  // (a) no API contract change is needed and (b) the filter is instant
  // for the operator. The total counter and "Load older entries" CTA
  // continue to reflect the unfiltered set so users still see the full
  // audit volume — only the rendered list and its row count narrow.
  const [showOnlyPowerShell, setShowOnlyPowerShell] = useState(false);
  const entries = useMemo(
    () =>
      showOnlyPowerShell
        ? allEntries.filter((e) => POWERSHELL_EVENT_TYPES.has(e.event_type))
        : allEntries,
    [allEntries, showOnlyPowerShell],
  );
  const hasMore = allEntries.length < total;

  // Task #56: track which audit rows the user has expanded so we can show
  // human-readable detail (per-item provenance for MEMORY_INJECTED, raw
  // JSON metadata otherwise) without forcing every row open by default.
  // Keyed by audit row id so expanding one row never affects another.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggle = (id: string) =>
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  // Task #81: dropped-items list under each MEMORY_INJECTED row is
  // collapsed by default (matching the Task Detail "Memory used" panel's
  // UX) so a long audit feed isn't dominated by per-task dropped lists.
  // Keyed by audit row id so expanding one row's dropped list never
  // affects another.
  const [droppedShown, setDroppedShown] = useState<Record<string, boolean>>({});
  const toggleDropped = (id: string) =>
    setDroppedShown((prev) => ({ ...prev, [id]: !prev[id] }));

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <ScrollText className="w-4 h-4 text-primary" />
        <h1 className="text-xl font-serif font-semibold text-foreground tracking-tight">Audit log</h1>
        {/* Task #72: surface page size and total range so users know
            whether they're looking at the whole audit log or only a
            recent window. Falls back to the loaded count while the
            first request is in flight.
            Task #107: when the PowerShell filter is on, also surface
            the filtered row count so the operator can tell at a glance
            how many host-command events the current window holds. */}
        <span
          className="text-[11px] font-mono text-muted-foreground"
          data-testid="audit-count"
        >
          {data
            ? showOnlyPowerShell
              ? `(showing ${entries.length} PowerShell of ${allEntries.length} loaded, ${total} total)`
              : `(showing ${allEntries.length} of ${total} ${total === 1 ? "entry" : "entries"})`
            : `(${allEntries.length} entries)`}
        </span>
        {/* Task #107: "PowerShell only" filter chip. Mirrors the
            row's distinct icon/colour so operators know what they're
            narrowing to. Toggling is instant (client-side filter). */}
        <button
          type="button"
          onClick={() => setShowOnlyPowerShell((v) => !v)}
          aria-pressed={showOnlyPowerShell}
          data-testid="audit-filter-powershell"
          className={`ml-auto text-[11px] font-mono inline-flex items-center gap-1 px-2 py-1 rounded border transition-colors ${
            showOnlyPowerShell
              ? "bg-primary/10 border-primary text-primary"
              : "bg-card border-border text-muted-foreground hover:bg-muted/10"
          }`}
        >
          <Terminal className="w-3 h-3" />
          {showOnlyPowerShell ? "PowerShell only ✓" : "PowerShell only"}
        </button>
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
          ) : entries.length === 0 ? (
            // Task #107: when the filter narrows to zero rows, tell the
            // operator that's because of the filter (not an empty log)
            // so they don't think host commands are missing.
            <div
              className="p-8 text-center text-xs font-mono text-muted-foreground"
              data-testid="audit-empty"
            >
              {showOnlyPowerShell && allEntries.length > 0
                ? "No PowerShell events in the loaded window."
                : "No audit entries yet."}
            </div>
          ) : (
            entries.map((log, i) => {
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
              // Task #81: parse the parallel `dropped_items` array recorded
              // by Task #58. Rows recorded before #58 simply have no
              // `dropped_items` field so parseInjectedItems returns [] and
              // the section below stays hidden — preserving the legacy
              // rendering exactly.
              const droppedItems = isMemoryInjected
                ? parseInjectedItems(meta?.dropped_items)
                : [];
              // Task #96: the orchestrator caps each per-layer
              // *_dropped_titles / dropped_items array at DROPPED_TITLES_CAP
              // (currently 20) per layer in
              // artifacts/api-server/src/bos/memoryHelpers.ts so the audit
              // row stays cheap to render. When the per-layer numeric
              // counters (`canon_dropped + continuity_dropped +
              // patches_dropped + scratchpad_dropped`) report a higher
              // total than the recorded `dropped_items` array carries, the
              // list is truncated — surface that explicitly so users don't
              // think a missing note "wasn't dropped". Mirrors the
              // `droppedItemsTruncated` block in MemoryUsedPanel.
              const pickDropped = (raw: unknown): number =>
                typeof raw === "number" && Number.isFinite(raw) && raw >= 0
                  ? raw
                  : 0;
              const totalDroppedCount = isMemoryInjected
                ? pickDropped(meta?.canon_dropped) +
                  pickDropped(meta?.continuity_dropped) +
                  pickDropped(meta?.patches_dropped) +
                  pickDropped(meta?.scratchpad_dropped)
                : 0;
              const droppedItemsTruncated =
                droppedItems.length > 0 &&
                totalDroppedCount > droppedItems.length;
              const expandable = !!meta;
              const isOpen = expandable && !!expanded[log.id];
              const showDropped = isOpen && !!droppedShown[log.id];

              // Task #107: PowerShell-event row recognition + inline
              // summary parsing. The summary strip below the row is
              // *always visible* (no expand click needed) so operators
              // can see the command preview, SHA-256, byte counts, and
              // outcome at a glance — closing the loop on the "every
              // command is observable" promise of the integration.
              const isPowerShell = POWERSHELL_EVENT_TYPES.has(log.event_type);
              const psPreview = isPowerShell ? asString(meta?.command_preview) : null;
              const psSha = isPowerShell ? asString(meta?.command_sha256) : null;
              const psCmdBytes = isPowerShell ? asNumber(meta?.command_bytes) : null;
              const psOutBytes = isPowerShell ? asNumber(meta?.output_bytes) : null;
              const psOutcome = isPowerShell ? asString(meta?.outcome) : null;
              const psError = isPowerShell ? asString(meta?.error) : null;
              const psActorEmail = isPowerShell ? asString(meta?.actor_email) : null;
              const psActorIp = isPowerShell ? asString(meta?.ip) : null;
              const psOk = isPowerShell && (psOutcome === "ok" || log.event_type === "POWERSHELL_EXECUTED");

              // Task #107: PowerShell rows render a Terminal icon next
              // to the event-type label so they are identifiable at a
              // glance on a long scrolled feed. The leading column
              // keeps its chevron / empty placeholder so the
              // open/closed expansion signal stays consistent with the
              // rest of the timeline.
              const eventTypeColorClass =
                eventTypeColors[log.event_type] || "text-muted-foreground";
              const eventTypeCell = (
                <span
                  className={`${eventTypeColorClass} inline-flex items-center gap-1`}
                >
                  {isPowerShell && (
                    <Terminal
                      className={`w-3 h-3 ${
                        psOk ? "text-green-700" : "text-red-700"
                      }`}
                      data-testid={`powershell-icon-${log.id}`}
                      aria-hidden="true"
                    />
                  )}
                  {log.event_type}
                </span>
              );

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
                        {eventTypeCell}
                        <span className="text-foreground">{log.message}</span>
                        <span className="text-primary text-[10px]">{log.task_id ? log.task_id.slice(0, 8) + "..." : "—"}</span>
                      </div>
                    </button>
                  ) : (
                    <div className="px-4 py-2 hover:bg-muted/10 transition-colors">
                      <div className="grid grid-cols-[16px_1fr_1fr_2fr_1fr] gap-4 text-xs font-mono items-center">
                        <span />
                        <span className="text-muted-foreground text-[10px]">{formatDate(log.created_at)}</span>
                        {eventTypeCell}
                        <span className="text-foreground">{log.message}</span>
                        <span className="text-primary text-[10px]">{log.task_id ? log.task_id.slice(0, 8) + "..." : "—"}</span>
                      </div>
                    </div>
                  )}

                  {/* Task #107: always-visible PowerShell summary strip.
                      Renders the command preview, SHA-256, byte counts,
                      and outcome inline so operators don't have to
                      expand the metadata blob to see what ran. Outcome
                      colour matches the row's event-type colour (green
                      for POWERSHELL_EXECUTED, red for POWERSHELL_FAILED)
                      so the success/failure call-out is obvious. Each
                      field is rendered defensively — older rows or
                      future schema changes simply omit the missing
                      slot, never crash. */}
                  {isPowerShell && (
                    <div
                      className="px-4 pb-2 pt-1 bg-muted/5 border-t border-border/20"
                      data-testid={`powershell-summary-${log.id}`}
                    >
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] font-mono">
                        <span
                          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border ${
                            psOk
                              ? "border-green-700/40 text-green-700 bg-green-700/5"
                              : "border-red-700/40 text-red-700 bg-red-700/5"
                          }`}
                          data-testid={`powershell-outcome-${log.id}`}
                        >
                          {psOk ? "OK" : "FAILED"}
                        </span>
                        {psActorEmail && (
                          <span className="text-muted-foreground">
                            actor:{" "}
                            <span className="text-foreground">{psActorEmail}</span>
                            {psActorIp ? (
                              <span className="text-muted-foreground">
                                {" "}
                                @ {psActorIp}
                              </span>
                            ) : null}
                          </span>
                        )}
                        {psCmdBytes != null && (
                          <span
                            className="text-muted-foreground"
                            data-testid={`powershell-cmd-bytes-${log.id}`}
                          >
                            cmd:{" "}
                            <span className="text-foreground">
                              {formatBytes(psCmdBytes)}
                            </span>
                          </span>
                        )}
                        {psOutBytes != null && (
                          <span
                            className="text-muted-foreground"
                            data-testid={`powershell-output-bytes-${log.id}`}
                          >
                            stdout:{" "}
                            <span className="text-foreground">
                              {formatBytes(psOutBytes)}
                            </span>
                          </span>
                        )}
                        {psSha && (
                          <span
                            className="text-muted-foreground truncate"
                            title={psSha}
                            data-testid={`powershell-sha256-${log.id}`}
                          >
                            sha256:{" "}
                            <span className="text-foreground">
                              {psSha.slice(0, 12)}…{psSha.slice(-4)}
                            </span>
                          </span>
                        )}
                      </div>
                      {psPreview && (
                        <pre
                          className="mt-1.5 bg-secondary border border-border rounded px-2 py-1 text-[11px] font-mono text-foreground whitespace-pre-wrap break-words"
                          data-testid={`powershell-preview-${log.id}`}
                        >
                          {psPreview}
                        </pre>
                      )}
                      {!psOk && psError && (
                        <div
                          className="mt-1 text-[10px] font-mono text-red-700"
                          data-testid={`powershell-error-${log.id}`}
                        >
                          error: {psError}
                        </div>
                      )}
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
                      {/* Task #81: parallel "DROPPED ITEMS" list rendered
                          via the same MemoryInjectedItemsList component as
                          the Task Detail panel — same layer chips, same
                          /memory#item-<id> deep-links, same "no longer
                          available" markers for rows deleted after the
                          task ran. Collapsed by default so a long audit
                          feed isn't dominated by per-task dropped lists
                          (a task can drop up to 80 rows in the worst
                          case). Hidden entirely on legacy MEMORY_INJECTED
                          rows recorded before Task #58 (no `dropped_items`
                          field) — the raw metadata block below still
                          shows whatever was actually logged. */}
                      {isMemoryInjected && droppedItems.length > 0 && (
                        <div data-testid={`audit-row-dropped-section-${log.id}`}>
                          <button
                            type="button"
                            onClick={() => toggleDropped(log.id)}
                            aria-expanded={showDropped}
                            aria-controls={`audit-row-dropped-body-${log.id}`}
                            className="text-[10px] font-mono text-primary hover:underline inline-flex items-center gap-1"
                            data-testid={`audit-row-dropped-toggle-${log.id}`}
                          >
                            {showDropped ? (
                              <ChevronDown className="w-3 h-3" />
                            ) : (
                              <ChevronRight className="w-3 h-3" />
                            )}
                            {showDropped ? "HIDE" : "SHOW"} DROPPED ITEMS (
                            {/* Task #96: when the recorded list is shorter
                                than the per-layer numeric counters, the
                                toggle counter switches from "(N)" to
                                "(N of M)" so users notice truncation
                                without expanding. Mirrors the same
                                "<recorded> of <counter-total>" wording
                                used by the Task Detail "Memory used"
                                panel. */}
                            {droppedItemsTruncated
                              ? `${droppedItems.length} of ${totalDroppedCount}`
                              : droppedItems.length})
                          </button>
                          {showDropped && (
                            <div
                              id={`audit-row-dropped-body-${log.id}`}
                              className="mt-2 space-y-1.5"
                              data-testid={`audit-row-dropped-body-${log.id}`}
                            >
                              <MemoryInjectedItemsList
                                items={droppedItems}
                                enabled={showDropped}
                                label="DROPPED ITEMS"
                                testIdPrefix="memory-dropped-item"
                              />
                              {/* Task #96: amber truncation hint mirroring
                                  MemoryUsedPanel's `memory-dropped-items-
                                  truncated` block — same wording so users
                                  who see it on Task Detail recognise it
                                  here. The orchestrator caps each per-
                                  layer dropped_items array at
                                  DROPPED_TITLES_CAP (currently 20) per
                                  layer for cost reasons; without this
                                  hint, a busy task would render "(20)"
                                  with no indication that more notes were
                                  cut beyond what the audit row carries. */}
                              {droppedItemsTruncated && (
                                <div
                                  className="text-[10px] font-mono text-amber-700"
                                  data-testid={`audit-row-dropped-truncated-${log.id}`}
                                >
                                  Showing first {droppedItems.length} of{" "}
                                  {totalDroppedCount} dropped notes (audit row
                                  caps per-layer dropped lists for cost
                                  reasons).
                                </div>
                              )}
                            </div>
                          )}
                        </div>
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
        {/* Task #72: "Load older entries" button. Sits at the bottom of
            the list — hidden when there is nothing more to load (so the
            UI doesn't suggest false promises) and disabled while the
            larger window is being fetched. The first paint never
            renders this section so the no-history empty state stays
            clean. */}
        {!isLoading && entries.length > 0 && (
          <div className="px-4 py-3 border-t border-border bg-secondary flex items-center justify-between gap-3">
            <span
              className="text-[10px] font-mono text-muted-foreground"
              data-testid="audit-pagination-status"
            >
              {hasMore
                ? `${total - entries.length} older entries available`
                : "Showing all entries"}
            </span>
            {hasMore && (
              <button
                type="button"
                onClick={() => setLimit((l) => l + PAGE_SIZE)}
                disabled={isFetching}
                className="text-[11px] font-mono px-3 py-1 rounded border border-border bg-card hover:bg-muted/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                data-testid="audit-load-more"
              >
                {isFetching ? "Loading..." : `Load ${Math.min(PAGE_SIZE, total - entries.length)} older entries`}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
