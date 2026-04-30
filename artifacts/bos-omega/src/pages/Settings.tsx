import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  CheckCircle2, AlertCircle, Loader2, Trash2,
  Brain, RotateCcw, Save, Pin,
  Palette, Monitor, MonitorCog, Cpu, Skull, Leaf, Star, Cog,
  Zap as Bolt, Square,
} from "lucide-react";
import { useTheme, type ThemeId } from "@/lib/theme";

// ======================================================================
// Theme options
// ======================================================================
type ThemeOption = {
  id: ThemeId;
  label: string;
  desc: string;
  icon: typeof Palette;
  swatch: [string, string, string, string];
};
const THEME_OPTIONS: ThemeOption[] = [
  { id: "retro95",    label: "Windows 95",        desc: "Pixelated bevels, MS Sans Serif, system gray.",                                                    icon: Palette,    swatch: ["#c0c0c0", "#000080", "#ffffff", "#808080"] },
  { id: "retro98",    label: "Windows 98",        desc: "Refined Win98 grays with title-bar gradient blue.",                                                icon: Monitor,    swatch: ["#d4d0c8", "#0a246a", "#a6caf0", "#808080"] },
  { id: "modern",     label: "Modern",            desc: "Warm-cream enterprise skin with rounded cards.",                                                   icon: MonitorCog, swatch: ["#faf8f4", "#232b3a", "#cb6643", "#e7e0d3"] },
  { id: "cyberdine",  label: "Cyberdyne",         desc: "Terminator HUD: red glow on black, mono terminal.",                                               icon: Cpu,        swatch: ["#0a0a0a", "#ff0000", "#ff5533", "#330000"] },
  { id: "umbrella",   label: "Umbrella",          desc: "Pitch black + Umbrella red, hex grid, dark cards with red borders.",                              icon: Skull,      swatch: ["#000000", "#1a0000", "#ED1C24", "#ffffff"] },
  { id: "umbrella-corp", label: "Umbrella Corp",  desc: "Tactical enterprise console: pitch black, corporate red, hex grid, beveled command panels.",      icon: Skull,      swatch: ["#050505", "#0b0b0c", "#d41414", "#ffffff"] },
  { id: "capybara",   label: "Capybara",          desc: "Cozy sage + cream pastel, very rounded, friendly.",                                               icon: Leaf,       swatch: ["#f5ecdc", "#7a8a4f", "#c89b7b", "#4a3826"] },
  { id: "anime",      label: "Anime",             desc: "Hot pink + cyan + manga ink, chunky drop shadows.",                                               icon: Star,       swatch: ["#fffafd", "#ff4b8b", "#00d4ff", "#1a1a1a"] },
  { id: "steampunk",  label: "Steampunk",         desc: "Parchment + brass + dark wood, serif typography.",                                                icon: Cog,        swatch: ["#f3e9d2", "#6b4423", "#b08d57", "#2b1d10"] },
  { id: "neonpunk",   label: "Neon Punk",         desc: "Cyberpunk grid: neon magenta + cyan on indigo black.",                                            icon: Bolt,       swatch: ["#0a0014", "#ff00aa", "#00f0ff", "#270050"] },
  { id: "ultraclean", label: "Ultra Clean",       desc: "Pure white, jet black accents, minimalist hairlines.",                                            icon: Square,     swatch: ["#ffffff", "#000000", "#525252", "#e5e5e5"] },
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

// ======================================================================
// Memory budgets
// ======================================================================
type BudgetLayer = "canon" | "continuity" | "patches" | "scratchpad";
type MemoryBudgets = Record<BudgetLayer, number>;
type BudgetsResponse = {
  budgets: MemoryBudgets;
  defaults: MemoryBudgets;
  has_override: boolean;
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
    mutationFn: deleteBudgets,
    onSuccess: (resp) => {
      queryClient.setQueryData(BUDGETS_QUERY_KEY, resp);
      setDraft({ ...resp.budgets });
      setFeedback({ kind: "ok", text: "Budgets reset to defaults." });
    },
    onError: (err: Error) => {
      setFeedback({ kind: "err", text: err.message || "Failed to reset budgets." });
    },
  });

  useEffect(() => {
    if (!feedback) return;
    const t = window.setTimeout(() => setFeedback(null), 3500);
    return () => window.clearTimeout(t);
  }, [feedback]);

  const totalUsed = draft ? Object.values(draft).reduce((a, b) => a + b, 0) : 0;
  const maxTotal = data?.limits.max_total ?? 0;
  const isSaving = saveMutation.isPending || resetMutation.isPending;

  const handleSave = () => {
    if (!draft) return;
    saveMutation.mutate(draft);
  };

  const handleReset = () => {
    if (!confirm("Reset all memory budgets to system defaults?")) return;
    resetMutation.mutate();
  };

  const setLayer = (key: BudgetLayer, raw: string) => {
    const val = parseInt(raw, 10);
    if (isNaN(val)) return;
    setDraft((prev) => (prev ? { ...prev, [key]: val } : prev));
  };

  const minFor = (key: BudgetLayer): number => {
    if (!data) return 0;
    return data.limits.per_layer_min?.[key] ?? data.limits.min_per_layer;
  };

  const renderBody = () => {
    if (isLoading) {
      return (
        <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground" data-testid="budgets-loading">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading memory budgets…
        </div>
      );
    }
    if (error || !data || !draft) {
      return (
        <div className="text-[12.5px] text-amber-700 inline-flex items-center gap-2" data-testid="budgets-error">
          <AlertCircle className="w-4 h-4" />
          Couldn't load memory budgets.
        </div>
      );
    }

    const totalPct = maxTotal > 0 ? Math.min(100, (totalUsed / maxTotal) * 100) : 0;

    return (
      <>
        <div className="flex items-center justify-between text-[11.5px] font-mono text-muted-foreground mb-1" data-testid="budgets-total-row">
          <span>Total used</span>
          <span className={totalUsed > maxTotal ? "text-amber-700 font-bold" : ""}>
            {totalUsed.toLocaleString()} / {maxTotal.toLocaleString()} tokens
          </span>
        </div>
        <div className="w-full h-1.5 bg-secondary rounded-full overflow-hidden mb-4">
          <div
            className={`h-full rounded-full transition-all ${totalUsed > maxTotal ? "bg-amber-500" : "bg-primary"}`}
            style={{ width: `${totalPct}%` }}
            data-testid="budgets-total-bar"
          />
        </div>

        <div className="space-y-3">
          {LAYER_ROWS.map(({ key, label, help }) => {
            const val = draft[key] ?? 0;
            const def = data.defaults[key] ?? 0;
            const mn = minFor(key);
            const mx = data.limits.max_per_layer;
            const pct = mx > 0 ? Math.min(100, (val / mx) * 100) : 0;
            const isDirty = val !== data.budgets[key];
            return (
              <div
                key={key}
                className="bg-background border border-border rounded-lg p-3 space-y-2"
                data-testid={`budget-layer-${key}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-medium text-foreground">{label}</span>
                      {isDirty && (
                        <span className="text-[9px] font-mono text-primary border border-primary/30 px-1 py-0.5 rounded">
                          MODIFIED
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-1">{help}</p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className="text-[11px] text-muted-foreground font-mono">default {def.toLocaleString()}</span>
                    <input
                      type="number"
                      value={val}
                      min={mn}
                      max={mx}
                      step={256}
                      onChange={(e) => setLayer(key, e.target.value)}
                      disabled={isSaving}
                      data-testid={`input-budget-${key}`}
                      className="w-24 bg-card border border-input rounded-md px-2 py-1 text-[12.5px] font-mono text-foreground text-right focus:border-primary focus:ring-1 focus:ring-primary/20 focus:outline-none disabled:opacity-40"
                    />
                  </div>
                </div>
                <div className="w-full h-1 bg-secondary rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full bg-primary/60 transition-all"
                    style={{ width: `${pct}%` }}
                    data-testid={`budget-bar-${key}`}
                  />
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-2 pt-2">
          <button
            onClick={handleSave}
            disabled={isSaving || !draft}
            data-testid="button-save-budgets"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-[12.5px] font-medium hover:bg-primary/90 transition-all shadow-card disabled:opacity-40"
          >
            {saveMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            Save budgets
          </button>
          <button
            onClick={handleReset}
            disabled={isSaving || !data.has_override}
            data-testid="button-reset-budgets"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-border rounded-lg text-[12.5px] font-medium text-muted-foreground hover:text-foreground transition-all disabled:opacity-40"
          >
            {resetMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
            Reset to defaults
          </button>
          {feedback && (
            <div
              className={`text-[11.5px] inline-flex items-center gap-1 ml-1 ${
                feedback.kind === "ok" ? "text-emerald-700" : "text-amber-700"
              }`}
              data-testid={`budget-feedback-${feedback.kind}`}
            >
              {feedback.kind === "ok" ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
              {feedback.text}
            </div>
          )}
        </div>
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

// ======================================================================
// Scratchpad continuity
// ======================================================================
type ScratchpadSource = "auto_summary" | "manual_pin" | "manual" | string;
type ScratchpadEntry = {
  id: string;
  user_id: string | null;
  layer: string;
  title: string;
  content: string;
  authority_level: number;
  source: ScratchpadSource;
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

// ======================================================================
// Page
// ======================================================================
export function Settings() {
  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-serif font-semibold text-foreground tracking-tight">Settings</h1>
        <p className="text-[13.5px] text-muted-foreground max-w-2xl">
          Configure appearance and tune per-layer memory budgets.
        </p>
      </header>

      <ThemeToggle />
      <MemoryBudgetsCard />
      <ScratchpadCard />
    </div>
  );
}
