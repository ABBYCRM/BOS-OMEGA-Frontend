import { useListModels, useUpdateModel, useListProviders, useCreateModel, getListModelsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Cpu, Plus, X } from "lucide-react";
import { useState } from "react";
import { formatCost } from "@/lib/utils";

const ALL_CAPABILITY_TAGS = [
  "reasoning", "coding", "long_context", "cheap", "fast",
  "structured_output", "multimodal", "local_private", "safety", "legal", "research"
];

export function ModelRegistry() {
  const { data: models = [], isLoading } = useListModels();
  const { data: providers = [] } = useListProviders();
  const updateModel = useUpdateModel();
  const createModel = useCreateModel();
  const queryClient = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [newModel, setNewModel] = useState({
    provider_id: "",
    model_name: "",
    capability_tags: [] as string[],
    context_window: 8192,
    cost_input: 0,
    cost_output: 0,
  });

  function handleToggle(id: string, enabled: boolean) {
    updateModel.mutate({ id, enabled }, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListModelsQueryKey() }),
    });
  }

  function handleAdd() {
    if (!newModel.provider_id || !newModel.model_name) return;
    createModel.mutate(newModel, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListModelsQueryKey() });
        setShowAdd(false);
        setNewModel({ provider_id: "", model_name: "", capability_tags: [], context_window: 8192, cost_input: 0, cost_output: 0 });
      },
    });
  }

  function toggleTag(tag: string) {
    setNewModel((prev) => ({
      ...prev,
      capability_tags: prev.capability_tags.includes(tag)
        ? prev.capability_tags.filter((t) => t !== tag)
        : [...prev.capability_tags, tag],
    }));
  }

  const tagColors: Record<string, string> = {
    reasoning: "bg-blue-500/20 text-blue-300 border-blue-500/30",
    coding: "bg-purple-500/20 text-purple-300 border-purple-500/30",
    long_context: "bg-cyan-500/20 text-cyan-300 border-cyan-500/30",
    cheap: "bg-green-500/20 text-green-300 border-green-500/30",
    fast: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30",
    structured_output: "bg-orange-500/20 text-orange-300 border-orange-500/30",
    multimodal: "bg-pink-500/20 text-pink-300 border-pink-500/30",
    local_private: "bg-gray-500/20 text-gray-300 border-gray-500/30",
    safety: "bg-red-500/20 text-red-300 border-red-500/30",
    legal: "bg-amber-500/20 text-amber-300 border-amber-500/30",
    research: "bg-teal-500/20 text-teal-300 border-teal-500/30",
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Cpu className="w-4 h-4 text-primary" />
          <h1 className="text-sm font-mono font-bold tracking-wider">MODEL REGISTRY</h1>
          <span className="text-[11px] font-mono text-muted-foreground">({models.length} models)</span>
        </div>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-primary/15 border border-primary/30 rounded text-xs font-mono text-primary hover:bg-primary/25 transition-all"
        >
          <Plus className="w-3 h-3" />
          ADD MODEL
        </button>
      </div>

      {showAdd && (
        <div className="bg-card border border-primary/30 rounded-lg p-5 space-y-4">
          <h3 className="text-xs font-mono text-primary tracking-wider">ADD NEW MODEL</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] font-mono text-muted-foreground tracking-wider">PROVIDER</label>
              <select
                value={newModel.provider_id}
                onChange={(e) => setNewModel((p) => ({ ...p, provider_id: e.target.value }))}
                className="w-full mt-1 bg-muted/30 border border-input rounded px-2 py-1.5 text-xs font-mono text-foreground"
              >
                <option value="">Select provider...</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[10px] font-mono text-muted-foreground tracking-wider">MODEL NAME</label>
              <input
                value={newModel.model_name}
                onChange={(e) => setNewModel((p) => ({ ...p, model_name: e.target.value }))}
                placeholder="e.g. gpt-4o-mini"
                className="w-full mt-1 bg-muted/30 border border-input rounded px-2 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground"
              />
            </div>
            <div>
              <label className="text-[10px] font-mono text-muted-foreground tracking-wider">CONTEXT WINDOW</label>
              <input
                type="number"
                value={newModel.context_window}
                onChange={(e) => setNewModel((p) => ({ ...p, context_window: +e.target.value }))}
                className="w-full mt-1 bg-muted/30 border border-input rounded px-2 py-1.5 text-xs font-mono text-foreground"
              />
            </div>
            <div>
              <label className="text-[10px] font-mono text-muted-foreground tracking-wider">COST INPUT ($/1K tokens)</label>
              <input
                type="number"
                step="0.0001"
                value={newModel.cost_input}
                onChange={(e) => setNewModel((p) => ({ ...p, cost_input: +e.target.value }))}
                className="w-full mt-1 bg-muted/30 border border-input rounded px-2 py-1.5 text-xs font-mono text-foreground"
              />
            </div>
          </div>
          <div>
            <label className="text-[10px] font-mono text-muted-foreground tracking-wider mb-2 block">CAPABILITY TAGS</label>
            <div className="flex flex-wrap gap-1.5">
              {ALL_CAPABILITY_TAGS.map((tag) => (
                <button
                  key={tag}
                  onClick={() => toggleTag(tag)}
                  className={`px-2 py-0.5 rounded border text-[11px] font-mono transition-all ${
                    newModel.capability_tags.includes(tag)
                      ? tagColors[tag] || "bg-primary/20 text-primary border-primary/30"
                      : "border-border text-muted-foreground hover:border-primary/30"
                  }`}
                >
                  {tag}
                </button>
              ))}
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={handleAdd} className="px-4 py-1.5 bg-primary text-primary-foreground rounded text-xs font-mono font-semibold hover:opacity-90 transition-all">
              ADD MODEL
            </button>
            <button onClick={() => setShowAdd(false)} className="px-4 py-1.5 border border-border rounded text-xs font-mono text-muted-foreground hover:text-foreground transition-all">
              CANCEL
            </button>
          </div>
        </div>
      )}

      <div className="bg-card border border-card-border rounded-lg overflow-hidden">
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="border-b border-border">
              {["MODEL", "PROVIDER", "CAPABILITIES", "CONTEXT", "COST IN", "COST OUT", "RELIABILITY", "LATENCY", "STATUS"].map((h) => (
                <th key={h} className="px-3 py-2.5 text-left text-[10px] text-muted-foreground tracking-wider font-normal">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={9} className="px-3 py-4 text-muted-foreground text-center">Loading models...</td></tr>
            ) : (
              models.map((m) => (
                <tr key={m.id} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                  <td className="px-3 py-2.5 text-foreground font-semibold">{m.model_name}</td>
                  <td className="px-3 py-2.5 text-muted-foreground">{(m as { provider_name?: string }).provider_name || "—"}</td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {(m.capability_tags || []).slice(0, 3).map((tag) => (
                        <span key={tag} className={`px-1.5 py-0 rounded border text-[10px] ${tagColors[tag] || "bg-muted/30 text-muted-foreground border-border"}`}>
                          {tag}
                        </span>
                      ))}
                      {(m.capability_tags || []).length > 3 && (
                        <span className="text-[10px] text-muted-foreground">+{(m.capability_tags || []).length - 3}</span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-muted-foreground">
                    {m.context_window ? `${(m.context_window / 1000).toFixed(0)}K` : "—"}
                  </td>
                  <td className="px-3 py-2.5 text-green-400">{formatCost(m.cost_input)}</td>
                  <td className="px-3 py-2.5 text-green-400">{formatCost(m.cost_output)}</td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-1">
                      <div className="w-16 h-1.5 bg-muted rounded-full">
                        <div className="h-full bg-primary rounded-full" style={{ width: `${(m.reliability_score || 0) * 100}%` }} />
                      </div>
                      <span className="text-muted-foreground">{((m.reliability_score || 0) * 100).toFixed(0)}%</span>
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-1">
                      <div className="w-16 h-1.5 bg-muted rounded-full">
                        <div className="h-full bg-cyan-400 rounded-full" style={{ width: `${(m.latency_score || 0) * 100}%` }} />
                      </div>
                      <span className="text-muted-foreground">{((m.latency_score || 0) * 100).toFixed(0)}%</span>
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <button
                      onClick={() => handleToggle(m.id, !m.enabled)}
                      className={`px-2 py-0.5 rounded border text-[10px] font-mono transition-all ${
                        m.enabled
                          ? "bg-green-500/15 text-green-400 border-green-500/30 hover:bg-red-500/15 hover:text-red-400 hover:border-red-500/30"
                          : "bg-red-500/15 text-red-400 border-red-500/30 hover:bg-green-500/15 hover:text-green-400 hover:border-green-500/30"
                      }`}
                    >
                      {m.enabled ? "ON" : "OFF"}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
