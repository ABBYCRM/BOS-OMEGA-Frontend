import { useListProviders, useCreateProvider, useUpdateProvider, getListProvidersQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Settings as SettingsIcon, Plus, Save } from "lucide-react";
import { ProviderStatusBadge } from "@/components/StatusBadge";

export function Settings() {
  const { data: providers = [] } = useListProviders();
  const createProvider = useCreateProvider();
  const updateProvider = useUpdateProvider();
  const queryClient = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [newProvider, setNewProvider] = useState({ name: "", base_url: "", priority: 5, api_key_env: "" });

  function handleAddProvider() {
    if (!newProvider.name) return;
    createProvider.mutate(newProvider, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListProvidersQueryKey() });
        setShowAdd(false);
        setNewProvider({ name: "", base_url: "", priority: 5, api_key_env: "" });
      },
    });
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center gap-2">
        <SettingsIcon className="w-4 h-4 text-primary" />
        <h1 className="text-sm font-mono font-bold tracking-wider">SETTINGS</h1>
      </div>

      {/* Provider config */}
      <div className="bg-card border border-card-border rounded-lg p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xs font-mono font-semibold text-foreground tracking-wider">PROVIDER CONFIGURATION</h2>
          <button
            onClick={() => setShowAdd(!showAdd)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-primary/15 border border-primary/30 rounded text-xs font-mono text-primary hover:bg-primary/25 transition-all"
          >
            <Plus className="w-3 h-3" />
            ADD PROVIDER
          </button>
        </div>

        {showAdd && (
          <div className="mb-4 p-4 border border-primary/25 rounded bg-primary/5 space-y-3">
            <h3 className="text-[11px] font-mono text-primary tracking-wider">NEW PROVIDER</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] font-mono text-muted-foreground">NAME</label>
                <input
                  value={newProvider.name}
                  onChange={(e) => setNewProvider((p) => ({ ...p, name: e.target.value }))}
                  placeholder="e.g. OpenAI"
                  className="w-full mt-1 bg-muted/30 border border-input rounded px-2 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground"
                />
              </div>
              <div>
                <label className="text-[10px] font-mono text-muted-foreground">BASE URL</label>
                <input
                  value={newProvider.base_url}
                  onChange={(e) => setNewProvider((p) => ({ ...p, base_url: e.target.value }))}
                  placeholder="https://api.openai.com/v1"
                  className="w-full mt-1 bg-muted/30 border border-input rounded px-2 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground"
                />
              </div>
              <div>
                <label className="text-[10px] font-mono text-muted-foreground">API KEY ENV VAR</label>
                <input
                  value={newProvider.api_key_env}
                  onChange={(e) => setNewProvider((p) => ({ ...p, api_key_env: e.target.value }))}
                  placeholder="MY_API_KEY"
                  className="w-full mt-1 bg-muted/30 border border-input rounded px-2 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground"
                />
              </div>
              <div>
                <label className="text-[10px] font-mono text-muted-foreground">PRIORITY (1=highest)</label>
                <input
                  type="number"
                  value={newProvider.priority}
                  onChange={(e) => setNewProvider((p) => ({ ...p, priority: +e.target.value }))}
                  className="w-full mt-1 bg-muted/30 border border-input rounded px-2 py-1.5 text-xs font-mono text-foreground"
                />
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={handleAddProvider} className="px-4 py-1.5 bg-primary text-primary-foreground rounded text-xs font-mono font-semibold hover:opacity-90 transition-all">
                ADD PROVIDER
              </button>
              <button onClick={() => setShowAdd(false)} className="px-4 py-1.5 border border-border rounded text-xs font-mono text-muted-foreground hover:text-foreground">
                CANCEL
              </button>
            </div>
          </div>
        )}

        <div className="space-y-2">
          {providers.map((p) => (
            <div key={p.id} className="flex items-center gap-4 py-3 border-b border-border/50 last:border-0">
              <div className="flex-1">
                <div className="font-mono text-sm font-semibold text-foreground">{p.name}</div>
                <div className="text-[11px] font-mono text-muted-foreground mt-0.5">{p.base_url || "No base URL"}</div>
                {p.api_key_env && (
                  <div className="text-[10px] font-mono text-muted-foreground">KEY ENV: <span className="text-amber-400">{p.api_key_env}</span></div>
                )}
              </div>
              <div className="flex items-center gap-3">
                <span className="text-[10px] font-mono text-muted-foreground">PRIORITY: {p.priority}</span>
                <ProviderStatusBadge status={p.status} />
                <button
                  onClick={() => updateProvider.mutate({ id: p.id, enabled: !p.enabled }, {
                    onSuccess: () => queryClient.invalidateQueries({ queryKey: getListProvidersQueryKey() }),
                  })}
                  className={`px-3 py-1 rounded border text-[11px] font-mono transition-all ${
                    p.enabled
                      ? "bg-green-500/15 text-green-400 border-green-500/30"
                      : "bg-red-500/15 text-red-400 border-red-500/30"
                  }`}
                >
                  {p.enabled ? "ENABLED" : "DISABLED"}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* API Key guidance */}
      <div className="bg-card border border-card-border rounded-lg p-5">
        <h2 className="text-xs font-mono font-semibold text-foreground tracking-wider mb-4">API KEY CONFIGURATION</h2>
        <p className="text-xs font-mono text-muted-foreground mb-4">
          API keys must be configured as environment variables. BOS-OMEGA never stores keys in the database.
        </p>
        <div className="space-y-2">
          {[
            { env: "OPENAI_API_KEY", provider: "OpenAI", url: "https://platform.openai.com/api-keys" },
            { env: "ANTHROPIC_API_KEY", provider: "Anthropic", url: "https://console.anthropic.com/" },
            { env: "GEMINI_API_KEY", provider: "Google Gemini", url: "https://ai.google.dev/" },
            { env: "OLLAMA_BASE_URL", provider: "Ollama (optional)", url: "http://localhost:11434" },
          ].map((item) => (
            <div key={item.env} className="flex items-center gap-3 py-2 border-b border-border/30 last:border-0">
              <code className="font-mono text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded">{item.env}</code>
              <span className="text-xs font-mono text-muted-foreground">{item.provider}</span>
              <span className="text-[10px] font-mono text-muted-foreground ml-auto">{item.url}</span>
            </div>
          ))}
        </div>
        <div className="mt-4 p-3 bg-primary/10 border border-primary/25 rounded">
          <p className="text-[11px] font-mono text-primary">
            Without API keys, BOS-OMEGA runs in MOCK MODE — responses are simulated but the full pipeline (routing, validation, audit) still executes.
          </p>
        </div>
      </div>
    </div>
  );
}
