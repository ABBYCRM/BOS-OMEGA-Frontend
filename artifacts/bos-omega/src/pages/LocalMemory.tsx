import { useEffect, useRef, useState } from "react";
import {
  Brain, Plus, Save, X, Trash2, Download, Upload, AlertTriangle, HardDrive,
  ClipboardPaste, ArrowDownToLine,
} from "lucide-react";
import { formatDate } from "@/lib/utils";
import { RehydrateBundleModal } from "@/components/ContinuityBundleControls";
import {
  listLocalMemory,
  createLocalMemory,
  updateLocalMemory,
  deleteLocalMemory,
  clearLocalMemory,
  exportLocalMemory,
  importLocalMemory,
  type LocalMemoryItem,
  type LocalMemoryLayer,
} from "@/lib/localMemory";

const LAYERS: LocalMemoryLayer[] = ["canon", "patches", "continuity", "scratchpad"];

const LAYER_COLOR: Record<LocalMemoryLayer, string> = {
  canon: "bg-red-50 text-red-700 border-red-200",
  patches: "bg-amber-50 text-amber-700 border-amber-200",
  continuity: "bg-blue-50 text-blue-700 border-blue-200",
  scratchpad: "bg-muted text-muted-foreground border-border",
};

const LAYER_DESC: Record<LocalMemoryLayer, string> = {
  canon: "Highest local authority. Injected into every task you submit from this browser.",
  patches: "Targeted overrides on top of canon. Use sparingly.",
  continuity: "Long-running session/user context.",
  scratchpad: "Ephemeral working memory.",
};

export function LocalMemoryPage() {
  const [items, setItems] = useState<LocalMemoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [activeLayer, setActiveLayer] = useState<LocalMemoryLayer | "all">("all");
  const [draft, setDraft] = useState({ title: "", content: "", layer: "scratchpad" as LocalMemoryLayer });
  const [editDraft, setEditDraft] = useState({ title: "", content: "", layer: "scratchpad" as LocalMemoryLayer });
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Task #64: cross-AI continuity bundle paste-in. Distinct from
  // local-memory JSON import above (which is a per-browser snapshot of
  // IndexedDB rows); a continuity bundle is a portable, hash-verified
  // text blob that seeds a NEW server-side conversation. Modal opens
  // when the user clicks the Rehydrate card.
  const [rehydrateOpen, setRehydrateOpen] = useState(false);

  async function refresh() {
    setLoading(true);
    const all = await listLocalMemory();
    setItems(all);
    setLoading(false);
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function handleCreate() {
    if (!draft.title.trim() || !draft.content.trim()) return;
    await createLocalMemory(draft);
    setDraft({ title: "", content: "", layer: "scratchpad" });
    setShowAdd(false);
    await refresh();
  }

  function startEdit(item: LocalMemoryItem) {
    setEditId(item.id);
    setEditDraft({ title: item.title, content: item.content, layer: item.layer });
  }

  async function saveEdit(id: string) {
    if (!editDraft.title.trim() || !editDraft.content.trim()) return;
    await updateLocalMemory(id, editDraft);
    setEditId(null);
    await refresh();
  }

  async function handleDelete(id: string) {
    await deleteLocalMemory(id);
    await refresh();
  }

  async function handleClearAll() {
    await clearLocalMemory();
    setConfirmClear(false);
    await refresh();
  }

  async function handleExport() {
    const bundle = await exportLocalMemory();
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `bos-omega-local-memory-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function triggerImport() {
    fileInputRef.current?.click();
  }

  async function handleImportFile(file: File) {
    setImportMessage(null);
    try {
      const text = await file.text();
      const bundle = JSON.parse(text);
      const { imported } = await importLocalMemory(bundle);
      setImportMessage(imported > 0 ? `Imported ${imported} item${imported === 1 ? "" : "s"}.` : "No valid items found in file.");
      await refresh();
    } catch (err) {
      setImportMessage(`Import failed: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  }

  const filtered = activeLayer === "all" ? items : items.filter((i) => i.layer === activeLayer);
  const counts = LAYERS.reduce<Record<string, number>>((acc, l) => {
    acc[l] = items.filter((i) => i.layer === l).length;
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-serif font-semibold text-foreground tracking-tight flex items-center gap-2">
            <HardDrive className="w-5 h-5" />
            Local memory
          </h1>
          <p className="text-[13.5px] text-muted-foreground max-w-2xl">
            Browser-stored memory layered below server canon. Persisted in IndexedDB with a localStorage fallback.
            Top-ranked items are injected into every task you submit from this browser.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleExport}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-[12px] font-medium text-foreground hover:bg-secondary transition-colors"
            data-testid="button-export-local-memory"
          >
            <Download className="w-3.5 h-3.5" />
            Export
          </button>
          <button
            type="button"
            onClick={triggerImport}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-[12px] font-medium text-foreground hover:bg-secondary transition-colors"
            data-testid="button-import-local-memory"
          >
            <Upload className="w-3.5 h-3.5" />
            Import
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void handleImportFile(f);
            }}
          />
          <button
            type="button"
            onClick={() => setConfirmClear(true)}
            disabled={items.length === 0}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-red-300 text-[12px] font-medium text-red-700 hover:bg-red-50 transition-colors disabled:opacity-50"
            data-testid="button-clear-local-memory"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Clear all
          </button>
        </div>
      </header>

      {importMessage && (
        <div className="px-3 py-2 border border-border rounded-md bg-secondary text-[12px] text-foreground">
          {importMessage}
        </div>
      )}

      {/* Task #64: cross-AI continuity bundle docs + entry point.
          Lives on the Local Memory page because that's where users
          come to understand "what does the model remember?" — the
          bundle answers "how do I move that memory between AIs?". */}
      <div className="bg-card border border-card-border rounded-xl p-5 shadow-card space-y-3" data-testid="card-rehydrate">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <h3 className="text-[14px] font-serif font-semibold text-foreground tracking-tight flex items-center gap-2">
              <ArrowDownToLine className="w-4 h-4 text-blue-600" />
              Continuity bundle (cross-AI rehydrate)
            </h3>
            <p className="text-[12.5px] text-muted-foreground max-w-2xl">
              Paste a <code className="px-1 py-0.5 bg-muted rounded text-[11px] font-mono">bos-omega.continuity-bundle.v1</code>
              {" "}block from another AI session (or another BOS-OMEGA workspace) to recreate a conversation here. The bundle
              ships a fenced JSON trailer with a SHA-256 fidelity hash; we verify it before importing, show you exactly what
              would land where, and only then create a new conversation seeded with the prior turns plus the rehydrated
              scratchpad and continuity rows. Nothing is overwritten without your confirmation.
            </p>
            <p className="text-[12px] text-muted-foreground max-w-2xl">
              To export, use <span className="font-medium text-foreground">Copy bundle</span> from the Task Console header
              (per-conversation) or any task trace (per-task).
            </p>
          </div>
          <button
            type="button"
            onClick={() => setRehydrateOpen(true)}
            className="flex-shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-[12px] font-medium text-foreground hover:bg-secondary"
            data-testid="button-open-rehydrate-localmemory"
          >
            <ClipboardPaste className="w-3.5 h-3.5" />
            Rehydrate from bundle
          </button>
        </div>
      </div>
      <RehydrateBundleModal
        open={rehydrateOpen}
        onClose={() => setRehydrateOpen(false)}
        navigateOnImport
      />

      {/* Layer filter pills */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setActiveLayer("all")}
          className={`px-3 py-1.5 rounded-md border text-[12px] font-medium transition-colors ${
            activeLayer === "all" ? "bg-primary text-primary-foreground border-primary" : "bg-card border-border text-foreground hover:bg-secondary"
          }`}
        >
          All <span className="opacity-70">({items.length})</span>
        </button>
        {LAYERS.map((l) => (
          <button
            key={l}
            onClick={() => setActiveLayer(l)}
            className={`px-3 py-1.5 rounded-md border text-[12px] font-medium transition-colors ${
              activeLayer === l ? "bg-primary text-primary-foreground border-primary" : "bg-card border-border text-foreground hover:bg-secondary"
            }`}
          >
            {l} <span className="opacity-70">({counts[l] || 0})</span>
          </button>
        ))}
      </div>

      {activeLayer !== "all" && (
        <div className="text-[12px] text-muted-foreground border-l-2 border-border pl-3">
          {LAYER_DESC[activeLayer]}
        </div>
      )}

      {/* Add new */}
      {showAdd ? (
        <div className="bg-card border border-card-border rounded-xl p-5 space-y-3 shadow-card">
          <div className="flex items-center justify-between">
            <h3 className="text-[14px] font-medium text-foreground">New local memory item</h3>
            <button onClick={() => setShowAdd(false)} className="p-1 hover:bg-secondary rounded-md">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <select
              value={draft.layer}
              onChange={(e) => setDraft({ ...draft, layer: e.target.value as LocalMemoryLayer })}
              className="px-3 py-2 border border-input rounded-md bg-background text-[13px]"
              data-testid="select-new-layer"
            >
              {LAYERS.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
            <input
              type="text"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              placeholder="Title"
              className="px-3 py-2 border border-input rounded-md bg-background text-[13px]"
              data-testid="input-new-title"
            />
          </div>
          <textarea
            value={draft.content}
            onChange={(e) => setDraft({ ...draft, content: e.target.value })}
            placeholder="Content"
            rows={4}
            className="w-full px-3 py-2 border border-input rounded-md bg-background text-[13px] font-mono"
            data-testid="textarea-new-content"
          />
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={() => setShowAdd(false)}
              className="px-3 py-1.5 border border-border rounded-md text-[12px] font-medium hover:bg-secondary"
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={!draft.title.trim() || !draft.content.trim()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-md text-[12px] font-medium disabled:opacity-50"
              data-testid="button-save-new"
            >
              <Save className="w-3.5 h-3.5" />
              Save
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowAdd(true)}
          className="inline-flex items-center gap-1.5 px-3 py-2 bg-primary text-primary-foreground rounded-md text-[13px] font-medium hover:bg-primary/90 shadow-card"
          data-testid="button-add-local-memory"
        >
          <Plus className="w-4 h-4" />
          Add memory item
        </button>
      )}

      {/* List */}
      {loading ? (
        <div className="text-[13px] text-muted-foreground">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="bg-card border border-card-border rounded-xl p-8 text-center shadow-card">
          <Brain className="w-8 h-8 mx-auto text-muted-foreground mb-3" />
          <div className="text-[13px] text-muted-foreground">
            {activeLayer === "all"
              ? "No local memory yet. Add an item or import a backup."
              : `No items in the ${activeLayer} layer.`}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((item) => {
            const isEditing = editId === item.id;
            return (
              <div
                key={item.id}
                className="bg-card border border-card-border rounded-xl p-4 shadow-card"
                data-testid={`local-memory-item-${item.id}`}
              >
                {isEditing ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <select
                        value={editDraft.layer}
                        onChange={(e) => setEditDraft({ ...editDraft, layer: e.target.value as LocalMemoryLayer })}
                        className="px-3 py-2 border border-input rounded-md bg-background text-[13px]"
                      >
                        {LAYERS.map((l) => <option key={l} value={l}>{l}</option>)}
                      </select>
                      <input
                        type="text"
                        value={editDraft.title}
                        onChange={(e) => setEditDraft({ ...editDraft, title: e.target.value })}
                        className="px-3 py-2 border border-input rounded-md bg-background text-[13px]"
                      />
                    </div>
                    <textarea
                      value={editDraft.content}
                      onChange={(e) => setEditDraft({ ...editDraft, content: e.target.value })}
                      rows={4}
                      className="w-full px-3 py-2 border border-input rounded-md bg-background text-[13px] font-mono"
                    />
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => setEditId(null)}
                        className="px-3 py-1.5 border border-border rounded-md text-[12px] hover:bg-secondary"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => saveEdit(item.id)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-md text-[12px]"
                      >
                        <Save className="w-3.5 h-3.5" />
                        Save
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className={`px-2 py-0.5 rounded border text-[10.5px] font-medium uppercase tracking-wide ${LAYER_COLOR[item.layer]}`}>
                          {item.layer}
                        </span>
                        <h3 className="text-[14px] font-medium text-foreground truncate">{item.title}</h3>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => startEdit(item)}
                          className="px-2 py-1 text-[11.5px] text-muted-foreground hover:text-foreground hover:bg-secondary rounded-md"
                          data-testid={`button-edit-${item.id}`}
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDelete(item.id)}
                          className="px-2 py-1 text-[11.5px] text-red-700 hover:bg-red-50 rounded-md"
                          data-testid={`button-delete-${item.id}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                    <pre className="text-[12.5px] text-foreground whitespace-pre-wrap font-mono leading-relaxed">{item.content}</pre>
                    <div className="text-[10.5px] text-muted-foreground mt-2">
                      Updated {formatDate(item.updated_at)}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Confirm clear modal */}
      {confirmClear && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card border border-card-border rounded-xl p-6 max-w-md w-full shadow-elevated">
            <div className="flex items-start gap-3 mb-4">
              <AlertTriangle className="w-5 h-5 text-red-700 mt-0.5" />
              <div>
                <h3 className="text-[15px] font-medium text-foreground">Clear all local memory?</h3>
                <p className="text-[12.5px] text-muted-foreground mt-1">
                  This permanently removes all {items.length} item{items.length === 1 ? "" : "s"} from this browser.
                  Server-side memory is unaffected. This cannot be undone.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmClear(false)}
                className="px-3 py-1.5 border border-border rounded-md text-[12px] font-medium hover:bg-secondary"
              >
                Cancel
              </button>
              <button
                onClick={handleClearAll}
                className="px-3 py-1.5 bg-red-700 text-white rounded-md text-[12px] font-medium hover:bg-red-800"
                data-testid="button-confirm-clear-all"
              >
                Clear all
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
