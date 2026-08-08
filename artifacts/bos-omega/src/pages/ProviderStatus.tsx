import { useListProviders } from "@workspace/api-client-react";
import { Shield, Zap, Lock, Radio, Activity, Cpu, Server, Eye } from "lucide-react";

/**
 * BOS-OMEGA tactical provider matrix.
 *
 * Every LLM provider the runtime knows about is mapped to a NODE
 * codename + classification tier so the operator UI can present the
 * routing fabric as a tactical intelligence surface (the umbrella-corp
 * theme drives the visual). The mapping below mirrors the 18-node
 * matrix documented in lib/db/drizzle/migrations/0000_base_schema.sql
 * and the in-app /api/providers endpoint — keep the two in lockstep.
 *
 * Tier colors follow the same scheme as the live audit-trail / circuit
 * breaker chips at the top of the topbar.
 */
type ProviderMeta = {
  codename: string;
  tier: "PRIMARY" | "SECONDARY" | "LOCAL" | "CUSTOM";
  color: string;
  dot: string;
  glow: string; // box-shadow key for the status dot
  channel: "ENCRYPTED" | "LOCAL" | "CLEAR";
};

const NODE_COLORS = {
  emerald: { text: "text-emerald-400", dot: "bg-emerald-400", glow: "rgba(16,185,129,.6)" },
  orange:  { text: "text-orange-400",  dot: "bg-orange-400",  glow: "rgba(251,146,60,.6)" },
  blue:    { text: "text-blue-400",    dot: "bg-blue-400",    glow: "rgba(96,165,250,.6)" },
  violet:  { text: "text-violet-400",  dot: "bg-violet-400",  glow: "rgba(167,139,250,.6)" },
  cyan:    { text: "text-cyan-400",    dot: "bg-cyan-400",    glow: "rgba(34,211,238,.6)" },
  rose:    { text: "text-rose-400",    dot: "bg-rose-400",    glow: "rgba(251,113,133,.6)" },
  amber:   { text: "text-amber-400",   dot: "bg-amber-400",   glow: "rgba(251,191,36,.6)" },
  lime:    { text: "text-lime-400",    dot: "bg-lime-400",    glow: "rgba(163,230,53,.6)" },
  fuchsia: { text: "text-fuchsia-400", dot: "bg-fuchsia-400", glow: "rgba(232,121,249,.6)" },
  sky:     { text: "text-sky-400",     dot: "bg-sky-400",     glow: "rgba(56,189,248,.6)" },
  pink:    { text: "text-pink-400",    dot: "bg-pink-400",    glow: "rgba(244,114,182,.6)" },
  indigo:  { text: "text-indigo-400",  dot: "bg-indigo-400",  glow: "rgba(129,140,248,.6)" },
} as const;

/**
 * The full 18-node matrix. We match by provider id first (stable),
 * then by name (legacy fall-through). The codename / tier below
 * MUST match what's documented in:
 *   artifacts/api-server/src/db/seed.ts
 *   the live /api/providers response
 */
const NODE_MATRIX: Record<string, ProviderMeta> = {
  // PRIMARY — two live keys (OpenAI, xAI Grok) anchored as the
  // highest-priority nodes.
  prov_openai:    { codename: "ORACLE-1",  tier: "PRIMARY",   channel: "ENCRYPTED", ...NODE_COLORS.emerald },
  prov_anthropic: { codename: "SENTINEL-A",tier: "PRIMARY",   channel: "ENCRYPTED", ...NODE_COLORS.amber },
  // SECONDARY — Gemini (configured, no key yet).
  prov_gemini:    { codename: "APEX-G",    tier: "SECONDARY", channel: "ENCRYPTED", ...NODE_COLORS.blue },
  // LOCAL — on-prem / private / shadow routes.
  prov_ollama:    { codename: "SHADOW-L",  tier: "LOCAL",     channel: "LOCAL",     ...NODE_COLORS.violet },
  // CUSTOM — generic + per-vendor fan-out.
  prov_generic:   { codename: "NODE-GENE", tier: "CUSTOM",    channel: "ENCRYPTED", ...NODE_COLORS.cyan },
  prov_xai:       { codename: "NODE-XAI",  tier: "CUSTOM",    channel: "ENCRYPTED", ...NODE_COLORS.rose },
  prov_kimi:      { codename: "NODE-KIMI", tier: "CUSTOM",    channel: "ENCRYPTED", ...NODE_COLORS.pink },
  prov_bitdeer:   { codename: "NODE-BITD", tier: "CUSTOM",    channel: "ENCRYPTED", ...NODE_COLORS.amber },
  // NVIDIA NIM cluster — 10 parallel slots, one key each, fan-out
  // across all execution modes (boil-the-ocean, parallel, series).
  prov_nvidia_1:  { codename: "NODE-NVID·1",  tier: "CUSTOM", channel: "ENCRYPTED", ...NODE_COLORS.lime },
  prov_nvidia_2:  { codename: "NODE-NVID·2",  tier: "CUSTOM", channel: "ENCRYPTED", ...NODE_COLORS.lime },
  prov_nvidia_3:  { codename: "NODE-NVID·3",  tier: "CUSTOM", channel: "ENCRYPTED", ...NODE_COLORS.lime },
  prov_nvidia_4:  { codename: "NODE-NVID·4",  tier: "CUSTOM", channel: "ENCRYPTED", ...NODE_COLORS.lime },
  prov_nvidia_5:  { codename: "NODE-NVID·5",  tier: "CUSTOM", channel: "ENCRYPTED", ...NODE_COLORS.lime },
  prov_nvidia_6:  { codename: "NODE-NVID·6",  tier: "CUSTOM", channel: "ENCRYPTED", ...NODE_COLORS.lime },
  prov_nvidia_7:  { codename: "NODE-NVID·7",  tier: "CUSTOM", channel: "ENCRYPTED", ...NODE_COLORS.lime },
  prov_nvidia_8:  { codename: "NODE-NVID·8",  tier: "CUSTOM", channel: "ENCRYPTED", ...NODE_COLORS.lime },
  prov_nvidia_9:  { codename: "NODE-NVID·9",  tier: "CUSTOM", channel: "ENCRYPTED", ...NODE_COLORS.lime },
  prov_nvidia_10: { codename: "NODE-NVID·10", tier: "CUSTOM", channel: "ENCRYPTED", ...NODE_COLORS.lime },
};

const FALLBACK_BY_NAME: Record<string, ProviderMeta> = {
  openai:    { codename: "ORACLE-1",  tier: "PRIMARY",   channel: "ENCRYPTED", ...NODE_COLORS.emerald },
  anthropic: { codename: "SENTINEL-A",tier: "PRIMARY",   channel: "ENCRYPTED", ...NODE_COLORS.amber },
  gemini:    { codename: "APEX-G",    tier: "SECONDARY", channel: "ENCRYPTED", ...NODE_COLORS.blue },
  "google gemini": { codename: "APEX-G", tier: "SECONDARY", channel: "ENCRYPTED", ...NODE_COLORS.blue },
  ollama:    { codename: "SHADOW-L",  tier: "LOCAL",     channel: "LOCAL",     ...NODE_COLORS.violet },
  "generic api":  { codename: "NODE-GENE", tier: "CUSTOM", channel: "ENCRYPTED", ...NODE_COLORS.cyan },
  "xai (grok)":   { codename: "NODE-XAI",  tier: "CUSTOM", channel: "ENCRYPTED", ...NODE_COLORS.rose },
  "xai":          { codename: "NODE-XAI",  tier: "CUSTOM", channel: "ENCRYPTED", ...NODE_COLORS.rose },
  "kimi (moonshot ai)": { codename: "NODE-KIMI", tier: "CUSTOM", channel: "ENCRYPTED", ...NODE_COLORS.pink },
  "kimi":         { codename: "NODE-KIMI", tier: "CUSTOM",    channel: "ENCRYPTED", ...NODE_COLORS.pink },
  "bitdeer":      { codename: "NODE-BITD", tier: "CUSTOM",    channel: "ENCRYPTED", ...NODE_COLORS.amber },
};

function getProviderMeta(p: { id: string; name: string }): ProviderMeta {
  if (NODE_MATRIX[p.id]) return NODE_MATRIX[p.id];
  const byName = FALLBACK_BY_NAME[p.name.toLowerCase()];
  if (byName) return byName;
  // NVIDIA NIMs whose index > 10 also fall here.
  if (/nvidia.*\[(\d+)\]/i.test(p.name)) {
    const m = /nvidia.*\[(\d+)\]/i.exec(p.name);
    return {
      codename: `NODE-NVID·${m?.[1] ?? "?"}`,
      tier: "CUSTOM",
      channel: "ENCRYPTED",
      ...NODE_COLORS.lime,
    };
  }
  return {
    codename: `NODE-${p.name.replace(/[^A-Z0-9]/gi, "").slice(0, 4).toUpperCase() || "UNKN"}`,
    tier: "CUSTOM",
    channel: "ENCRYPTED",
    ...NODE_COLORS.fuchsia,
  };
}

const TIER_RANK: Record<ProviderMeta["tier"], number> = {
  PRIMARY: 0,
  SECONDARY: 1,
  LOCAL: 2,
  CUSTOM: 3,
};

export function ProviderStatus() {
  const { data: providers = [], isLoading } = useListProviders();

  const sorted = [...providers].sort(
    (a, b) =>
      TIER_RANK[getProviderMeta(a as { id: string; name: string }).tier] -
      TIER_RANK[getProviderMeta(b as { id: string; name: string }).tier],
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <Shield className="w-5 h-5 text-primary" />
        <div>
          <h1 className="text-xl font-serif font-semibold text-foreground tracking-tight">LLM Providers</h1>
          <p className="text-[12px] text-muted-foreground font-mono mt-0.5">CLASSIFIED · INTEL LAYER · ACCESS RESTRICTED</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60 animate-ping" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
          </span>
          <span className="text-[11px] font-mono text-emerald-600">UPLINK ACTIVE</span>
        </div>
      </div>

      {/* Transmission grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
        {isLoading ? (
          <div className="col-span-full bg-card border border-card-border rounded-lg p-8 text-center">
            <Radio className="w-4 h-4 text-muted-foreground animate-pulse mx-auto mb-2" />
            <div className="text-xs font-mono text-muted-foreground">Establishing secure channel…</div>
          </div>
        ) : sorted.length === 0 ? (
          <div className="col-span-full bg-card border border-card-border rounded-lg p-8 text-center">
            <Lock className="w-4 h-4 text-muted-foreground mx-auto mb-2" />
            <div className="text-xs font-mono text-muted-foreground">No provider nodes registered</div>
          </div>
        ) : (
          sorted.map((p: { id: string; name: string; enabled: boolean; priority: number; base_url?: string | null; status?: string }) => {
            const meta = getProviderMeta(p);
            const isUp = p.enabled && p.status !== "DOWN";
            return (
              <div
                key={p.id}
                className="relative bg-card border border-card-border rounded-lg p-4 flex items-center gap-4 overflow-hidden group"
                data-testid={`provider-card-${p.id}`}
              >
                {/* Tactical underglow — color matches tier */}
                <div
                  aria-hidden
                  className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none"
                  style={{
                    background: `radial-gradient(ellipse at 0% 50%, ${meta.glow} 0%, transparent 60%)`,
                  }}
                />
                {/* Status dot + ping */}
                <div className="relative flex-shrink-0">
                  <div
                    className={`w-2.5 h-2.5 rounded-full ${isUp ? meta.dot : "bg-muted-foreground"}`}
                    style={
                      isUp
                        ? { boxShadow: `0 0 10px ${meta.glow}, 0 0 4px ${meta.glow}` }
                        : undefined
                    }
                  />
                  {isUp && (
                    <div className={`absolute inset-0 rounded-full ${meta.dot} opacity-40 animate-ping`} />
                  )}
                </div>

                {/* Codename + tier */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span
                      className={`text-[12.5px] font-mono font-bold tracking-wider ${isUp ? meta.color : "text-muted-foreground"}`}
                      data-testid={`text-codename-${p.id}`}
                    >
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
                    {meta.channel === "LOCAL" && (
                      <span className="text-[9px] font-mono text-violet-600 border border-violet-200 px-1.5 py-0.5 rounded tracking-widest inline-flex items-center gap-0.5">
                        <Eye className="w-2 h-2" /> SHADOW
                      </span>
                    )}
                  </div>
                  <div className="text-[10.5px] font-mono text-muted-foreground truncate">
                    NODE · PRIORITY {p.priority} · {meta.channel} CHANNEL
                  </div>
                  <div className="text-[10px] font-mono text-muted-foreground/60 truncate">
                    {p.name}
                  </div>
                </div>

                {/* Signal strength bars */}
                <div className="flex items-end gap-0.5 h-7 flex-shrink-0">
                  {[3, 5, 7, 9, 11].map((h, i) => (
                    <div
                      key={i}
                      className={`w-1 rounded-sm transition-all ${
                        isUp && i < 4 ? meta.dot : "bg-muted-foreground/20"
                      }`}
                      style={{ height: `${h * 2}px` }}
                    />
                  ))}
                </div>

                {/* Channel icon */}
                <div className="flex-shrink-0 text-muted-foreground/40">
                  {meta.channel === "LOCAL" ? (
                    <Server className="w-3.5 h-3.5" />
                  ) : (
                    <Cpu className="w-3.5 h-3.5" />
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Classified footer */}
      <div className="border border-card-border rounded-lg p-4 bg-card">
        <div className="flex items-center gap-2 mb-3">
          <Activity className="w-3.5 h-3.5 text-primary" />
          <span className="text-[11px] font-mono font-bold text-primary tracking-wider">ROUTING MATRIX</span>
        </div>
        <div className="grid grid-cols-3 gap-4 text-center">
          {[
            { label: "NODES", value: sorted.length.toString() },
            {
              label: "ACTIVE",
              value: sorted.filter((p: { enabled: boolean }) => p.enabled).length.toString(),
            },
            { label: "PROTOCOL", value: "AES-256" },
          ].map((stat) => (
            <div key={stat.label}>
              <div className="text-[20px] font-mono font-bold text-foreground">{stat.value}</div>
              <div className="text-[9px] font-mono text-muted-foreground tracking-widest mt-0.5">{stat.label}</div>
            </div>
          ))}
        </div>
        <div className="mt-3 pt-3 border-t border-border grid grid-cols-4 gap-2 text-center">
          {[
            { tier: "PRIMARY",   count: sorted.filter((p) => getProviderMeta(p as { id: string; name: string }).tier === "PRIMARY").length },
            { tier: "SECONDARY", count: sorted.filter((p) => getProviderMeta(p as { id: string; name: string }).tier === "SECONDARY").length },
            { tier: "LOCAL",     count: sorted.filter((p) => getProviderMeta(p as { id: string; name: string }).tier === "LOCAL").length },
            { tier: "CUSTOM",    count: sorted.filter((p) => getProviderMeta(p as { id: string; name: string }).tier === "CUSTOM").length },
          ].map((s) => (
            <div key={s.tier} className="flex flex-col">
              <span className="text-[14px] font-mono font-bold text-foreground">{s.count}</span>
              <span className="text-[8.5px] font-mono text-muted-foreground tracking-widest">{s.tier}</span>
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
