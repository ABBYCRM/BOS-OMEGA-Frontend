import {
  useListProviders, useCreateProvider, useUpdateProvider, useDeleteProvider,
  useSetProviderApiKey, useClearProviderApiKey,
  useTestProvider, useDiscoverProviderModels,
  getListProvidersQueryKey,
} from "@workspace/api-client-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "wouter";
import {
  Plus, Key, Trash2, CheckCircle2, XCircle, Loader2,
  Eye, EyeOff, AlertCircle, Sparkles, Zap, ShieldCheck, Lock, Database,
  Palette, Monitor, Brain, RotateCcw, Save, Pin,
  MonitorCog, Cpu, Skull, Leaf, Star, Cog, Zap as Bolt, Square,
} from "lucide-react";
import { ProviderStatusBadge } from "@/components/StatusBadge";
import { useTheme, type ThemeId } from "@/lib/theme";

// Each option carries a 4-stop gradient used to render a tiny preview
// swatch so the user can see the palette before clicking. Keep the
// stops loosely aligned with the CSS variables defined for the theme
// in `index.css` so the swatch and the applied theme look related.
type ThemeOption = {
  id: ThemeId;
  label: string;
  desc: string;
  icon: typeof Palette;
  swatch: [string, string, string, string];
};
const THEME_OPTIONS: ThemeOption[] = [
  { id: "retro95",    label: "Windows 95",          desc: "Pixelated bevels, MS Sans Serif, system gray.",        icon: Palette,    swatch: ["#c0c0c0", "#000080", "#ffffff", "#808080"] },
  { id: "retro98",    label: "Windows 98",          desc: "Refined Win98 grays with title-bar gradient blue.",    icon: Monitor,    swatch: ["#d4d0c8", "#0a246a", "#a6caf0", "#808080"] },
  { id: "modern",     label: "Modern",              desc: "Warm-cream enterprise skin with rounded cards.",       icon: MonitorCog, swatch: ["#faf8f4", "#232b3a", "#cb6643", "#e7e0d3"] },
  { id: "cyberdine",  label: "Cyberdyne",           desc: "Terminator HUD: red glow on black, mono terminal.",    icon: Cpu,        swatch: ["#0a0a0a", "#ff0000", "#ff5533", "#330000"] },
  { id: "umbrella",   label: "Umbrella Corp",       desc: "Resident Evil corporate: blood red on white + black.", icon: Skull,      swatch: ["#ffffff", "#c10c0c", "#1a1a1a", "#e5e5e5"] },
  { id: "capybara",   label: "Capybara",            desc: "Cozy sage + cream pastel, very rounded, friendly.",    icon: Leaf,       swatch: ["#f5ecdc", "#7a8a4f", "#c89b7b", "#4a3826"] },
  { id: "anime",      label: "Anime",               desc: "Hot pink + cyan + manga ink, chunky drop shadows.",    icon: Star,       swatch: ["#fffafd", "#ff4b8b", "#00d4ff", "#1a1a1a"] },
  { id: "steampunk",  label: "Steampunk",           desc: "Parchment + brass + dark wood, serif typography.",     icon: Cog,        swatch: ["#f3e9d2", "#6b4423", "#b08d57", "#2b1d10"] },
  { id: "neonpunk",   label: "Neon Punk",           desc: "Cyberpunk grid: neon magenta + cyan on indigo black.", icon: Bolt,       swatch: ["#0a0014", "#ff00aa", "#00f0ff", "#270050"] },
  { id: "ultraclean", label: "Ultra Clean",         desc: "Pure white, jet black accents, minimalist hairlines.", icon: Square,     swatch: ["#ffffff", "#000000", "#525252", "#e5e5e5"] },
];

function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  const active = THEME_OPTIONS.find((o) => o.id === theme);
  return (
    <section className="bg-card border border-card-border rounded-xl p-6 shadow-card space-y-4">
      <div className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-[15px] font-serif font-semibold text-foreground tracking-tight">Appearance</h2>
          <p className="text-[12.5px] text-muted-foreground mt-0.5">
            Pick a skin. Applied instantly on every page; remembered across reloads and tabs.
          </p>
        </div>
        <span className="text-[11.5px] text-muted-foreground">
          Active: <span className="font-medium text-foreground">{active?.label ?? theme}</span>
        </span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
        {THEME_OPTIONS.map((o) => {
          const Icon = o.icon;
          const isActive = theme === o.id;
          return (
            <button
              key={o.id}
              type="button"
              onClick={() => setTheme(o.id)}
              data-testid={`button-theme-${o.id}`}
              aria-pressed={isActive}
              className={`flex flex-col items-start gap-2 p-3 rounded-lg border text-left transition-all ${
                isActive
                  ? "bg-secondary border-foreground/30 ring-2 ring-primary/20"
                  : "bg-background border-border hover:bg-secondary/60"
              }`}
            >
              {/* Palette swatch — 4 stops from the theme's CSS variables */}
              <div className="flex w-full h-7 rounded overflow-hidden border border-border/60">
                {o.swatch.map((color, i) => (
                  <div key={i} className="flex-1" style={{ background: color }} />
                ))}
              </div>
              <div className="flex items-center gap-1.5 w-full">
                <Icon className={`w-3.5 h-3.5 ${isActive ? "text-foreground" : "text-muted-foreground"}`} />
                <span className="text-[12.5px] font-medium text-foreground truncate">{o.label}</span>
                {isActive && (
                  <span className="ml-auto text-[9px] px-1 py-0.5 rounded bg-foreground/10 text-foreground font-semibold uppercase tracking-wide flex-shrink-0">
                    On
                  </span>
                )}
              </div>
              <span className="text-[11px] leading-snug text-muted-foreground line-clamp-2">{o.desc}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

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

// Task #59: per-user memory budget overrides.
//
// Shape returned by GET/PUT/DELETE /api/memory/budgets. Mirrors the server
// response in artifacts/api-server/src/routes/memory.ts. Kept inline rather
// than going through generated client codegen because the endpoints are
// small and self-contained — adding them to openapi.yaml would force a
// codegen regeneration step for every other consumer.
type BudgetLayer = "canon" | "continuity" | "patches" | "scratchpad";
type MemoryBudgets = Record<BudgetLayer, number>;
type BudgetsResponse = {
  budgets: MemoryBudgets;
  defaults: MemoryBudgets;
  has_override: boolean;
  // `per_layer_min` (added in Task #59 follow-up) lets the UI enforce
  // canon's hard floor (MIN_CANON_BUDGET) without bricking task execution
  // when canon=0. Older servers that don't include the field fall back to
  // `min_per_layer` for every layer.
  limits: {
    min_per_layer: number;
    max_per_layer: number;
    max_total: number;
    per_layer_min?: Partial<Record<BudgetLayer, number>>;
  };
};

const BUDGETS_QUERY_KEY = ["/api/memory/budgets"] as const;

async function fetchBudgets(): Promise<BudgetsResponse> {
  const r = await fetch("/api/memory/budgets", {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`GET /api/memory/budgets failed: ${r.status}`);
  return (await r.json()) as BudgetsResponse;
}

async function putBudgets(values: MemoryBudgets): Promise<BudgetsResponse> {
  const r = await fetch("/api/memory/budgets", {
    method: "PUT",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(values),
  });
  if (!r.ok) {
    let detail = "";
    try {
      const body = (await r.json()) as { error?: string };
      detail = body.error ?? "";
    } catch {
      /* keep default */
    }
    throw new Error(detail || `PUT /api/memory/budgets failed: ${r.status}`);
  }
  return (await r.json()) as BudgetsResponse;
}

async function deleteBudgets(): Promise<BudgetsResponse> {
  const r = await fetch("/api/memory/budgets", {
    method: "DELETE",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`DELETE /api/memory/budgets failed: ${r.status}`);
  return (await r.json()) as BudgetsResponse;
}

const LAYER_ROWS: { key: BudgetLayer; label: string; help: string }[] = [
  { key: "canon",       label: "Canon",       help: "Behavior contract: Tri-State labels, greeting style, uncertainty handling." },
  { key: "continuity",  label: "Continuity",  help: "Carry-over notes from prior tasks (project facts, decisions, recurring people)." },
  { key: "patches",     label: "Patches",     help: "Targeted corrections that overlay canon (one-off rule fixes)." },
  { key: "scratchpad",  label: "Scratchpad",  help: "Short-lived working notes the model may consult mid-task." },
];

function MemoryBudgetsCard() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: BUDGETS_QUERY_KEY,
    queryFn: fetchBudgets,
    retry: false,
  });

  // Local draft state — initialized from the server response, only diffed
  // on Save. Editing a field while a fetch is in flight does NOT clobber
  // the user's typing because the effect below only seeds when draft is
  // null (i.e. before first response).
  const [draft, setDraft] = useState<MemoryBudgets | null>(null);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    if (!data) return;
    setDraft((prev) => prev ?? { ...data.budgets });
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: (values: MemoryBudgets) => putBudgets(values),
    onSuccess: (resp) => {
      queryClient.setQueryData(BUDGETS_QUERY_KEY, resp);
      setDraft({ ...resp.budgets });
      setFeedback({ kind: "ok", text: "Memory budgets saved." });
    },
    onError: (err: Error) => {
      setFeedback({ kind: "err", text: err.message || "Failed to save budgets." });
    },
  });

  const resetMutation = useMutation({
    mutationFn: () => deleteBudgets(),
    onSuccess: (resp) => {
      queryClient.setQueryData(BUDGETS_QUERY_KEY, resp);
      setDraft({ ...resp.budgets });
      setFeedback({ kind: "ok", text: "Reverted to engine defaults." });
    },
    onError: (err: Error) => {
      setFeedback({ kind: "err", text: err.message || "Failed to reset budgets." });
    },
  });

  // Auto-clear the success/error banner after a moment so it doesn't
  // linger — matches the UX of similar inline feedback elsewhere on the
  // page.
  useEffect(() => {
    if (!feedback) return;
    const t = window.setTimeout(() => setFeedback(null), 3500);
    return () => window.clearTimeout(t);
  }, [feedback]);

  const renderBody = () => {
    if (isLoading) {
      return (
        <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground" data-testid="memory-budgets-loading">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading budgets…
        </div>
      );
    }
    if (error || !data || !draft) {
      return (
        <div
          className="text-[12.5px] text-amber-700 inline-flex items-center gap-2"
          data-testid="memory-budgets-error"
        >
          <AlertCircle className="w-4 h-4" />
          Couldn't load budgets — sign in is required to manage per-user budgets.
        </div>
      );
    }

    // Per-layer minimum: canon has a hard floor (MIN_CANON_BUDGET on the
    // server) so a misconfiguration can't brick task execution. Other
    // layers default to the global min (0 — disabled).
    const minFor = (layer: BudgetLayer): number =>
      data.limits.per_layer_min?.[layer] ?? data.limits.min_per_layer;

    const total =
      draft.canon + draft.continuity + draft.patches + draft.scratchpad;
    const overTotal = total > data.limits.max_total;
    const anyOutOfRange = LAYER_ROWS.some((row) => {
      const v = draft[row.key];
      return !Number.isFinite(v) || v < minFor(row.key) || v > data.limits.max_per_layer;
    });
    const dirty = LAYER_ROWS.some((row) => draft[row.key] !== data.budgets[row.key]);
    const saveDisabled = saveMutation.isPending || overTotal || anyOutOfRange || !dirty;

    return (
      <>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {LAYER_ROWS.map((row) => {
            const value = draft[row.key];
            const def = data.defaults[row.key];
            const min = minFor(row.key);
            const oor =
              !Number.isFinite(value) ||
              value < min ||
              value > data.limits.max_per_layer;
            return (
              <div key={row.key}>
                <label className="text-[12px] font-medium text-foreground block mb-1.5 flex items-center justify-between">
                  <span className="uppercase tracking-wide font-mono text-[11px]">
                    {row.label}
                  </span>
                  <span className="text-[11px] text-muted-foreground font-normal">
                    default {def.toLocaleString()}
                  </span>
                </label>
                <input
                  type="number"
                  min={min}
                  max={data.limits.max_per_layer}
                  step={50}
                  value={Number.isFinite(value) ? value : ""}
                  onChange={(e) => {
                    const next = e.target.value === "" ? NaN : Number(e.target.value);
                    setDraft((d) =>
                      d ? { ...d, [row.key]: Number.isFinite(next) ? Math.round(next) : NaN } : d,
                    );
                  }}
                  data-testid={`input-budget-${row.key}`}
                  className={`w-full bg-background border rounded-lg px-3 py-2 text-[13px] font-mono focus:ring-2 focus:ring-primary/10 focus:outline-none ${
                    oor ? "border-amber-500 focus:border-amber-500" : "border-input focus:border-primary"
                  }`}
                />
                <div className="text-[11px] text-muted-foreground mt-1">{row.help}</div>
                {oor && (
                  <div
                    className="text-[11px] text-amber-700 mt-1"
                    data-testid={`budget-error-${row.key}`}
                  >
                    Must be between {min.toLocaleString()} and{" "}
                    {data.limits.max_per_layer.toLocaleString()}.
                    {row.key === "canon" && min > 0 && (
                      <> Canon can't go below {min.toLocaleString()} — at least one canon entry must fit.</>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-border">
          <div className="text-[12px] font-mono" data-testid="memory-budgets-total">
            <span className={overTotal ? "text-amber-700 font-bold" : "text-muted-foreground"}>
              Total: {total.toLocaleString()}
            </span>{" "}
            <span className="text-muted-foreground">/ {data.limits.max_total.toLocaleString()} max</span>
            {data.has_override && (
              <span
                className="ml-3 text-[10.5px] text-foreground bg-secondary border border-border px-2 py-0.5 rounded uppercase tracking-wide"
                data-testid="memory-budgets-override-badge"
              >
                Override active
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {feedback && (
              <span
                className={`text-[11.5px] inline-flex items-center gap-1 ${
                  feedback.kind === "ok" ? "text-emerald-700" : "text-amber-700"
                }`}
                data-testid={`memory-budgets-feedback-${feedback.kind}`}
              >
                {feedback.kind === "ok" ? (
                  <CheckCircle2 className="w-3.5 h-3.5" />
                ) : (
                  <AlertCircle className="w-3.5 h-3.5" />
                )}
                {feedback.text}
              </span>
            )}
            <button
              type="button"
              onClick={() => resetMutation.mutate()}
              disabled={resetMutation.isPending || (!data.has_override && !dirty)}
              data-testid="button-reset-budgets"
              className="px-3 py-1.5 border border-border rounded-lg text-[12px] font-medium text-muted-foreground hover:text-foreground hover:bg-secondary transition-all inline-flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
              title="Delete your overrides; the orchestrator will use engine defaults."
            >
              {resetMutation.isPending ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RotateCcw className="w-3.5 h-3.5" />
              )}
              Reset to defaults
            </button>
            <button
              type="button"
              onClick={() => draft && saveMutation.mutate(draft)}
              disabled={saveDisabled}
              data-testid="button-save-budgets"
              className="px-4 py-1.5 bg-primary text-primary-foreground rounded-lg text-[12px] font-medium hover:bg-primary/90 transition-all shadow-card inline-flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saveMutation.isPending ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Save className="w-3.5 h-3.5" />
              )}
              Save budgets
            </button>
          </div>
        </div>

        {overTotal && (
          <div
            className="text-[11.5px] text-amber-700 inline-flex items-center gap-1.5"
            data-testid="memory-budgets-over-total"
          >
            <AlertCircle className="w-3.5 h-3.5" />
            Total exceeds the {data.limits.max_total.toLocaleString()}-token cap. Lower a layer to save.
          </div>
        )}
      </>
    );
  };

  return (
    <section
      className="bg-card border border-card-border rounded-xl p-6 shadow-card space-y-4"
      data-testid="memory-budgets-card"
    >
      <div className="flex items-baseline justify-between">
        <div>
          <h2 className="text-[15px] font-serif font-semibold text-foreground tracking-tight inline-flex items-center gap-2">
            <Brain className="w-4 h-4 text-primary" />
            Memory budgets
          </h2>
          <p className="text-[12.5px] text-muted-foreground mt-0.5">
            Per-layer token ceilings the orchestrator uses when packing memory into each task.
            Raise a layer to fit more notes, lower it to leave more room for the model's reply.
          </p>
        </div>
      </div>
      {renderBody()}
    </section>
  );
}

// Task #67 — Lattice continuity scratchpad list.
//
// Lists the caller's scratchpad memory rows (auto-summary writes + manual
// pins + freeform notes). Read/delete only — pins are created from the
// chat surface (PinButton in MessageList.tsx), and auto-summaries are
// written by the pipeline after every successful task. Source badges
// help the user tell apart what they pinned vs what the system wrote.
type ScratchpadSource = "auto_summary" | "manual_pin" | "manual" | string;
type ScratchpadEntry = {
  id: string;
  user_id: string | null;
  layer: string;
  title: string;
  content: string;
  authority_level: number;
  source: ScratchpadSource;
  // Task #67 — link back to the task whose completion produced (for
  // auto_summary) or whose answer was pinned (for manual_pin) this row.
  // Nullable for legacy/freeform notes.
  source_task_id: string | null;
  created_at: string;
  updated_at: string;
};

const SCRATCHPAD_QUERY_KEY = ["/api/scratchpad"] as const;

async function fetchScratchpad(): Promise<ScratchpadEntry[]> {
  const r = await fetch("/api/scratchpad", {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`GET /api/scratchpad failed: ${r.status}`);
  return (await r.json()) as ScratchpadEntry[];
}

async function deleteScratchpadEntry(id: string): Promise<void> {
  const r = await fetch(`/api/scratchpad/${id}`, {
    method: "DELETE",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!r.ok && r.status !== 204) throw new Error(`DELETE /api/scratchpad/${id} failed: ${r.status}`);
}

function ScratchpadSourceBadge({ source }: { source: ScratchpadSource }) {
  const cfg =
    source === "manual_pin"   ? { label: "PINNED",  cls: "bg-emerald-100 text-emerald-800 border-emerald-200" } :
    source === "auto_summary" ? { label: "AUTO",    cls: "bg-amber-100 text-amber-800 border-amber-200" } :
                                { label: "MANUAL",  cls: "bg-stone-100 text-stone-800 border-stone-200" };
  return (
    <span
      className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded border tracking-wider ${cfg.cls}`}
      data-testid={`scratchpad-source-${source}`}
    >
      {cfg.label}
    </span>
  );
}

function ScratchpadCard() {
  const queryClient = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: SCRATCHPAD_QUERY_KEY,
    queryFn: fetchScratchpad,
    retry: false,
  });
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const removeMutation = useMutation({
    mutationFn: (id: string) => deleteScratchpadEntry(id),
    onSuccess: (_void, id) => {
      // Optimistically drop the row so the UI updates without a round trip;
      // refetch on the side to reconcile against the server.
      queryClient.setQueryData<ScratchpadEntry[]>(SCRATCHPAD_QUERY_KEY, (prev) =>
        prev ? prev.filter((e) => e.id !== id) : prev,
      );
      setFeedback({ kind: "ok", text: "Scratchpad entry removed." });
      void refetch();
    },
    onError: (err: Error) => {
      setFeedback({ kind: "err", text: err.message || "Delete failed." });
    },
  });

  useEffect(() => {
    if (!feedback) return;
    const t = window.setTimeout(() => setFeedback(null), 3500);
    return () => window.clearTimeout(t);
  }, [feedback]);

  const handleDelete = (entry: ScratchpadEntry) => {
    if (!confirm(`Remove this scratchpad entry?\n\n"${entry.title}"`)) return;
    removeMutation.mutate(entry.id);
  };

  const renderBody = () => {
    if (isLoading) {
      return (
        <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground" data-testid="scratchpad-loading">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading scratchpad…
        </div>
      );
    }
    if (error) {
      return (
        <div className="text-[12.5px] text-amber-700 inline-flex items-center gap-2" data-testid="scratchpad-error">
          <AlertCircle className="w-4 h-4" />
          Couldn't load scratchpad — sign in is required to view your continuity entries.
        </div>
      );
    }
    if (!data || data.length === 0) {
      return (
        <div className="text-[12.5px] text-muted-foreground" data-testid="scratchpad-empty">
          No scratchpad entries yet. Auto-summaries appear after each task; manual pins
          appear when you click <span className="inline-flex items-center gap-1 align-baseline"><Pin className="w-3 h-3" /> Pin</span> on
          an assistant message.
        </div>
      );
    }

    const counts = {
      auto: data.filter((e) => e.source === "auto_summary").length,
      pinned: data.filter((e) => e.source === "manual_pin").length,
      manual: data.filter((e) => e.source !== "auto_summary" && e.source !== "manual_pin").length,
    };

    return (
      <>
        <div className="flex items-center gap-3 text-[11px] font-mono text-muted-foreground" data-testid="scratchpad-counts">
          <span><span className="text-foreground font-bold">{data.length}</span> total</span>
          <span>·</span>
          <span><span className="text-emerald-700 font-bold">{counts.pinned}</span> pinned</span>
          <span>·</span>
          <span><span className="text-amber-700 font-bold">{counts.auto}</span> auto</span>
          <span>·</span>
          <span><span className="text-foreground font-bold">{counts.manual}</span> manual</span>
        </div>

        <ul className="divide-y divide-border border border-border rounded-lg overflow-hidden" data-testid="scratchpad-list">
          {data.map((entry) => (
            <li
              key={entry.id}
              className="px-3 py-2.5 bg-background flex items-start gap-3"
              data-testid={`scratchpad-entry-${entry.id}`}
            >
              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <ScratchpadSourceBadge source={entry.source} />
                  <span className="text-[12.5px] font-medium text-foreground truncate" title={entry.title}>
                    {entry.title}
                  </span>
                  {/* Task #67 — clickable source-task link when known.
                      Routes to the existing task detail page so the user
                      can jump from a continuity row back to the original
                      conversation that produced it. Hidden when the row
                      has no source task (legacy/freeform notes). */}
                  {entry.source_task_id && (
                    <Link
                      to={`/tasks/${entry.source_task_id}`}
                      className="text-[10px] font-mono text-primary hover:underline whitespace-nowrap"
                      data-testid={`link-source-task-${entry.id}`}
                      title={`Open source task ${entry.source_task_id}`}
                    >
                      task {entry.source_task_id.slice(0, 8)}
                    </Link>
                  )}
                  <span
                    className="text-[10px] font-mono text-muted-foreground ml-auto whitespace-nowrap"
                    data-testid={`scratchpad-created-${entry.id}`}
                    title={`Created ${new Date(entry.created_at).toISOString()}`}
                  >
                    {new Date(entry.created_at).toLocaleString()}
                  </span>
                </div>
                <p className="text-[11.5px] text-muted-foreground font-mono whitespace-pre-wrap line-clamp-3 select-text">
                  {entry.content}
                </p>
              </div>
              <button
                type="button"
                onClick={() => handleDelete(entry)}
                disabled={removeMutation.isPending}
                data-testid={`button-delete-scratchpad-${entry.id}`}
                className="text-muted-foreground hover:text-red-700 hover:bg-red-50 rounded-md p-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                title="Remove this scratchpad entry"
                aria-label="Remove scratchpad entry"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </li>
          ))}
        </ul>

        {feedback && (
          <div
            className={`text-[11.5px] inline-flex items-center gap-1 ${
              feedback.kind === "ok" ? "text-emerald-700" : "text-amber-700"
            }`}
            data-testid={`scratchpad-feedback-${feedback.kind}`}
          >
            {feedback.kind === "ok" ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
            {feedback.text}
          </div>
        )}
      </>
    );
  };

  return (
    <section
      className="bg-card border border-card-border rounded-xl p-6 shadow-card space-y-4"
      data-testid="scratchpad-card"
    >
      <div className="flex items-baseline justify-between">
        <div>
          <h2 className="text-[15px] font-serif font-semibold text-foreground tracking-tight inline-flex items-center gap-2">
            <Pin className="w-4 h-4 text-primary" />
            Scratchpad continuity
          </h2>
          <p className="text-[12.5px] text-muted-foreground mt-0.5">
            Per-user notes that BOS-Omega reads back into later tasks. Auto-summaries are
            written after every successful task; pins are deliberate signals you create
            from the chat. Remove anything you no longer want carried forward.
          </p>
        </div>
      </div>
      {renderBody()}
    </section>
  );
}

// Task #69 — recent lattice exports.
//
// Lists the last 10 lattice exports the caller initiated so the user can
// see, at a glance, when they last exported their continuity blob and
// what the integrity hash was. Read-only; the actual export action lives
// in the LatticeMenu user-menu component (Layout top bar).
type LatticeExportRow = {
  id: string;
  user_id: string;
  fidelity_sha256: string;
  byte_size: number;
  task_count: number;
  created_at: string;
};

const LATTICE_EXPORTS_QUERY_KEY = ["/api/lattice/exports"] as const;

async function fetchLatticeExports(): Promise<LatticeExportRow[]> {
  const r = await fetch("/api/lattice/exports", {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`GET /api/lattice/exports failed: ${r.status}`);
  return (await r.json()) as LatticeExportRow[];
}

function RecentLatticeExportsCard() {
  const { data, isLoading, error } = useQuery({
    queryKey: LATTICE_EXPORTS_QUERY_KEY,
    queryFn: fetchLatticeExports,
    retry: false,
  });

  const renderBody = () => {
    if (isLoading) {
      return (
        <div
          className="flex items-center gap-2 text-[12.5px] text-muted-foreground"
          data-testid="lattice-exports-loading"
        >
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading recent exports…
        </div>
      );
    }
    if (error || !data) {
      return (
        <div
          className="text-[12.5px] text-amber-700 inline-flex items-center gap-2"
          data-testid="lattice-exports-error"
        >
          <AlertCircle className="w-4 h-4" />
          Couldn't load recent exports.
        </div>
      );
    }
    if (data.length === 0) {
      return (
        <div className="text-[12.5px] text-muted-foreground" data-testid="lattice-exports-empty">
          No lattice exports yet. Use the <span className="font-medium text-foreground">Lattice</span>{" "}
          menu in the top bar to export your continuity snapshot.
        </div>
      );
    }
    return (
      <div className="space-y-1.5" data-testid="lattice-exports-list">
        {data.map((row) => {
          const ts = new Date(row.created_at);
          const when = isNaN(ts.getTime()) ? row.created_at : ts.toLocaleString();
          return (
            <div
              key={row.id}
              className="flex items-center gap-3 px-3 py-2 rounded border border-border bg-background text-[11.5px] font-mono"
              data-testid={`lattice-export-row-${row.id}`}
            >
              <span className="text-muted-foreground" title={row.created_at}>
                {when}
              </span>
              <span className="ml-auto text-foreground" title={row.fidelity_sha256}>
                sha256 <span className="text-primary">{row.fidelity_sha256.slice(0, 12)}…</span>
              </span>
              <span className="text-muted-foreground">
                {row.byte_size.toLocaleString()} B
              </span>
              <span className="text-muted-foreground">
                {row.task_count} task{row.task_count === 1 ? "" : "s"}
              </span>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <section
      className="bg-card border border-card-border rounded-xl p-6 shadow-card space-y-4"
      data-testid="lattice-exports-card"
    >
      <div className="flex items-baseline justify-between">
        <div>
          <h2 className="text-[15px] font-serif font-semibold text-foreground tracking-tight inline-flex items-center gap-2">
            <Database className="w-4 h-4 text-primary" />
            Recent lattice exports
          </h2>
          <p className="text-[12.5px] text-muted-foreground mt-0.5">
            Last 10 continuity blobs you exported. Each row records the
            sha256 fidelity hash, byte size, and how many task transcripts
            were bundled — proof of when you took a snapshot.
          </p>
        </div>
      </div>
      {renderBody()}
    </section>
  );
}

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
          // One-click activation: save → test → if OK enable + discover.
          // Anything that fails surfaces in testResult; we never silently
          // flip the toggle on for a key that didn't authenticate.
          test.mutate({ id: provider.id }, {
            onSuccess: (r) => {
              setTestResult(r);
              invalidate();
              if (r.ok) {
                if (!provider.enabled) {
                  update.mutate(
                    { id: provider.id, data: { enabled: true } },
                    { onSuccess: invalidate },
                  );
                }
                discover.mutate({ id: provider.id }, {
                  onSuccess: (d) => {
                    setDiscoverResult({ discovered: d.discovered, newly_registered: d.newly_registered });
                    invalidate();
                  },
                });
              }
            },
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
              disabled={!keyInput.trim() || setKey.isPending || test.isPending || discover.isPending}
              data-testid={`button-save-activate-${provider.id}`}
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground rounded-lg text-[13px] font-medium hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-card whitespace-nowrap"
            >
              {(setKey.isPending || test.isPending || discover.isPending) ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
              {setKey.isPending ? "Saving…" : test.isPending ? "Testing…" : discover.isPending ? "Discovering…" : "Save & Activate"}
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
        <h1 className="text-2xl font-serif font-semibold text-foreground tracking-tight">Settings</h1>
        <p className="text-[13.5px] text-muted-foreground max-w-2xl">
          Configure appearance, tune per-layer memory budgets, connect language model providers,
          manage API keys, and let BOS-Omega automatically test credentials and discover models.
        </p>
      </header>

      {/* Appearance / theme */}
      <ThemeToggle />

      {/* Per-user memory budgets (Task #59) */}
      <MemoryBudgetsCard />

      {/* Lattice continuity scratchpad (Task #67) */}
      <ScratchpadCard />

      {/* Recent Lattice Exports (Task #69) */}
      <RecentLatticeExportsCard />

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
