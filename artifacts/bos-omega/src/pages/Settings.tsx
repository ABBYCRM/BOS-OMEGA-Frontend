import {
  useListProviders, useCreateProvider, useUpdateProvider, useDeleteProvider,
  useSetProviderApiKey, useClearProviderApiKey,
  useTestProvider, useDiscoverProviderModels,
  getListProvidersQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  Plus, Key, Trash2, CheckCircle2, XCircle, Loader2,
  Eye, EyeOff, AlertCircle, Sparkles, Zap, ShieldCheck, Lock, Database,
} from "lucide-react";
import { ProviderStatusBadge } from "@/components/StatusBadge";

const PROVIDER_BRAND: Record<string, { letter: string; bg: string; fg: string }> = {
  openai:    { letter: "O", bg: "bg-emerald-100",  fg: "text-emerald-800" },
  anthropic: { letter: "A", bg: "bg-orange-100",   fg: "text-orange-800" },
  gemini:    { letter: "G", bg: "bg-blue-100",     fg: "text-blue-800" },
  "google gemini": { letter: "G", bg: "bg-blue-100", fg: "text-blue-800" },
  ollama:    { letter: "L", bg: "bg-violet-100",   fg: "text-violet-800" },
};

const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
  "google gemini": "https://generativelanguage.googleapis.com",
  ollama: "http://localhost:11434",
};

function ProviderAvatar({ name }: { name: string }) {
  const brand = PROVIDER_BRAND[name.toLowerCase()] ?? { letter: name.charAt(0).toUpperCase(), bg: "bg-stone-100", fg: "text-stone-800" };
  return (
    <div className={`w-10 h-10 rounded-lg ${brand.bg} flex items-center justify-center flex-shrink-0`}>
      <span className={`font-serif font-semibold text-base ${brand.fg}`}>{brand.letter}</span>
    </div>
  );
}

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
  const canCallProvider = hasKey || provider.api_key_env || provider.name.toLowerCase() === "ollama";

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
          test.mutate({ id: provider.id }, {
            onSuccess: (r) => { setTestResult(r); invalidate(); },
          });
        },
      },
    );
  }

  function handleTest() {
    setTestResult(null);
    test.mutate({ id: provider.id }, { onSuccess: (r) => { setTestResult(r); invalidate(); } });
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
    <div className="bg-card border border-card-border rounded-xl shadow-card overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border flex items-center gap-4">
        <ProviderAvatar name={provider.name} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5">
            <h3 className="text-[15px] font-serif font-semibold text-foreground tracking-tight">{provider.name}</h3>
            <ProviderStatusBadge status={provider.status} />
          </div>
          <div className="text-xs text-muted-foreground mt-0.5 truncate font-mono">
            {provider.base_url || DEFAULT_BASE_URLS[provider.name.toLowerCase()] || "—"}
          </div>
        </div>
        <button
          role="switch"
          aria-checked={provider.enabled}
          aria-label={`${provider.enabled ? "Disable" : "Enable"} ${provider.name}`}
          onClick={() => update.mutate({ id: provider.id, data: { enabled: !provider.enabled } }, { onSuccess: invalidate })}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${provider.enabled ? "bg-green-600" : "bg-stone-300"}`}
        >
          <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform ${provider.enabled ? "translate-x-[22px]" : "translate-x-0.5"}`} />
        </button>
        <button
          onClick={handleRemove}
          aria-label={`Remove provider ${provider.name}`}
          className="p-2 rounded-md text-muted-foreground hover:text-red-700 hover:bg-red-50 transition-all"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      {/* Body */}
      <div className="p-6 space-y-5">
        {/* API key field */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="flex items-center gap-1.5 text-[12.5px] font-medium text-foreground">
              <Key className="w-3.5 h-3.5 text-muted-foreground" />
              API key
            </label>
            {hasKey && (
              <span className="flex items-center gap-2 text-[11.5px]">
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-green-50 text-green-800 border border-green-200">
                  <Lock className="w-2.5 h-2.5" />
                  Encrypted
                </span>
                <span className="font-mono text-muted-foreground">····{provider.api_key_hint}</span>
              </span>
            )}
            {!hasKey && provider.api_key_env && (
              <span className="text-[11.5px] text-muted-foreground">
                Falling back to <code className="font-mono text-foreground bg-secondary px-1.5 py-0.5 rounded">{provider.api_key_env}</code>
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <div className="flex-1 relative">
              <input
                type={showKey ? "text" : "password"}
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                placeholder={hasKey ? "Paste a new key to replace" : `Paste your ${provider.name} API key`}
                className="w-full bg-background border border-input rounded-lg px-3.5 py-2.5 pr-10 text-[13px] text-foreground placeholder:text-muted-foreground/70 focus:border-primary focus:ring-2 focus:ring-primary/10 focus:outline-none transition-all"
                onKeyDown={(e) => { if (e.key === "Enter") handleSaveKey(); }}
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                aria-label={showKey ? "Hide API key" : "Show API key"}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-muted-foreground hover:text-foreground rounded-md transition-colors"
              >
                {showKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            </div>
            <button
              onClick={handleSaveKey}
              disabled={!keyInput.trim() || setKey.isPending}
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground rounded-lg text-[13px] font-medium hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-card"
            >
              {setKey.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
              Save key
            </button>
            {hasKey && (
              <button
                onClick={handleClearKey}
                className="px-4 py-2.5 border border-border rounded-lg text-[13px] font-medium text-muted-foreground hover:text-red-700 hover:border-red-200 hover:bg-red-50 transition-all"
              >
                Clear
              </button>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground/80 mt-2">
            <ShieldCheck className="w-3 h-3" />
            <span>Encrypted with AES-256-GCM. Plaintext is never returned to the browser.</span>
          </div>
        </div>

        {/* Agentic actions */}
        <div className="flex gap-2 pt-1">
          <button
            onClick={handleTest}
            disabled={test.isPending || !canCallProvider}
            className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-secondary border border-border rounded-lg text-[13px] font-medium text-foreground hover:bg-stone-200/70 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            {test.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
            Test connection
          </button>
          <button
            onClick={handleDiscover}
            disabled={discover.isPending || !canCallProvider}
            className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-accent text-accent-foreground rounded-lg text-[13px] font-medium hover:bg-accent/90 disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-card"
          >
            {discover.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            Discover models
          </button>
        </div>

        {/* Results */}
        {(testResult || discoverResult || (lastTest && lastTest !== "NEVER_TESTED") || provider.discovered_models_count > 0) && (
          <div className="space-y-2 pt-1">
            {testResult && (
              <div className={`flex items-start gap-2.5 p-3 rounded-lg border text-[12.5px] ${
                testResult.ok
                  ? "bg-green-50 border-green-200 text-green-900"
                  : "bg-red-50 border-red-200 text-red-900"
              }`}>
                {testResult.ok
                  ? <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5 text-green-700" />
                  : <XCircle className="w-4 h-4 flex-shrink-0 mt-0.5 text-red-700" />}
                <div className="flex-1">
                  <div className="font-medium">{testResult.ok ? "Connection successful" : "Connection failed"}</div>
                  <div className="text-[11.5px] opacity-80 mt-0.5">{testResult.message}</div>
                </div>
              </div>
            )}
            {!testResult && lastTest && lastTest !== "NEVER_TESTED" && (
              <div className={`flex items-center gap-2.5 p-3 rounded-lg border text-[12.5px] ${
                isOk ? "bg-green-50 border-green-200 text-green-900" :
                isFailed ? "bg-red-50 border-red-200 text-red-900" :
                "bg-muted border-border text-muted-foreground"
              }`}>
                {isOk ? <CheckCircle2 className="w-3.5 h-3.5 text-green-700" /> :
                 isFailed ? <XCircle className="w-3.5 h-3.5 text-red-700" /> :
                 <AlertCircle className="w-3.5 h-3.5" />}
                <span>Last test: <strong className="font-medium">{isOk ? "passed" : "failed"}</strong> · {provider.last_test_message || "no message"}</span>
              </div>
            )}
            {discoverResult && (
              <div className="flex items-center gap-2.5 p-3 rounded-lg bg-orange-50 border border-orange-200 text-orange-900 text-[12.5px]">
                <Sparkles className="w-3.5 h-3.5 text-orange-700" />
                <span>Discovered <strong>{discoverResult.discovered}</strong> models · <strong>{discoverResult.newly_registered}</strong> newly registered</span>
              </div>
            )}
            {!discoverResult && provider.discovered_models_count > 0 && (
              <div className="flex items-center gap-2.5 p-3 rounded-lg bg-secondary border border-border text-foreground text-[12.5px]">
                <Database className="w-3.5 h-3.5 text-muted-foreground" />
                <span><strong className="font-medium">{provider.discovered_models_count}</strong> models in catalog</span>
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
    <div className="space-y-8">
      {/* Page header */}
      <header className="space-y-1">
        <h1 className="text-2xl font-serif font-semibold text-foreground tracking-tight">Provider settings</h1>
        <p className="text-[13.5px] text-muted-foreground max-w-2xl">
          Connect language model providers, manage API keys, and let BOS-Omega automatically test credentials and discover available models.
        </p>
      </header>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: "Providers", value: totalProviders, hint: "Configured" },
          { label: "Keys stored", value: configuredKeys, hint: "Encrypted at rest" },
          { label: "Verified", value: healthy, hint: "Connection passed" },
        ].map((s) => (
          <div key={s.label} className="bg-card border border-card-border rounded-xl p-5 shadow-card">
            <div className="text-[11.5px] text-muted-foreground font-medium tracking-wide uppercase">{s.label}</div>
            <div className="text-3xl font-serif font-semibold text-foreground mt-2 tracking-tight">{s.value}</div>
            <div className="text-[11.5px] text-muted-foreground mt-1">{s.hint}</div>
          </div>
        ))}
      </div>

      {/* Agentic explainer */}
      <div className="bg-card border border-card-border rounded-xl p-5 shadow-card flex items-start gap-4">
        <div className="w-10 h-10 rounded-lg bg-orange-100 flex items-center justify-center flex-shrink-0">
          <Sparkles className="w-5 h-5 text-orange-700" />
        </div>
        <div className="flex-1">
          <div className="text-[14px] font-serif font-semibold text-foreground tracking-tight">Agentic key management</div>
          <p className="text-[13px] text-muted-foreground leading-relaxed mt-1">
            Paste an API key and BOS-Omega will <span className="text-foreground font-medium">automatically validate it</span> against the live provider. Run <span className="text-foreground font-medium">Discover models</span> to fetch and auto-register the catalog. Keys are encrypted with AES-256-GCM and never returned in plaintext.
          </p>
        </div>
      </div>

      {/* Provider cards */}
      <section className="space-y-4">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-serif font-semibold text-foreground tracking-tight">Connected providers</h2>
          <span className="text-[12px] text-muted-foreground">{totalProviders} total</span>
        </div>
        <div className="space-y-3">
          {providers.map((p: any) => (
            <ProviderCard key={p.id} provider={p} />
          ))}
        </div>
      </section>

      {/* Add provider */}
      {!showAdd ? (
        <button
          onClick={() => setShowAdd(true)}
          className="w-full inline-flex items-center justify-center gap-2 px-5 py-4 border border-dashed border-border rounded-xl text-[13px] font-medium text-muted-foreground hover:border-primary/40 hover:text-foreground hover:bg-card transition-all"
        >
          <Plus className="w-4 h-4" />
          Add a custom provider
        </button>
      ) : (
        <div className="bg-card border border-card-border rounded-xl p-6 shadow-card space-y-4">
          <div>
            <h3 className="text-[15px] font-serif font-semibold text-foreground tracking-tight">New provider</h3>
            <p className="text-[12.5px] text-muted-foreground mt-0.5">For any OpenAI-compatible endpoint (OpenRouter, Together, vLLM, etc.).</p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Name">
              <input
                value={newProvider.name}
                onChange={(e) => setNewProvider((p) => ({ ...p, name: e.target.value }))}
                placeholder="OpenRouter"
                className="w-full bg-background border border-input rounded-lg px-3 py-2 text-[13px] focus:border-primary focus:ring-2 focus:ring-primary/10 focus:outline-none"
              />
            </Field>
            <Field label="Base URL">
              <input
                value={newProvider.base_url}
                onChange={(e) => setNewProvider((p) => ({ ...p, base_url: e.target.value }))}
                placeholder="https://openrouter.ai/api/v1"
                className="w-full bg-background border border-input rounded-lg px-3 py-2 text-[13px] font-mono focus:border-primary focus:ring-2 focus:ring-primary/10 focus:outline-none"
              />
            </Field>
            <Field label="Fallback environment variable" hint="Optional — used only if no key is pasted">
              <input
                value={newProvider.api_key_env}
                onChange={(e) => setNewProvider((p) => ({ ...p, api_key_env: e.target.value }))}
                placeholder="OPENROUTER_API_KEY"
                className="w-full bg-background border border-input rounded-lg px-3 py-2 text-[13px] font-mono focus:border-primary focus:ring-2 focus:ring-primary/10 focus:outline-none"
              />
            </Field>
            <Field label="Priority" hint="1 is highest">
              <input
                type="number"
                value={newProvider.priority}
                onChange={(e) => setNewProvider((p) => ({ ...p, priority: +e.target.value }))}
                className="w-full bg-background border border-input rounded-lg px-3 py-2 text-[13px] focus:border-primary focus:ring-2 focus:ring-primary/10 focus:outline-none"
              />
            </Field>
          </div>
          <div className="flex gap-2 pt-1">
            <button onClick={handleAddProvider} className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-[13px] font-medium hover:bg-primary/90 transition-all shadow-card">
              Create provider
            </button>
            <button onClick={() => setShowAdd(false)} className="px-4 py-2 border border-border rounded-lg text-[13px] font-medium text-muted-foreground hover:text-foreground transition-all">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Env var fallback reference */}
      <section className="bg-card border border-card-border rounded-xl p-6 shadow-card">
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="text-[15px] font-serif font-semibold text-foreground tracking-tight">Environment variable fallback</h2>
          <span className="text-[11.5px] text-muted-foreground">Used when no key is pasted</span>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-3">
          {[
            { env: "OPENAI_API_KEY", provider: "OpenAI" },
            { env: "ANTHROPIC_API_KEY", provider: "Anthropic" },
            { env: "GEMINI_API_KEY", provider: "Google Gemini" },
            { env: "OLLAMA_BASE_URL", provider: "Ollama (URL only)" },
          ].map((item) => (
            <div key={item.env} className="flex items-center gap-3 py-1">
              <code className="font-mono text-[11.5px] text-foreground bg-secondary border border-border px-2 py-1 rounded">{item.env}</code>
              <span className="text-[12.5px] text-muted-foreground">{item.provider}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[12px] font-medium text-foreground block mb-1.5">{label}</label>
      {children}
      {hint && <div className="text-[11px] text-muted-foreground mt-1">{hint}</div>}
    </div>
  );
}
