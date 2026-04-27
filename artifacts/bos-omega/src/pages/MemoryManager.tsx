import { useEffect, useState } from "react";
import {
  useListMemory, useCreateMemory, useUpdateMemory, useDeleteMemory, getListMemoryQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { formatDate } from "@/lib/utils";
import { Brain, Plus, Edit2, Save, X, Trash2, ShieldAlert, ShieldCheck } from "lucide-react";

// Task #50: parse `#item-<id>` from the URL hash so the MemoryUsedPanel on
// the task detail page can deep-link straight to the source row. We don't
// pull useLocation() from wouter here — the hash is intentionally not part
// of wouter's path-based routing, so reading window.location.hash directly
// is the right escape hatch.
function readHashItemId(): string | null {
  if (typeof window === "undefined") return null;
  const m = /^#item-(.+)$/.exec(window.location.hash);
  return m && m[1] ? m[1] : null;
}

const LAYERS = ["canon", "patches", "continuity", "logs", "scratchpad"] as const;
type Layer = typeof LAYERS[number];

const layerColors: Record<string, string> = {
  canon: "bg-red-50 text-red-700 border-red-200",
  patches: "bg-amber-50 text-amber-700 border-amber-200",
  continuity: "bg-blue-50 text-blue-700 border-blue-200",
  logs: "bg-violet-50 text-violet-700 border-violet-200",
  scratchpad: "bg-muted text-muted-foreground border-border",
};

const LAYER_DESCRIPTIONS: Record<Layer, string> = {
  canon: "Highest-authority operational policy and safety rules. Injected into every LLM call.",
  patches: "Targeted overrides on top of canon. Use sparingly.",
  continuity: "Long-running session/user context.",
  logs: "Event-level historical records.",
  scratchpad: "Ephemeral working memory.",
};

export function MemoryManager() {
  const { data: items = [], isLoading } = useListMemory();
  const createMemory = useCreateMemory();
  const updateMemory = useUpdateMemory();
  const deleteMemory = useDeleteMemory();
  const queryClient = useQueryClient();

  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [activeLayer, setActiveLayer] = useState<Layer | "all">("all");
  const [newItem, setNewItem] = useState({
    layer: "scratchpad" as Layer, title: "", content: "", authority_level: 5,
  });
  const [editData, setEditData] = useState({
    layer: "scratchpad" as Layer, title: "", content: "", authority_level: 5,
  });
  // Task #50: highlight + scroll-to behavior driven by `#item-<id>` in the
  // URL. We track which id should currently be highlighted so the panel on
  // the task detail page can deep-link here. The highlight clears after a
  // short window so the page doesn't stay in a "selected" state forever.
  const [highlightId, setHighlightId] = useState<string | null>(() => readHashItemId());

  const invalidate = () => queryClient.invalidateQueries({ queryKey: getListMemoryQueryKey() });

  // Listen for hash changes so a second click on the same panel still
  // re-triggers the highlight even if the hash didn't change between
  // navigations (browsers do fire `hashchange` for identical-hash sets).
  useEffect(() => {
    function onHash() {
      setHighlightId(readHashItemId());
    }
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Once both the items list and the target id are known, scroll to the
  // matching row. We force the active layer to "all" so the row is
  // actually in the rendered list — otherwise a deep-link to a canon row
  // while "scratchpad" is selected would scroll to nothing.
  useEffect(() => {
    if (!highlightId) return;
    if (isLoading) return;
    const target = items.find((i) => i.id === highlightId);
    if (!target) return;
    if (activeLayer !== "all" && activeLayer !== target.layer) {
      setActiveLayer("all");
      return; // re-run after the layer flip causes a re-render
    }
    const el = document.getElementById(`item-${highlightId}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    // Clear the highlight after a few seconds so the page doesn't stay
    // visually pinned forever. We keep the URL hash so a refresh still
    // re-scrolls.
    const t = window.setTimeout(() => setHighlightId(null), 3500);
    return () => window.clearTimeout(t);
  }, [highlightId, isLoading, items, activeLayer]);

  function handleCreate() {
    if (!newItem.title || !newItem.content) return;
    createMemory.mutate(
      { data: newItem },
      {
        onSuccess: () => {
          invalidate();
          setShowAdd(false);
          setNewItem({ layer: "scratchpad", title: "", content: "", authority_level: 5 });
        },
      },
    );
  }

  function startAddCanon() {
    setNewItem({ layer: "canon", title: "", content: "", authority_level: 9 });
    setShowAdd(true);
  }

  function startEdit(item: { id: string; layer: string; title: string; content: string; authority_level: number }) {
    setEditId(item.id);
    setEditData({
      layer: (LAYERS.includes(item.layer as Layer) ? item.layer : "scratchpad") as Layer,
      title: item.title,
      content: item.content,
      authority_level: item.authority_level,
    });
  }

  function handleUpdate() {
    if (!editId) return;
    updateMemory.mutate(
      { id: editId, data: editData },
      { onSuccess: () => { invalidate(); setEditId(null); } },
    );
  }

  function startDelete(id: string) {
    setConfirmDeleteId(id);
    setConfirmText("");
  }

  function handleDelete() {
    if (!confirmDeleteId) return;
    const target = items.find((i) => i.id === confirmDeleteId);
    if (!target) return;
    if (target.layer === "canon" && confirmText !== target.title) return;
    deleteMemory.mutate(
      { id: confirmDeleteId },
      {
        onSuccess: () => {
          invalidate();
          setConfirmDeleteId(null);
          setConfirmText("");
        },
      },
    );
  }

  const filtered = activeLayer === "all" ? items : items.filter((i) => i.layer === activeLayer);
  const canon_count = items.filter((i) => i.layer === "canon").length;
  const target = confirmDeleteId ? items.find((i) => i.id === confirmDeleteId) : null;
  const target_is_canon = target?.layer === "canon";
  const can_confirm_delete = !target_is_canon || confirmText === (target?.title ?? "");

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Brain className="w-4 h-4 text-primary" />
          <h1 className="text-xl font-serif font-semibold text-foreground tracking-tight">Memory manager</h1>
          <span className="text-[11px] font-mono text-muted-foreground">
            ({items.length} items · {canon_count} canon)
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={startAddCanon}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-red-50 border border-red-200 rounded text-xs font-mono text-red-800 hover:bg-red-100 transition-all"
            title="Add a high-authority canon rule"
          >
            <ShieldAlert className="w-3 h-3" />
            ADD CANON
          </button>
          <button
            onClick={() => setShowAdd(!showAdd)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-secondary border border-border rounded text-xs font-mono text-primary hover:bg-primary/25 transition-all"
          >
            <Plus className="w-3 h-3" />
            ADD MEMORY
          </button>
        </div>
      </div>

      {/* Canon authority notice */}
      <div className="flex items-start gap-3 p-4 bg-red-50/60 border border-red-200 rounded-lg">
        <ShieldCheck className="w-4 h-4 text-red-700 shrink-0 mt-0.5" />
        <div className="flex-1 text-[12.5px] text-red-900 leading-relaxed">
          <span className="font-medium">Canon = system law.</span>{" "}
          Items in the <span className="font-mono font-bold">CANON</span> layer are injected into the system context of every LLM call across all execution modes. As admin you can create, edit, change authority (1–10), or permanently delete canon entries — each change immediately affects every future task. Destructive canon edits require typing the title to confirm.
        </div>
      </div>

      {/* Layer filter */}
      <div className="flex gap-1.5 flex-wrap">
        {(["all", ...LAYERS] as const).map((l) => (
          <button
            key={l}
            onClick={() => setActiveLayer(l)}
            className={`px-3 py-1 rounded border text-[11px] font-mono transition-all ${
              activeLayer === l
                ? "bg-secondary border-primary text-primary"
                : l !== "all" ? `${layerColors[l]} opacity-60 hover:opacity-100` : "border-border text-muted-foreground hover:border-border"
            }`}
            title={l !== "all" ? LAYER_DESCRIPTIONS[l] : "All layers"}
          >
            {l.toUpperCase()}
            {l !== "all" && <span className="ml-1 opacity-70">{items.filter((i) => i.layer === l).length}</span>}
          </button>
        ))}
      </div>

      {showAdd && (
        <div className="bg-card border border-border rounded-lg p-5 space-y-3">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-mono text-primary tracking-wider">NEW MEMORY ITEM</h3>
            {newItem.layer === "canon" && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-red-200 bg-red-50 text-[10px] font-mono text-red-700">
                <ShieldAlert className="w-2.5 h-2.5" /> CANON RULE
              </span>
            )}
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-[10px] font-mono text-muted-foreground">LAYER</label>
              <select
                value={newItem.layer}
                onChange={(e) => setNewItem((p) => ({ ...p, layer: e.target.value as Layer }))}
                className="w-full mt-1 bg-secondary border border-input rounded px-2 py-1.5 text-xs font-mono text-foreground"
              >
                {LAYERS.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
              <p className="mt-1 text-[10px] text-muted-foreground leading-snug">{LAYER_DESCRIPTIONS[newItem.layer]}</p>
            </div>
            <div>
              <label className="text-[10px] font-mono text-muted-foreground">TITLE</label>
              <input
                value={newItem.title}
                onChange={(e) => setNewItem((p) => ({ ...p, title: e.target.value }))}
                placeholder="Memory title..."
                className="w-full mt-1 bg-secondary border border-input rounded px-2 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground"
              />
            </div>
            <div>
              <label className="text-[10px] font-mono text-muted-foreground">AUTHORITY (1-10)</label>
              <input
                type="number" min={1} max={10}
                value={newItem.authority_level}
                onChange={(e) => setNewItem((p) => ({ ...p, authority_level: Math.max(1, Math.min(10, +e.target.value || 1)) }))}
                className="w-full mt-1 bg-secondary border border-input rounded px-2 py-1.5 text-xs font-mono text-foreground"
              />
              <p className="mt-1 text-[10px] text-muted-foreground leading-snug">Higher wins on conflict.</p>
            </div>
          </div>
          <textarea
            value={newItem.content}
            onChange={(e) => setNewItem((p) => ({ ...p, content: e.target.value }))}
            placeholder="Memory content..."
            rows={4}
            className="w-full bg-secondary border border-input rounded px-3 py-2 text-xs font-mono text-foreground placeholder:text-muted-foreground resize-none"
          />
          <div className="flex gap-2">
            <button
              onClick={handleCreate}
              disabled={createMemory.isPending || !newItem.title || !newItem.content}
              className="px-4 py-1.5 bg-primary text-primary-foreground rounded text-xs font-mono font-semibold hover:opacity-90 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {createMemory.isPending ? "STORING…" : "STORE MEMORY"}
            </button>
            <button onClick={() => setShowAdd(false)} className="px-4 py-1.5 border border-border rounded text-xs font-mono text-muted-foreground hover:text-foreground transition-all">
              CANCEL
            </button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {isLoading ? (
          <div className="text-xs font-mono text-muted-foreground">Loading memory...</div>
        ) : filtered.length === 0 ? (
          <div className="bg-card border border-card-border rounded-lg p-8 text-center">
            <Brain className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
            <div className="text-sm font-mono text-muted-foreground">No memory items in this layer.</div>
          </div>
        ) : (
          filtered.map((item) => (
            <div
              key={item.id}
              id={`item-${item.id}`}
              data-testid={`memory-item-${item.id}`}
              className={`bg-card border rounded-lg p-4 transition-all ${
                item.layer === "canon" ? "border-red-200" : "border-card-border"
              } ${
                highlightId === item.id
                  ? "ring-2 ring-primary ring-offset-2 ring-offset-background"
                  : ""
              }`}
            >
              {editId === item.id ? (
                <div className="space-y-2">
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="text-[10px] font-mono text-muted-foreground">LAYER</label>
                      <select
                        value={editData.layer}
                        onChange={(e) => setEditData((p) => ({ ...p, layer: e.target.value as Layer }))}
                        className="w-full mt-1 bg-secondary border border-input rounded px-2 py-1 text-xs font-mono text-foreground"
                      >
                        {LAYERS.map((l) => <option key={l} value={l}>{l}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] font-mono text-muted-foreground">TITLE</label>
                      <input
                        value={editData.title}
                        onChange={(e) => setEditData((p) => ({ ...p, title: e.target.value }))}
                        className="w-full mt-1 bg-secondary border border-input rounded px-2 py-1 text-xs font-mono text-foreground"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-mono text-muted-foreground">AUTHORITY (1-10)</label>
                      <input
                        type="number" min={1} max={10}
                        value={editData.authority_level}
                        onChange={(e) => setEditData((p) => ({ ...p, authority_level: Math.max(1, Math.min(10, +e.target.value || 1)) }))}
                        className="w-full mt-1 bg-secondary border border-input rounded px-2 py-1 text-xs font-mono text-foreground"
                      />
                    </div>
                  </div>
                  <textarea
                    value={editData.content}
                    onChange={(e) => setEditData((p) => ({ ...p, content: e.target.value }))}
                    rows={4}
                    className="w-full bg-secondary border border-input rounded px-2 py-1 text-xs font-mono text-foreground resize-none"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={handleUpdate}
                      disabled={updateMemory.isPending}
                      className="flex items-center gap-1 px-3 py-1 bg-primary text-primary-foreground rounded text-[11px] font-mono disabled:opacity-50"
                    >
                      <Save className="w-3 h-3" />{updateMemory.isPending ? "SAVING…" : "SAVE"}
                    </button>
                    <button onClick={() => setEditId(null)} className="flex items-center gap-1 px-3 py-1 border border-border rounded text-[11px] font-mono text-muted-foreground">
                      <X className="w-3 h-3" />CANCEL
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className={`px-2 py-0.5 rounded border text-[10px] font-mono ${layerColors[item.layer] || ""}`}>{item.layer}</span>
                      <span className="font-mono text-sm font-semibold text-foreground break-all">{item.title}</span>
                      <span className="text-[10px] font-mono text-muted-foreground">AUTH:{item.authority_level}</span>
                    </div>
                    <p className="text-xs font-mono text-muted-foreground leading-relaxed whitespace-pre-wrap break-words">{item.content}</p>
                    <div className="text-[10px] font-mono text-muted-foreground mt-1">
                      Updated: {formatDate(item.updated_at)}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => startEdit(item)}
                      aria-label="Edit memory item"
                      className="p-1.5 border border-border rounded text-muted-foreground hover:text-foreground hover:border-border transition-all"
                    >
                      <Edit2 className="w-3 h-3" />
                    </button>
                    <button
                      onClick={() => startDelete(item.id)}
                      aria-label="Delete memory item"
                      className="p-1.5 border border-border rounded text-muted-foreground hover:text-red-700 hover:border-red-300 hover:bg-red-50 transition-all"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Delete confirmation modal */}
      {target && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
          onClick={() => { if (!deleteMemory.isPending) { setConfirmDeleteId(null); setConfirmText(""); } }}
        >
          <div
            className="bg-card border border-card-border rounded-xl shadow-card max-w-md w-full p-6 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              <ShieldAlert className={`w-5 h-5 ${target_is_canon ? "text-red-700" : "text-amber-700"}`} />
              <h3 className="text-[15px] font-serif font-semibold text-foreground">
                {target_is_canon ? "Permanently delete CANON rule?" : "Delete memory item?"}
              </h3>
            </div>
            <div className="text-[13px] text-muted-foreground leading-relaxed space-y-2">
              <p>
                <span className={`px-1.5 py-0.5 rounded border text-[10px] font-mono ${layerColors[target.layer] || ""}`}>{target.layer}</span>
                {" "}<span className="font-mono text-foreground">{target.title}</span>
              </p>
              {target_is_canon && (
                <p className="text-red-800">
                  This rule is currently injected into every LLM call. Deletion is permanent and removes it from all future task contexts. Type the rule's title below to confirm.
                </p>
              )}
            </div>
            {target_is_canon && (
              <input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={`Type "${target.title}" to confirm`}
                autoFocus
                className="w-full bg-secondary border border-input rounded px-3 py-2 text-[13px] font-mono text-foreground placeholder:text-muted-foreground"
              />
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => { setConfirmDeleteId(null); setConfirmText(""); }}
                disabled={deleteMemory.isPending}
                className="px-4 py-1.5 border border-border rounded text-[12.5px] font-medium text-muted-foreground hover:text-foreground hover:bg-secondary transition-all disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={!can_confirm_delete || deleteMemory.isPending}
                className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-red-700 text-white rounded text-[12.5px] font-medium hover:bg-red-800 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Trash2 className="w-3.5 h-3.5" />
                {deleteMemory.isPending ? "Deleting…" : target_is_canon ? "Permanently delete canon rule" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
