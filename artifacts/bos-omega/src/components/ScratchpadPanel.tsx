/**
 * Task #64 — Live scratchpad panel.
 *
 * Renders the scratchpad rows scoped to a single task (or, when
 * `taskId` is null, all of the user's scratchpad rows). Supports:
 *
 *   - Pin: opens an inline composer that POSTs /api/scratchpad/pin
 *     with `source_task_id = taskId`. Only the OWNER of the current
 *     task can pin (read-only mode hides the controls).
 *   - Edit: PATCH /api/memory/:id (the generic memory route already
 *     accepts {title, content} edits — wired here so the user can
 *     correct the wording of an auto-summary without leaving the
 *     thread).
 *   - Delete: DELETE /api/scratchpad/:id (existing endpoint).
 *
 * Auto-refresh: the panel re-queries on the `scratchpad-panel` query
 * key, which the parent (TaskConsole) invalidates after each task
 * completes so a freshly written auto-summary appears immediately.
 *
 * The panel is intentionally read-only-friendly: pass `readOnly` to
 * render on TaskDetail without the pin/edit/delete affordances. This
 * keeps audit-trace pages purely observational while the live console
 * is the surface for write actions.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pin, Pencil, Trash2, Plus, Save, X, Loader2, Sparkles } from "lucide-react";
import { formatDate, cn } from "@/lib/utils";

export interface ScratchpadRow {
  id: string;
  user_id: string | null;
  layer: "scratchpad";
  title: string;
  content: string;
  authority_level: number;
  source: "manual" | "manual_pin" | "auto_summary";
  source_task_id: string | null;
  created_at: string;
  updated_at: string;
}

async function fetchScratchpad(taskId: string | null): Promise<ScratchpadRow[]> {
  const url = taskId
    ? `/api/scratchpad?source_task_id=${encodeURIComponent(taskId)}`
    : `/api/scratchpad`;
  const r = await fetch(url, { credentials: "include" });
  if (!r.ok) throw new Error(`Failed to load scratchpad (${r.status})`);
  return (await r.json()) as ScratchpadRow[];
}

async function pinNote(input: { title?: string; content: string; source_task_id?: string | null }): Promise<ScratchpadRow> {
  const r = await fetch(`/api/scratchpad/pin`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: input.title,
      content: input.content,
      source_task_id: input.source_task_id ?? undefined,
    }),
  });
  if (!r.ok) {
    const detail = await r.json().catch(() => ({}));
    throw new Error(detail?.error ?? `Pin failed (${r.status})`);
  }
  return (await r.json()) as ScratchpadRow;
}

async function editNote(id: string, patch: { title?: string; content?: string }): Promise<ScratchpadRow> {
  const r = await fetch(`/api/memory/${encodeURIComponent(id)}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!r.ok) {
    const detail = await r.json().catch(() => ({}));
    throw new Error(detail?.error ?? `Edit failed (${r.status})`);
  }
  return (await r.json()) as ScratchpadRow;
}

async function deleteNote(id: string): Promise<void> {
  const r = await fetch(`/api/scratchpad/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!r.ok && r.status !== 204) {
    throw new Error(`Delete failed (${r.status})`);
  }
}

const SOURCE_LABEL: Record<ScratchpadRow["source"], { label: string; tone: string }> = {
  manual_pin:   { label: "Pin",  tone: "bg-amber-50 text-amber-700 border-amber-200" },
  auto_summary: { label: "Auto", tone: "bg-blue-50 text-blue-700 border-blue-200" },
  manual:       { label: "Note", tone: "bg-muted text-muted-foreground border-border" },
};

export interface ScratchpadPanelProps {
  /** When provided, the panel narrows to rows tied to this task. */
  taskId: string | null;
  /** Hides pin/edit/delete affordances. */
  readOnly?: boolean;
  /** Override the heading copy for the contextual page (e.g. "Live scratchpad" vs "Task scratchpad"). */
  heading?: string;
  /** Optional subtitle line. */
  subtitle?: string;
  /** Default-collapsed when true (TaskDetail uses this). */
  defaultCollapsed?: boolean;
  /** Counter signal — when the parent submits a new task or marks one complete, bumping this triggers a re-fetch. */
  refetchKey?: number;
}

export function ScratchpadPanel({
  taskId,
  readOnly = false,
  heading,
  subtitle,
  defaultCollapsed = false,
  refetchKey = 0,
}: ScratchpadPanelProps) {
  const qc = useQueryClient();
  const queryKey = useMemo(() => ["scratchpad-panel", taskId ?? "(all)"], [taskId]);
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [adding, setAdding] = useState(false);
  const [pinDraft, setPinDraft] = useState("");
  const [pinTitle, setPinTitle] = useState("");
  const [editId, setEditId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState({ title: "", content: "" });
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading, refetch } = useQuery({
    queryKey,
    queryFn: () => fetchScratchpad(taskId),
    staleTime: 5_000,
  });

  // External refetch trigger: the parent bumps `refetchKey` whenever a
  // task transitions to COMPLETED so the new auto-summary row appears
  // without the user clicking refresh.
  useEffect(() => {
    if (refetchKey > 0) void refetch();
  }, [refetchKey, refetch]);

  const pinM = useMutation({
    mutationFn: (input: { title?: string; content: string }) =>
      pinNote({ ...input, source_task_id: taskId }),
    onSuccess: () => {
      setPinDraft("");
      setPinTitle("");
      setAdding(false);
      setError(null);
      void qc.invalidateQueries({ queryKey });
      // Also bust the unscoped Settings list so the new row shows there too.
      void qc.invalidateQueries({ queryKey: ["scratchpad-panel", "(all)"] });
    },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : "Pin failed"),
  });

  const editM = useMutation({
    mutationFn: (input: { id: string; title: string; content: string }) =>
      editNote(input.id, { title: input.title, content: input.content }),
    onSuccess: () => {
      setEditId(null);
      setError(null);
      void qc.invalidateQueries({ queryKey });
      void qc.invalidateQueries({ queryKey: ["scratchpad-panel", "(all)"] });
    },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : "Edit failed"),
  });

  const delM = useMutation({
    mutationFn: (id: string) => deleteNote(id),
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey });
      void qc.invalidateQueries({ queryKey: ["scratchpad-panel", "(all)"] });
    },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : "Delete failed"),
  });

  const items = data ?? [];
  const headingText = heading ?? (taskId ? "Live scratchpad" : "All scratchpad");
  const subtitleText = subtitle ?? (taskId
    ? "Pinned notes and auto-summaries tied to this thread. Items here ride into the next prompt automatically."
    : "Every scratchpad row across all your tasks.");

  return (
    <div className="bg-card border border-card-border rounded-xl shadow-card" data-testid="scratchpad-panel">
      <div className="flex items-center justify-between px-5 py-3 border-b border-border">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center gap-2 text-left"
          aria-expanded={!collapsed}
        >
          <Sparkles className="w-4 h-4 text-amber-600" />
          <div>
            <div className="text-[14px] font-serif font-semibold text-foreground tracking-tight">
              {headingText}{" "}
              <span className="text-[11px] font-mono text-muted-foreground ml-1">({items.length})</span>
            </div>
            <div className="text-[11.5px] text-muted-foreground">{subtitleText}</div>
          </div>
        </button>
        {!readOnly && (
          <button
            type="button"
            onClick={() => { setAdding((a) => !a); setError(null); }}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-border text-[12px] font-medium text-foreground hover:bg-secondary transition-colors"
            data-testid="button-pin-scratchpad"
          >
            {adding ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
            {adding ? "Cancel" : "Pin a note"}
          </button>
        )}
      </div>

      {collapsed ? null : (
        <div className="p-5 space-y-3">
          {error && (
            <div className="text-[11.5px] font-mono text-red-700 border border-red-200 bg-red-50 rounded p-2">
              {error}
            </div>
          )}

          {!readOnly && adding && (
            <div className="border border-amber-300 bg-amber-50/40 rounded-md p-3 space-y-2">
              <input
                type="text"
                value={pinTitle}
                onChange={(e) => setPinTitle(e.target.value)}
                placeholder="Title (optional — derived from first line if blank)"
                className="w-full text-[12.5px] px-2 py-1.5 rounded border border-border bg-background"
                data-testid="input-pin-title"
              />
              <textarea
                value={pinDraft}
                onChange={(e) => setPinDraft(e.target.value)}
                placeholder="What should the next prompt remember? Plain text. Pinned items ride into every follow-up turn."
                rows={3}
                className="w-full text-[12.5px] px-2 py-1.5 rounded border border-border bg-background font-mono"
                data-testid="textarea-pin-content"
              />
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => { setAdding(false); setPinDraft(""); setPinTitle(""); }}
                  className="text-[12px] px-2.5 py-1 rounded border border-border text-muted-foreground hover:text-foreground"
                >Cancel</button>
                <button
                  type="button"
                  disabled={!pinDraft.trim() || pinM.isPending}
                  onClick={() => pinM.mutate({
                    title: pinTitle.trim() || undefined,
                    content: pinDraft.trim(),
                  })}
                  className="inline-flex items-center gap-1.5 text-[12px] px-3 py-1 rounded bg-foreground text-background disabled:opacity-50"
                  data-testid="button-pin-submit"
                >
                  {pinM.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Pin className="w-3 h-3" />}
                  Pin
                </button>
              </div>
            </div>
          )}

          {isLoading ? (
            <div className="text-[12px] font-mono text-muted-foreground">Loading scratchpad…</div>
          ) : items.length === 0 ? (
            <div className="text-[12px] text-muted-foreground italic">
              {taskId
                ? "No scratchpad rows for this task yet. Auto-summaries appear here when the task completes."
                : "No scratchpad rows yet. Pin one above or run a task — auto-summaries are written automatically."}
            </div>
          ) : (
            <ul className="divide-y divide-border/50">
              {items.map((it) => {
                const lab = SOURCE_LABEL[it.source] ?? SOURCE_LABEL.manual;
                const isEditing = editId === it.id;
                return (
                  <li key={it.id} className="py-3 first:pt-0 last:pb-0" data-testid={`scratchpad-row-${it.id}`}>
                    {isEditing ? (
                      <div className="space-y-2">
                        <input
                          type="text"
                          value={editDraft.title}
                          onChange={(e) => setEditDraft((d) => ({ ...d, title: e.target.value }))}
                          className="w-full text-[12.5px] px-2 py-1.5 rounded border border-border bg-background"
                          data-testid={`input-edit-title-${it.id}`}
                        />
                        <textarea
                          value={editDraft.content}
                          onChange={(e) => setEditDraft((d) => ({ ...d, content: e.target.value }))}
                          rows={3}
                          className="w-full text-[12.5px] px-2 py-1.5 rounded border border-border bg-background font-mono"
                          data-testid={`textarea-edit-content-${it.id}`}
                        />
                        <div className="flex items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => setEditId(null)}
                            className="text-[12px] px-2.5 py-1 rounded border border-border text-muted-foreground hover:text-foreground"
                          >Cancel</button>
                          <button
                            type="button"
                            disabled={!editDraft.content.trim() || !editDraft.title.trim() || editM.isPending}
                            onClick={() => editM.mutate({
                              id: it.id,
                              title: editDraft.title.trim(),
                              content: editDraft.content.trim(),
                            })}
                            className="inline-flex items-center gap-1.5 text-[12px] px-3 py-1 rounded bg-foreground text-background disabled:opacity-50"
                            data-testid={`button-edit-save-${it.id}`}
                          >
                            {editM.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                            Save
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-start gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className={cn(
                              "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono border",
                              lab.tone,
                            )}>
                              {lab.label}
                            </span>
                            <span className="text-[10px] font-mono text-muted-foreground">
                              auth={it.authority_level}
                            </span>
                            <span className="text-[12.5px] font-medium text-foreground truncate">
                              {it.title}
                            </span>
                          </div>
                          <div className="text-[12px] text-foreground whitespace-pre-wrap break-words">
                            {it.content}
                          </div>
                          <div className="text-[10px] font-mono text-muted-foreground mt-1">
                            {formatDate(it.created_at)}
                          </div>
                        </div>
                        {!readOnly && (
                          <div className="flex items-center gap-1 flex-shrink-0">
                            <button
                              type="button"
                              onClick={() => {
                                setEditId(it.id);
                                setEditDraft({ title: it.title, content: it.content });
                              }}
                              title="Edit"
                              className="p-1.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-secondary"
                              data-testid={`button-edit-${it.id}`}
                            >
                              <Pencil className="w-3 h-3" />
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                if (confirm(`Delete this scratchpad item?\n\n${it.title}`)) {
                                  delM.mutate(it.id);
                                }
                              }}
                              title="Delete"
                              className="p-1.5 rounded border border-border text-red-700 hover:bg-red-50"
                              data-testid={`button-delete-${it.id}`}
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
