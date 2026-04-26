import {
  useListProviders, useCreateProvider, useUpdateProvider, useDeleteProvider,
  useSetProviderApiKey, useClearProviderApiKey,
  useTestProvider, useDiscoverProviderModels,
  getListProvidersQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  Settings as SettingsIcon, Plus, Key, Trash2, CheckCircle2, XCircle, Loader2,
  Eye, EyeOff, Cpu, AlertCircle, Bot, Zap, Save,
} from "lucide-react";
import { ProviderStatusBadge } from "@/components/StatusBadge";

const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
  "google gemini": "https://generativelanguage.googleapis.com",
  ollama: "http://localhost:11434",
};

function ProviderCard({ provider }: { provider: any }) {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: getListProvidersQueryKey() });

  const setKey = useSetProviderApiKey();
  const clearKey = useClearProviderApiKey();
  const test = useTestProvider();
  const discover = useDiscoverProviderModels();
  const update = useUpdateProvider();
  const remove = useDeleteProvider();

  const [keyInput, setKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [discoverResult, setDiscoverResult] = useState<{ discovered: number; newly_registered: number } | null>(null);

  const hasKey = provider.has_api_key;
  const lastTest = provider.last_test_status as string | undefined;
  const isOk = lastTest === "OK";
  const isFailed = lastTest === "FAILED";

  function handleSaveKey() {
    if (!keyInput.trim()) return;
    setKey.mutate(
      { id: provider.id, data: { api_key: keyInput.trim() } },
      {
        onSuccess: () => {
          setKeyInput("");
          setShowKey(false);
          setTestResult(null);
          setDiscoverResult(null);
          invalidate();
          // Agentic: immediately test the new key
          test.mutate({ id: provider.id }, {
            onSuccess: (r) => { setTestResult(r); invalidate(); },
          });
        },
      },
    );
  }

  function handleTest() {
    setTestResult(null);
    test.mutate({ id: provider.id }, {
      onSuccess: (r) => { setTestResult(r); invalidate(); },
    });
  }

  function handleDiscover() {
    setDiscoverResult(null);
    discover.mutate({ id: provider.id }, {
      onSuccess: (r) => { setDiscoverResult({ discovered: r.discovered, newly_registered: r.newly_registered }); invalidate(); },
    });
  }

  function handleClearKey() {
    if (!confirm(`Remove the stored API key for ${provider.name}?`)) return;
    clearKey.mutate({ id: provider.id }, { onSuccess: () => { setTestResult(null); invalidate(); } });
  }

  function handleRemove() {
    if (!confirm(`Remove provider "${provider.name}"? Its models will also be deleted.`)) return;
    remove.mutate({ id: provider.id }, { onSuccess: invalidate });
  }

  return (
    <div className="bg-card border border-card-border rounded-lg overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border bg-muted/20 flex items-center gap-3">
        <Cpu className="w-4 h-4 text-primary" />
        <div className="flex-1">
          <div className="font-mono text-sm font-bold text-foreground">{provider.name}</div>
          <div className="text-[10px] font-mono text-muted-foreground">{provider.base_url || DEFAULT_BASE_URLS[provider.name.toLowerCase()] || "—"}</div>
        </div>
        <ProviderStatusBadge status={provider.status} />
        <button
          onClick={() => update.mutate({ id: provider.id, data: { enabled: !provider.enabled } }, { onSuccess: invalidate })}
          className={`px-3 py-1 rounded border text-[10px] font-mono transition-all ${
            provider.enabled
              ? "bg-green-500/15 text-green-400 border-green-500/30"
              : "bg-red-500/15 text-red-400 border-red-500/30"
          }`}
        >
          {provider.enabled ? "ENABLED" : "DISABLED"}
        </button>
        <button onClick={handleRemove} className="p-1.5 rounded hover:bg-red-500/15 text-muted-foreground hover:text-red-400 transition-all" title="Remove provider">
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Key + agentic actions */}
      <div className="p-4 space-y-3">
        {/* API key field */}
        <div>
          <label className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground tracking-wider mb-1.5">
            <Key className="w-3 h-3" />
            API KEY
            {hasKey && (
              <span className="ml-auto flex items-center gap-1.5 text-[10px] font-mono">
                <span className="text-green-400">●</span>
                <span className="text-muted-foreground">configured</span>
                <span className="text-amber-400">••••{provider.api_key_hint}</span>
              </span>
            )}
            {!hasKey && provider.api_key_env && (
              <span className="ml-auto text-[10px] font-mono text-muted-foreground">env fallback: <span className="text-amber-400">{provider.api_key_env}</span></span>
            )}
          </label>
          <div className="flex gap-2">
            <div className="flex-1 relative">
              <input
                type={showKey ? "text" : "password"}
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                placeholder={hasKey ? "Paste a new key to replace ••••" : `Paste your ${provider.name} API key here`}
                className="w-full bg-muted/30 border border-input rounded px-2 py-1.5 pr-8 text-xs font-mono text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
                onKeyDown={(e) => { if (e.key === "Enter") handleSaveKey(); }}
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground"
              >
                {showKey ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
              </button>
            </div>
            <button
              onClick={handleSaveKey}
              disabled={!keyInput.trim() || setKey.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded text-xs font-mono font-semibold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              {setKey.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
              SAVE
            </button>
            {hasKey && (
              <button
                onClick={handleClearKey}
                className="px-3 py-1.5 border border-border rounded text-xs font-mono text-muted-foreground hover:text-red-400 hover:border-red-500/40 transition-all"
              >
                CLEAR
              </button>
            )}
          </div>
          <div className="text-[9px] font-mono text-muted-foreground/70 italic mt-1">
            Encrypted with AES-256-GCM before storage. Never sent back to the browser in plaintext.
          </div>
        </div>

        {/* Agentic actions */}
        <div className="flex gap-2 pt-1">
          <button
            onClick={handleTest}
            disabled={test.isPending || (!hasKey && !provider.api_key_env && provider.name.toLowerCase() !== "ollama")}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 bg-primary/10 border border-primary/30 rounded text-xs font-mono text-primary hover:bg-primary/20 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            {test.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
            TEST CONNECTION
          </button>
          <button
            onClick={handleDiscover}
            disabled={discover.isPending || (!hasKey && !provider.api_key_env && provider.name.toLowerCase() !== "ollama")}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 bg-purple-500/10 border border-purple-500/30 rounded text-xs font-mono text-purple-400 hover:bg-purple-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            {discover.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Bot className="w-3 h-3" />}
            DISCOVER MODELS
          </button>
        </div>

        {/* Results / status badges */}
        {(testResult || discoverResult || lastTest) && (
          <div className="space-y-1.5 pt-1">
            {testResult && (
              <div className={`flex items-start gap-2 p-2 rounded border text-[10px] font-mono ${
                testResult.ok ? "bg-green-500/10 border-green-500/30 text-green-400"
                              : "bg-red-500/10 border-red-500/30 text-red-400"
              }`}>
                {testResult.ok ? <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" /> : <XCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />}
                <div>
                  <div className="font-bold">{testResult.ok ? "CONNECTION OK" : "CONNECTION FAILED"}</div>
                  <div className="opacity-80">{testResult.message}</div>
                </div>
              </div>
            )}
            {!testResult && lastTest && lastTest !== "NEVER_TESTED" && (
              <div className={`flex items-center gap-2 p-2 rounded border text-[10px] font-mono ${
                isOk ? "bg-green-500/10 border-green-500/30 text-green-400" :
                isFailed ? "bg-red-500/10 border-red-500/30 text-red-400" :
                "bg-muted/30 border-border text-muted-foreground"
              }`}>
                {isOk ? <CheckCircle2 className="w-3 h-3" /> : isFailed ? <XCircle className="w-3 h-3" /> : <AlertCircle className="w-3 h-3" />}
                <span>Last test: {lastTest} — {provider.last_test_message || "no message"}</span>
              </div>
            )}
            {discoverResult && (
              <div className="flex items-center gap-2 p-2 rounded border bg-purple-500/10 border-purple-500/30 text-purple-400 text-[10px] font-mono">
                <Bot className="w-3 h-3" />
                <span>Discovered <strong>{discoverResult.discovered}</strong> models · auto-registered <strong>{discoverResult.newly_registered}</strong> new</span>
              </div>
            )}
            {!discoverResult && provider.discovered_models_count > 0 && (
              <div className="flex items-center gap-2 p-2 rounded border bg-purple-500/5 border-purple-500/20 text-purple-400/80 text-[10px] font-mono">
                <Cpu className="w-3 h-3" />
                <span>{provider.discovered_models_count} models in catalog</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function Settings() {
  const { data: providers = [] } = useListProviders();
  const createProvider = useCreateProvider();
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: getListProvidersQueryKey() });
  const [showAdd, setShowAdd] = useState(false);
  const [newProvider, setNewProvider] = useState({ name: "", base_url: "", priority: 5, api_key_env: "" });

  const totalProviders = providers.length;
  const configuredKeys = providers.filter((p: any) => p.has_api_key).length;
  const healthy = providers.filter((p: any) => p.last_test_status === "OK").length;

  function handleAddProvider() {
    if (!newProvider.name) return;
    createProvider.mutate(
      { data: newProvider },
      {
        onSuccess: () => {
          setShowAdd(false);
          setNewProvider({ name: "", base_url: "", priority: 5, api_key_env: "" });
          invalidate();
        },
      },
    );
  }

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-center gap-3">
        <SettingsIcon className="w-4 h-4 text-primary" />
        <h1 className="text-sm font-mono font-bold tracking-wider">SETTINGS · AGENTIC PROVIDER CONFIG</h1>
        <div className="ml-auto flex items-center gap-3 text-[10px] font-mono">
          <span className="text-muted-foreground">PROVIDERS: <span className="text-foreground">{totalProviders}</span></span>
          <span className="text-muted-foreground">KEYS: <span className="text-amber-400">{configuredKeys}</span></span>
          <span className="text-muted-foreground">VERIFIED: <span className="text-green-400">{healthy}</span></span>
        </div>
      </div>

      {/* Agentic banner */}
      <div className="bg-primary/5 border border-primary/25 rounded-lg p-4 flex items-start gap-3">
        <Bot className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
        <div className="space-y-1">
          <div className="text-xs font-mono font-bold text-primary tracking-wider">AGENTIC KEY MANAGEMENT</div>
          <div className="text-[11px] font-mono text-muted-foreground leading-relaxed">
            Paste an API key — BOS-OMEGA will <span className="text-primary">automatically test it</span> against the live provider, then click <span className="text-purple-400">DISCOVER MODELS</span> to fetch and auto-register the provider's catalog. Keys are encrypted at rest with AES-256-GCM.
          </div>
        </div>
      </div>

      {/* Provider cards */}
      <div className="space-y-3">
        {providers.map((p: any) => (
          <ProviderCard key={p.id} provider={p} />
        ))}
      </div>

      {/* Add provider */}
      {!showAdd ? (
        <button
          onClick={() => setShowAdd(true)}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 border border-dashed border-primary/40 rounded-lg text-xs font-mono text-primary hover:bg-primary/5 transition-all"
        >
          <Plus className="w-3.5 h-3.5" />
          ADD CUSTOM PROVIDER
        </button>
      ) : (
        <div className="bg-card border border-primary/25 rounded-lg p-5 space-y-3">
          <h3 className="text-xs font-mono font-bold text-primary tracking-wider">NEW PROVIDER</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] font-mono text-muted-foreground">NAME</label>
              <input
                value={newProvider.name}
                onChange={(e) => setNewProvider((p) => ({ ...p, name: e.target.value }))}
                placeholder="e.g. OpenRouter"
                className="w-full mt-1 bg-muted/30 border border-input rounded px-2 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground"
              />
            </div>
            <div>
              <label className="text-[10px] font-mono text-muted-foreground">BASE URL (OpenAI-compatible)</label>
              <input
                value={newProvider.base_url}
                onChange={(e) => setNewProvider((p) => ({ ...p, base_url: e.target.value }))}
                placeholder="https://openrouter.ai/api/v1"
                className="w-full mt-1 bg-muted/30 border border-input rounded px-2 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground"
              />
            </div>
            <div>
              <label className="text-[10px] font-mono text-muted-foreground">API KEY ENV (optional fallback)</label>
              <input
                value={newProvider.api_key_env}
                onChange={(e) => setNewProvider((p) => ({ ...p, api_key_env: e.target.value }))}
                placeholder="OPENROUTER_API_KEY"
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
              CREATE PROVIDER
            </button>
            <button onClick={() => setShowAdd(false)} className="px-4 py-1.5 border border-border rounded text-xs font-mono text-muted-foreground hover:text-foreground">
              CANCEL
            </button>
          </div>
          <div className="text-[10px] font-mono text-muted-foreground/70">
            After creating, paste an API key on the new card and click TEST + DISCOVER MODELS.
          </div>
        </div>
      )}

      {/* Legacy env-var hint */}
      <div className="bg-card border border-card-border rounded-lg p-4">
        <h2 className="text-xs font-mono font-semibold text-foreground tracking-wider mb-2">LEGACY ENV VAR FALLBACK</h2>
        <p className="text-[11px] font-mono text-muted-foreground mb-3">
          If no key is pasted above, BOS-OMEGA falls back to these environment variables.
        </p>
        <div className="grid grid-cols-2 gap-2">
          {[
            { env: "OPENAI_API_KEY", provider: "OpenAI" },
            { env: "ANTHROPIC_API_KEY", provider: "Anthropic" },
            { env: "GEMINI_API_KEY", provider: "Google Gemini" },
            { env: "OLLAMA_BASE_URL", provider: "Ollama (URL only)" },
          ].map((item) => (
            <div key={item.env} className="flex items-center gap-2 py-1.5">
              <code className="font-mono text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded">{item.env}</code>
              <span className="text-[10px] font-mono text-muted-foreground">{item.provider}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
