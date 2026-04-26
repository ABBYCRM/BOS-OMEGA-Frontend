import { useState } from "react";
import { useListMemory, useCreateMemory, useUpdateMemory, getListMemoryQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { formatDate } from "@/lib/utils";
import { Brain, Plus, Edit2, Save, X } from "lucide-react";

const LAYERS = ["canon", "patches", "continuity", "logs", "scratchpad"] as const;
type Layer = typeof LAYERS[number];

const layerColors: Record<string, string> = {
  canon: "bg-red-50 text-red-700 border-red-200",
  patches: "bg-amber-50 text-amber-700 border-amber-200",
  continuity: "bg-blue-50 text-blue-700 border-blue-200",
  logs: "bg-violet-50 text-violet-700 border-violet-200",
  scratchpad: "bg-muted text-muted-foreground border-border",
};

export function MemoryManager() {
  const { data: items = [], isLoading } = useListMemory();
  const createMemory = useCreateMemory();
  const updateMemory = useUpdateMemory();
  const queryClient = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [activeLayer, setActiveLayer] = useState<Layer | "all">("all");
  const [newItem, setNewItem] = useState({ layer: "scratchpad" as Layer, title: "", content: "", authority_level: 5 });
  const [editData, setEditData] = useState({ title: "", content: "", authority_level: 5 });

  function handleCreate() {
    if (!newItem.title || !newItem.content) return;
    createMemory.mutate(newItem, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListMemoryQueryKey() });
        setShowAdd(false);
        setNewItem({ layer: "scratchpad", title: "", content: "", authority_level: 5 });
      },
    });
  }

  function startEdit(item: { id: string; title: string; content: string; authority_level: number }) {
    setEditId(item.id);
    setEditData({ title: item.title, content: item.content, authority_level: item.authority_level });
  }

  function handleUpdate() {
    if (!editId) return;
    updateMemory.mutate({ id: editId, ...editData }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListMemoryQueryKey() });
        setEditId(null);
      },
    });
  }

  const filtered = activeLayer === "all" ? items : items.filter((i) => i.layer === activeLayer);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Brain className="w-4 h-4 text-primary" />
          <h1 className="text-xl font-serif font-semibold text-foreground tracking-tight">Memory manager</h1>
          <span className="text-[11px] font-mono text-muted-foreground">({items.length} items)</span>
        </div>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-secondary border border-border rounded text-xs font-mono text-primary hover:bg-primary/25 transition-all"
        >
          <Plus className="w-3 h-3" />
          ADD MEMORY
        </button>
      </div>

      {/* Layer filter */}
      <div className="flex gap-1.5">
        {(["all", ...LAYERS] as const).map((l) => (
          <button
            key={l}
            onClick={() => setActiveLayer(l)}
            className={`px-3 py-1 rounded border text-[11px] font-mono transition-all ${
              activeLayer === l
                ? "bg-secondary border-primary text-primary"
                : l !== "all" ? `${layerColors[l]} opacity-60 hover:opacity-100` : "border-border text-muted-foreground hover:border-border"
            }`}
          >
            {l.toUpperCase()}
          </button>
        ))}
      </div>

      {showAdd && (
        <div className="bg-card border border-border rounded-lg p-5 space-y-3">
          <h3 className="text-xs font-mono text-primary tracking-wider">NEW MEMORY ITEM</h3>
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
                onChange={(e) => setNewItem((p) => ({ ...p, authority_level: +e.target.value }))}
                className="w-full mt-1 bg-secondary border border-input rounded px-2 py-1.5 text-xs font-mono text-foreground"
              />
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
            <button onClick={handleCreate} className="px-4 py-1.5 bg-primary text-primary-foreground rounded text-xs font-mono font-semibold hover:opacity-90 transition-all">
              STORE MEMORY
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
            <div key={item.id} className="bg-card border border-card-border rounded-lg p-4">
              {editId === item.id ? (
                <div className="space-y-2">
                  <input
                    value={editData.title}
                    onChange={(e) => setEditData((p) => ({ ...p, title: e.target.value }))}
                    className="w-full bg-secondary border border-input rounded px-2 py-1 text-xs font-mono text-foreground"
                  />
                  <textarea
                    value={editData.content}
                    onChange={(e) => setEditData((p) => ({ ...p, content: e.target.value }))}
                    rows={3}
                    className="w-full bg-secondary border border-input rounded px-2 py-1 text-xs font-mono text-foreground resize-none"
                  />
                  <div className="flex gap-2">
                    <button onClick={handleUpdate} className="flex items-center gap-1 px-3 py-1 bg-primary text-primary-foreground rounded text-[11px] font-mono">
                      <Save className="w-3 h-3" />SAVE
                    </button>
                    <button onClick={() => setEditId(null)} className="flex items-center gap-1 px-3 py-1 border border-border rounded text-[11px] font-mono text-muted-foreground">
                      <X className="w-3 h-3" />CANCEL
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`px-2 py-0.5 rounded border text-[10px] font-mono ${layerColors[item.layer] || ""}`}>{item.layer}</span>
                      <span className="font-mono text-sm font-semibold text-foreground">{item.title}</span>
                      <span className="text-[10px] font-mono text-muted-foreground">AUTH:{item.authority_level}</span>
                    </div>
                    <p className="text-xs font-mono text-muted-foreground leading-relaxed">{item.content}</p>
                    <div className="text-[10px] font-mono text-muted-foreground mt-1">
                      Updated: {formatDate(item.updated_at)}
                    </div>
                  </div>
                  <button
                    onClick={() => startEdit(item)}
                    className="p-1.5 border border-border rounded text-muted-foreground hover:text-foreground hover:border-border transition-all"
                  >
                    <Edit2 className="w-3 h-3" />
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
