import { useListProviders } from "@workspace/api-client-react";
import { Shield, Zap, Lock, Radio, Activity } from "lucide-react";

const PROVIDER_META: Record<string, { codename: string; tier: string; color: string; dot: string }> = {
  openai:          { codename: "ORACLE-1",   tier: "PRIMARY",   color: "text-emerald-400", dot: "bg-emerald-400" },
  anthropic:       { codename: "SENTINEL-A", tier: "PRIMARY",   color: "text-orange-400",  dot: "bg-orange-400" },
  gemini:          { codename: "APEX-G",     tier: "SECONDARY", color: "text-blue-400",    dot: "bg-blue-400" },
  "google gemini": { codename: "APEX-G",     tier: "SECONDARY", color: "text-blue-400",    dot: "bg-blue-400" },
  ollama:          { codename: "SHADOW-L",   tier: "LOCAL",     color: "text-violet-400",  dot: "bg-violet-400" },
};

function getProviderMeta(name: string) {
  const key = name.toLowerCase();
  return (
    PROVIDER_META[key] ||
    { codename: `NODE-${name.slice(0, 4).toUpperCase()}`, tier: "CUSTOM", color: "text-muted-foreground", dot: "bg-muted-foreground" }
  );
}

export function ProviderStatus() {
  const { data: providers = [], isLoading } = useListProviders();

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Shield className="w-5 h-5 text-primary" />
        <div>
          <h1 className="text-xl font-serif font-semibold text-foreground tracking-tight">LLM Providers</h1>
          <p className="text-[12px] text-muted-foreground font-mono mt-0.5">CLASSIFIED · INTEL LAYER · ACCESS RESTRICTED</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
          <span className="text-[11px] font-mono text-green-600">UPLINK ACTIVE</span>
        </div>
      </div>

      {/* Transmission grid */}
      <div className="grid grid-cols-1 gap-3">
        {isLoading ? (
          <div className="bg-card border border-card-border rounded-lg p-8 text-center">
            <Radio className="w-4 h-4 text-muted-foreground animate-pulse mx-auto mb-2" />
            <div className="text-xs font-mono text-muted-foreground">Establishing secure channel…</div>
          </div>
        ) : providers.length === 0 ? (
          <div className="bg-card border border-card-border rounded-lg p-8 text-center">
            <Lock className="w-4 h-4 text-muted-foreground mx-auto mb-2" />
            <div className="text-xs font-mono text-muted-foreground">No provider nodes registered</div>
          </div>
        ) : (
          providers.map((p: { id: string; name: string; enabled: boolean; priority: number }) => {
            const meta = getProviderMeta(p.name);
            return (
              <div
                key={p.id}
                className="bg-card border border-card-border rounded-lg p-5 flex items-center gap-5"
              >
                {/* Status dot */}
                <div className="relative flex-shrink-0">
                  <div className={`w-2.5 h-2.5 rounded-full ${p.enabled ? meta.dot : "bg-muted-foreground"}`} />
                  {p.enabled && (
                    <div className={`absolute inset-0 rounded-full ${meta.dot} opacity-30 animate-ping`} />
                  )}
                </div>

                {/* Codename + tier */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 mb-1">
                    <span className={`text-[13px] font-mono font-bold tracking-wider ${meta.color}`}>
                      {meta.codename}
                    </span>
                    <span className="text-[9px] font-mono text-muted-foreground border border-border px-1.5 py-0.5 rounded tracking-widest">
                      {meta.tier}
                    </span>
                    {!p.enabled && (
                      <span className="text-[9px] font-mono text-red-600 border border-red-200 px-1.5 py-0.5 rounded tracking-widest">
                        OFFLINE
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] font-mono text-muted-foreground">
                    NODE · PRIORITY {p.priority} · ENCRYPTED CHANNEL
                  </div>
                </div>

                {/* Signal strength bars */}
                <div className="flex items-end gap-0.5 h-6 flex-shrink-0">
                  {[3, 5, 7, 9, 11].map((h, i) => (
                    <div
                      key={i}
                      className={`w-1 rounded-sm transition-all ${
                        p.enabled && i < 4
                          ? meta.dot
                          : "bg-muted-foreground/20"
                      }`}
                      style={{ height: `${h * 2}px` }}
                    />
                  ))}
                </div>

                {/* Lock icon */}
                <div className="flex-shrink-0">
                  <Lock className="w-3.5 h-3.5 text-muted-foreground/40" />
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Classified footer */}
      <div className="border border-border rounded-lg p-4 bg-card">
        <div className="flex items-center gap-2 mb-3">
          <Activity className="w-3.5 h-3.5 text-primary" />
          <span className="text-[11px] font-mono font-bold text-primary tracking-wider">ROUTING MATRIX</span>
        </div>
        <div className="grid grid-cols-3 gap-4 text-center">
          {[
            { label: "NODES", value: providers.length.toString() },
            { label: "ACTIVE", value: providers.filter((p: { enabled: boolean }) => p.enabled).length.toString() },
            { label: "PROTOCOL", value: "AES-256" },
          ].map((stat) => (
            <div key={stat.label}>
              <div className="text-[18px] font-mono font-bold text-foreground">{stat.value}</div>
              <div className="text-[9px] font-mono text-muted-foreground tracking-widest mt-0.5">{stat.label}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Zap className="w-3 h-3 text-muted-foreground/40" />
        <p className="text-[11px] font-mono text-muted-foreground/60">
          CHANNEL DETAILS CLASSIFIED · OPERATOR CLEARANCE REQUIRED
        </p>
      </div>
    </div>
  );
}
