import { Link } from "wouter";
import { UserCircle, ExternalLink, AlertCircle } from "lucide-react";
import { usePersonas, type PersonaSlotKey } from "@/lib/personas";

// Audit row shape mirrors the orchestrator's auditLog payload. We only
// need the event_type + metadata to surface persona overlay info, but the
// other fields are kept so callers can pass the same array they already
// hand to MemoryUsedPanel without reshaping it.
type AuditEntry = {
  id: string;
  event_type: string;
  message: string;
  metadata?: unknown;
  created_at: string | Date;
};

// Task #57: surface the persona slot (A|B|C) overlay that shaped this
// task. The orchestrator records `persona_slot` and `persona_title` on the
// TASK_RECEIVED audit row (see artifacts/api-server/src/bos/pipeline.ts).
//
// This is a sibling to MemoryUsedPanel — the persona overlay is conceptually
// separate from the four ranked memory layers (canon/continuity/patches/
// scratchpad) so we keep its rendering self-contained instead of bolting
// another section onto MemoryUsedPanel. If the recorded slot is null, the
// panel renders nothing and stays out of the user's way.
//
// Availability rules ("no longer available"):
//   - Live row with non-empty content AND title still matching the
//     recorded title → render link.
//   - Live row was edited (title differs) OR cleared (no row, no content)
//     → render "no longer available" instead of a broken link.
//   - Live list still loading → render link optimistically; the worst case
//     is the editor opens on a stale title, which is fine.
export function ActivePersonaPanel({ audit }: { audit: AuditEntry[] }) {
  // Multiple TASK_RECEIVED rows shouldn't happen today, but if a future
  // re-run path emits more, take the most recent so the panel reflects
  // what actually ran for the current trace.
  const entry = [...audit].reverse().find((e) => e.event_type === "TASK_RECEIVED");
  const meta =
    entry?.metadata && typeof entry.metadata === "object"
      ? (entry.metadata as Record<string, unknown>)
      : {};
  const recorded_slot_raw = meta.persona_slot;
  const recorded_title_raw = meta.persona_title;

  const { slots, is_loading } = usePersonas();

  // Render nothing unless the task actually ran with a persona overlay.
  // Legacy TASK_RECEIVED rows (recorded before persona slots existed) and
  // tasks where the user didn't pick a persona both fall through here.
  if (
    recorded_slot_raw !== "A" &&
    recorded_slot_raw !== "B" &&
    recorded_slot_raw !== "C"
  ) {
    return null;
  }
  const slot: PersonaSlotKey = recorded_slot_raw;
  const recorded_title =
    typeof recorded_title_raw === "string" ? recorded_title_raw : "";

  const live = slots.find((s) => s.slot === slot);
  // Title comparison uses trimmed-equality so a whitespace-only edit doesn't
  // flip availability. An emptied content body counts as "cleared" because
  // PersonaEditor enforces non-empty saves — a slot with content="" can
  // only mean either it was never written or the underlying row is gone.
  const live_title = live?.title.trim() ?? "";
  const live_has_id = !!live?.id;
  const live_has_content = (live?.content.trim().length ?? 0) > 0;
  const titles_match = live_title === recorded_title.trim();

  // Timestamp-based staleness check (Task #57 review fix): a content-only
  // edit leaves the title unchanged but still means the persona that ran
  // for THIS task no longer matches the current slot. Compare the live
  // slot's updated_at against the audit row's created_at. If the slot
  // was written after the task ran, treat the link as stale even when
  // the title still matches. We're conservative on parse failures (treat
  // as "not stale") so a malformed timestamp doesn't surface a false
  // "no longer available" pill on otherwise-fine data.
  const task_time_ms = entry?.created_at ? new Date(entry.created_at).getTime() : NaN;
  const live_updated_ms = live?.updated_at ? new Date(live.updated_at).getTime() : NaN;
  const slot_edited_after_task =
    Number.isFinite(task_time_ms) &&
    Number.isFinite(live_updated_ms) &&
    live_updated_ms > task_time_ms;

  // If we haven't fetched yet, optimistically treat as available so we
  // don't flash a "no longer available" pill before the data lands.
  const still_available =
    is_loading ||
    (live_has_id && live_has_content && titles_match && !slot_edited_after_task);

  const display_title = recorded_title || live?.title || `Persona ${slot}`;

  return (
    <div
      className="bg-card border border-card-border rounded-lg p-4"
      data-testid="active-persona-panel"
    >
      <div className="flex items-center gap-3">
        <UserCircle className="w-4 h-4 text-primary flex-shrink-0" />
        <h3 className="text-[10px] font-mono text-muted-foreground tracking-wider">
          ACTIVE PERSONA
        </h3>
        <span
          className="font-mono text-[10px] text-muted-foreground border-l border-border pl-3"
          data-testid="active-persona-slot-label"
        >
          SLOT: <span className="text-foreground font-bold">{slot}</span>
        </span>
        <div className="ml-auto flex items-center gap-3 min-w-0">
          {still_available ? (
            <Link
              href={`/console#persona-slot-${slot}`}
              className="text-primary hover:underline inline-flex items-center gap-1 font-mono text-[11px] truncate"
              data-testid="active-persona-link"
              title={`Open persona slot ${slot} in the console`}
            >
              <span className="truncate">{display_title}</span>
              <ExternalLink className="w-3 h-3 flex-shrink-0" />
            </Link>
          ) : (
            <span
              className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground italic min-w-0"
              data-testid="active-persona-missing"
              title="The persona slot was edited or cleared after this task ran"
            >
              <AlertCircle className="w-3 h-3 flex-shrink-0 text-amber-700" />
              <span className="line-through truncate">{display_title}</span>
              <span className="not-italic text-[10px] text-amber-700 flex-shrink-0">
                no longer available
              </span>
            </span>
          )}
        </div>
      </div>
      <div className="text-[11px] font-mono text-muted-foreground mt-2 leading-snug">
        This task ran with the slot {slot} persona overlay applied on top of
        the BOS Master Prompt Kernel.
      </div>
    </div>
  );
}
