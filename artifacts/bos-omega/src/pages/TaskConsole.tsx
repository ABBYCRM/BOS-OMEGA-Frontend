import { useState } from "react";
import { useCreateTask, useGetTaskStats, useGetRunSeriesPasses, useGetRunParallelAgents, useGetRunSynthesis, useGetRun } from "@workspace/api-client-react";
import type { BosOutput } from "@workspace/api-client-react";
import { TriStateBadge } from "@/components/StatusBadge";
import { TriStateVector } from "@/components/TriStateVector";
import { formatMs } from "@/lib/utils";
import {
  Send, ChevronDown, ChevronUp, Loader2, Layers, GitMerge, Vote,
  Zap, Flame, Bot, AlertTriangle, CheckCircle2, Clock, Award,
  ChevronRight,
} from "lucide-react";

type Mode = "auto" | "single" | "parallel" | "consensus" | "series_pass" | "boil_the_ocean";
type ExecutionTraceTab = "series" | "agents" | "synthesis";

const SERIES_ROLE_COLORS: Record<string, string> = {
  DRAFTER: "text-sky-400",
  CRITIC: "text-red-400",
  EXPANDER: "text-purple-400",
  ADVERSARY: "text-orange-400",
  SYNTHESIZER: "text-green-400",
  OMEGA_VALIDATOR: "text-primary",
};

const AGENT_ROLE_COLORS: Record<string, string> = {
  ARCHITECT: "text-sky-400",
  CRITIC: "text-red-400",
  RESEARCHER: "text-purple-400",
  BUILDER: "text-amber-400",
  VALIDATOR: "text-green-400",
};

function ScoreBar({ score }: { score?: number | null }) {
  if (score == null) return null;
  const pct = Math.round(score * 100);
  const color = pct >= 80 ? "bg-green-500" : pct >= 60 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1 bg-muted/50 rounded-full overflow-hidden">
        <div className={`h-full ${color} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] font-mono text-muted-foreground w-8">{pct}%</span>
    </div>
  );
}

function SeriesTrace({ run_id }: { run_id: string }) {
  const { data: passes, isLoading } = useGetRunSeriesPasses(run_id);

  if (isLoading) return <div className="text-xs font-mono text-muted-foreground py-4 text-center">Loading series passes…</div>;
  if (!passes?.length) return <div className="text-xs font-mono text-muted-foreground py-4 text-center">No series passes found</div>;

  return (
    <div className="space-y-2">
      {passes.map((pass) => (
        <div key={pass.id} className="border border-border rounded p-3 space-y-1.5">
          <div className="flex items-center gap-3">
            <span className="text-[10px] font-mono text-muted-foreground w-6">{pass.pass_number}</span>
            <span className={`text-xs font-mono font-bold ${SERIES_ROLE_COLORS[pass.role] ?? "text-foreground"}`}>{pass.role}</span>
            <span className="text-[10px] font-mono text-muted-foreground">{pass.provider}/{pass.model}</span>
            {pass.state && <TriStateBadge state={pass.state} />}
            <span className="ml-auto text-[10px] font-mono text-muted-foreground">{formatMs(pass.latency_ms)}</span>
          </div>
          {pass.validation_score != null && <ScoreBar score={pass.validation_score} />}
          {pass.errors_found && pass.errors_found.length > 0 && (
            <div className="text-[10px] font-mono text-red-400">
              Issues: {pass.errors_found.slice(0, 2).join(" · ")}
            </div>
          )}
          {pass.output_snapshot && (
            <p className="text-[11px] text-muted-foreground font-mono line-clamp-2 mt-1">{pass.output_snapshot.slice(0, 200)}</p>
          )}
        </div>
      ))}
    </div>
  );
}

function AgentsTrace({ run_id }: { run_id: string }) {
  const { data: agents, isLoading } = useGetRunParallelAgents(run_id);

  if (isLoading) return <div className="text-xs font-mono text-muted-foreground py-4 text-center">Loading agents…</div>;
  if (!agents?.length) return <div className="text-xs font-mono text-muted-foreground py-4 text-center">No agents found</div>;

  const by_provider = new Map<string, typeof agents>();
  for (const a of agents) {
    const key = `${a.provider}/${a.model}`;
    if (!by_provider.has(key)) by_provider.set(key, []);
    by_provider.get(key)!.push(a);
  }

  return (
    <div className="space-y-4">
      {Array.from(by_provider.entries()).map(([prov_model, prov_agents]) => (
        <div key={prov_model}>
          <div className="text-[10px] font-mono text-primary mb-2 tracking-wider">{prov_model}</div>
          <div className="grid grid-cols-5 gap-1.5">
            {prov_agents.map((agent) => (
              <div
                key={agent.id}
                className={`p-2 rounded border text-center ${
                  agent.status === "completed" ? "border-border bg-muted/20" : "border-red-900/40 bg-red-950/20"
                }`}
              >
                <div className={`text-[10px] font-mono font-bold mb-0.5 ${AGENT_ROLE_COLORS[agent.agent_role] ?? "text-foreground"}`}>
                  {agent.agent_role}
                </div>
                {agent.status === "completed" ? (
                  <>
                    {agent.state && <TriStateBadge state={agent.state} />}
                    <ScoreBar score={agent.score} />
                    <div className="text-[9px] font-mono text-muted-foreground mt-1">{formatMs(agent.latency_ms)}</div>
                  </>
                ) : (
                  <div className="text-[10px] font-mono text-red-400">{agent.error_type || "failed"}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function SynthesisTrace({ run_id }: { run_id: string }) {
  const { data: report, isLoading } = useGetRunSynthesis(run_id);

  if (isLoading) return <div className="text-xs font-mono text-muted-foreground py-4 text-center">Loading synthesis…</div>;
  if (!report) return <div className="text-xs font-mono text-muted-foreground py-4 text-center">No synthesis report</div>;

  let omega: { state?: string; schema_pass?: boolean; safety_pass?: boolean; completeness_pass?: boolean; notes?: string } = {};
  try {
    if (report.omega_validation) omega = JSON.parse(report.omega_validation);
  } catch {}

  return (
    <div className="space-y-4">
      {omega.state && (
        <div className="flex items-center gap-4">
          <div className="text-[10px] font-mono text-muted-foreground">OMEGA VALIDATION</div>
          <TriStateBadge state={omega.state} />
          <div className="flex gap-3 text-[10px] font-mono">
            <span className={omega.schema_pass ? "text-green-400" : "text-red-400"}>SCHEMA {omega.schema_pass ? "✓" : "✗"}</span>
            <span className={omega.safety_pass ? "text-green-400" : "text-red-400"}>SAFETY {omega.safety_pass ? "✓" : "✗"}</span>
            <span className={omega.completeness_pass ? "text-green-400" : "text-red-400"}>COMPLETE {omega.completeness_pass ? "✓" : "✗"}</span>
          </div>
        </div>
      )}
      {omega.notes && <p className="text-xs font-mono text-muted-foreground">{omega.notes}</p>}

      <div className="grid grid-cols-2 gap-4">
        {report.consensus_points && report.consensus_points.length > 0 && (
          <div>
            <div className="text-[10px] font-mono text-green-400 mb-1.5 tracking-wider">CONSENSUS</div>
            <ul className="space-y-1">
              {report.consensus_points.slice(0, 5).map((p, i) => (
                <li key={i} className="text-[11px] font-mono text-muted-foreground flex gap-1.5">
                  <span className="text-green-400">✓</span>{p}
                </li>
              ))}
            </ul>
          </div>
        )}
        {report.contradictions && report.contradictions.length > 0 && (
          <div>
            <div className="text-[10px] font-mono text-red-400 mb-1.5 tracking-wider">CONTRADICTIONS RESOLVED</div>
            <ul className="space-y-1">
              {report.contradictions.slice(0, 5).map((p, i) => (
                <li key={i} className="text-[11px] font-mono text-muted-foreground flex gap-1.5">
                  <span className="text-red-400">⚡</span>{p}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function ExecutionTrace({ run_id, mode }: { run_id: string; mode: string }) {
  const [activeTab, setActiveTab] = useState<ExecutionTraceTab>(
    mode === "series_pass" ? "series" : "agents"
  );
  const { data: run } = useGetRun(run_id);

  const tabs: Array<{ id: ExecutionTraceTab; label: string; show: boolean }> = [
    { id: "series", label: "SERIES PASSES", show: mode === "series_pass" },
    { id: "agents", label: "PARALLEL AGENTS", show: mode === "boil_the_ocean" },
    { id: "synthesis", label: "SYNTHESIS REPORT", show: mode === "boil_the_ocean" },
  ].filter((t) => t.show);

  return (
    <div className="border border-primary/25 rounded-lg overflow-hidden">
      <div className="bg-primary/10 border-b border-primary/25 px-4 py-2.5 flex items-center gap-4">
        <div className="flex items-center gap-2">
          <Bot className="w-3.5 h-3.5 text-primary" />
          <span className="text-[10px] font-mono font-bold text-primary tracking-wider">EXECUTION TRACE</span>
        </div>
        <span className="text-[10px] font-mono text-muted-foreground">{run_id.slice(0, 12)}…</span>
        {run?.run && (
          <>
            {run.run.total_passes && <span className="text-[10px] font-mono text-muted-foreground">{run.run.total_passes} passes</span>}
            {run.run.total_agents && <span className="text-[10px] font-mono text-muted-foreground">{run.run.total_agents} agents</span>}
            {run.run.final_score != null && (
              <div className="flex items-center gap-1.5">
                <Award className="w-3 h-3 text-amber-400" />
                <span className="text-[10px] font-mono text-amber-400">{(run.run.final_score * 100).toFixed(0)}%</span>
              </div>
            )}
          </>
        )}
      </div>

      <div className="flex border-b border-card-border">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 text-[10px] font-mono tracking-wider transition-colors ${
              activeTab === tab.id
                ? "text-primary border-b-2 border-primary"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="p-4">
        {activeTab === "series" && <SeriesTrace run_id={run_id} />}
        {activeTab === "agents" && <AgentsTrace run_id={run_id} />}
        {activeTab === "synthesis" && <SynthesisTrace run_id={run_id} />}
      </div>
    </div>
  );
}

type ModeOption = {
  value: Mode;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  desc: string;
  badge?: string;
  badgeColor?: string;
  cost?: "low" | "medium" | "high" | "extreme";
};

const MODE_OPTIONS: ModeOption[] = [
  {
    value: "auto",
    label: "AUTO",
    icon: Zap,
    desc: "BOS selects best mode based on task complexity",
    badge: "RECOMMENDED",
    badgeColor: "text-primary bg-primary/15 border-primary/30",
    cost: "medium",
  },
  {
    value: "single",
    label: "SINGLE",
    icon: Layers,
    desc: "Best model selected by router",
    cost: "low",
  },
  {
    value: "parallel",
    label: "PARALLEL",
    icon: GitMerge,
    desc: "Multiple models run concurrently, answers merged",
    cost: "medium",
  },
  {
    value: "consensus",
    label: "CONSENSUS",
    icon: Vote,
    desc: "Majority vote across models for reliability",
    cost: "medium",
  },
  {
    value: "series_pass",
    label: "SERIES PASS",
    icon: ChevronRight,
    desc: "DRAFTER→CRITIC→EXPANDER→ADVERSARY→SYNTHESIZER",
    badge: "5-ROLE CHAIN",
    badgeColor: "text-purple-400 bg-purple-400/10 border-purple-400/30",
    cost: "high",
  },
  {
    value: "boil_the_ocean",
    label: "BOIL THE OCEAN",
    icon: Flame,
    desc: "All models × 5 agents + synthesis + adversarial + Omega",
    badge: "MAXIMUM POWER",
    badgeColor: "text-red-400 bg-red-400/10 border-red-400/30",
    cost: "extreme",
  },
];

const COST_LABEL: Record<string, { label: string; color: string }> = {
  low: { label: "LOW COST", color: "text-green-400" },
  medium: { label: "MEDIUM COST", color: "text-amber-400" },
  high: { label: "HIGH COST", color: "text-orange-400" },
  extreme: { label: "EXTREME COST", color: "text-red-400" },
};

export function TaskConsole() {
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<Mode>("auto");
  const [parallelCount, setParallelCount] = useState(3);
  const [maxModels, setMaxModels] = useState(3);
  const [agentsPerModel, setAgentsPerModel] = useState(5);
  const [result, setResult] = useState<{
    task_id: string;
    task_type: string;
    tri_state: string;
    selected_provider?: string;
    selected_model?: string;
    final_status: string;
    final_output?: string;
    bos_output?: BosOutput;
    run_id?: string;
    execution_mode?: string;
  } | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  const createTask = useCreateTask();
  const { data: stats } = useGetTaskStats();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim()) return;

    createTask.mutate(
      {
        input: input.trim(),
        mode,
        parallel_models: parallelCount,
        max_models: maxModels,
        agents_per_model: agentsPerModel,
      },
      {
        onSuccess: (task: {
          id: string;
          task_type: string;
          tri_state: string;
          selected_provider?: string;
          selected_model?: string;
          final_status: string;
          final_output?: string;
          run_id?: string;
          execution_mode?: string;
        }) => {
          let bos_output: BosOutput | undefined;
          try {
            if (task.final_output) bos_output = JSON.parse(task.final_output);
          } catch {}
          setResult({ ...task, task_id: task.id, bos_output });
        },
      }
    );
  }

  const selected_mode_info = MODE_OPTIONS.find((m) => m.value === mode)!;

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      {/* Stats bar */}
      {stats && (
        <div className="grid grid-cols-6 gap-2">
          {[
            { label: "TOTAL", value: stats.total_tasks, color: "text-foreground" },
            { label: "GO", value: stats.go_count, color: "text-green-400" },
            { label: "HOLD", value: stats.hold_count, color: "text-amber-400" },
            { label: "ABORT", value: stats.abort_count, color: "text-red-400" },
            { label: "AVG LATENCY", value: formatMs(stats.avg_latency_ms), color: "text-primary" },
            { label: "SUCCESS RATE", value: `${((stats.success_rate || 0) * 100).toFixed(0)}%`, color: "text-green-400" },
          ].map((s) => (
            <div key={s.label} className="bg-card border border-card-border rounded p-2.5 text-center">
              <div className={`text-lg font-mono font-bold ${s.color}`}>{s.value}</div>
              <div className="text-[10px] text-muted-foreground tracking-wider mt-0.5">{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Input form */}
      <div className="bg-card border border-card-border rounded-lg p-5">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
          <h2 className="text-sm font-mono font-semibold text-foreground tracking-wider">BOS-OMEGA INPUT GATE</h2>
          <div className="ml-auto flex items-center gap-2">
            {selected_mode_info.cost && (
              <span className={`text-[10px] font-mono ${COST_LABEL[selected_mode_info.cost]!.color}`}>
                {COST_LABEL[selected_mode_info.cost]!.label}
              </span>
            )}
          </div>
        </div>

        {/* Mode selector — 2 rows: 4 basic + 2 advanced */}
        <div className="grid grid-cols-3 gap-2 mb-2">
          {MODE_OPTIONS.slice(0, 3).map((m) => {
            const Icon = m.icon;
            return (
              <button
                key={m.value}
                onClick={() => setMode(m.value)}
                className={`flex flex-col items-start gap-1 p-3 rounded border text-left transition-all ${
                  mode === m.value
                    ? "bg-primary/15 border-primary/40 text-primary"
                    : "bg-muted/30 border-border text-muted-foreground hover:border-primary/30 hover:text-foreground"
                }`}
              >
                <div className="flex items-center gap-1.5 w-full">
                  <Icon className="w-3.5 h-3.5 shrink-0" />
                  <span className="text-xs font-mono font-semibold">{m.label}</span>
                  {m.badge && (
                    <span className={`ml-auto text-[9px] font-mono px-1 py-0.5 rounded border ${m.badgeColor}`}>{m.badge}</span>
                  )}
                </div>
                <span className="text-[10px] leading-tight opacity-70">{m.desc}</span>
              </button>
            );
          })}
        </div>
        <div className="grid grid-cols-3 gap-2 mb-4">
          {MODE_OPTIONS.slice(3).map((m) => {
            const Icon = m.icon;
            return (
              <button
                key={m.value}
                onClick={() => setMode(m.value)}
                className={`flex flex-col items-start gap-1 p-3 rounded border text-left transition-all ${
                  mode === m.value
                    ? "bg-primary/15 border-primary/40 text-primary"
                    : "bg-muted/30 border-border text-muted-foreground hover:border-primary/30 hover:text-foreground"
                }`}
              >
                <div className="flex items-center gap-1.5 w-full">
                  <Icon className="w-3.5 h-3.5 shrink-0" />
                  <span className="text-xs font-mono font-semibold">{m.label}</span>
                  {m.badge && (
                    <span className={`ml-auto text-[9px] font-mono px-1 py-0.5 rounded border ${m.badgeColor}`}>{m.badge}</span>
                  )}
                </div>
                <span className="text-[10px] leading-tight opacity-70">{m.desc}</span>
              </button>
            );
          })}
        </div>

        {/* BTO cost warning */}
        {mode === "boil_the_ocean" && (
          <div className="mb-4 flex items-start gap-2.5 p-3 bg-red-950/30 border border-red-500/30 rounded">
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-mono text-red-300 font-semibold">EXTREME COST MODE</p>
              <p className="text-[11px] font-mono text-red-400/80 mt-0.5">
                Boil The Ocean runs up to {maxModels} providers × {agentsPerModel} agents = {maxModels * agentsPerModel} parallel LLM calls, plus synthesis and adversarial review.
                This can incur significant API costs. Confirm you want to proceed.
              </p>
            </div>
          </div>
        )}

        {/* Series pass info */}
        {mode === "series_pass" && (
          <div className="mb-4 flex items-start gap-2.5 p-3 bg-purple-950/30 border border-purple-500/30 rounded">
            <CheckCircle2 className="w-4 h-4 text-purple-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-mono text-purple-300 font-semibold">5-ROLE SEQUENTIAL REFINEMENT</p>
              <p className="text-[11px] font-mono text-purple-400/80 mt-0.5">
                DRAFTER → CRITIC → EXPANDER → ADVERSARY → SYNTHESIZER. Each model builds on the previous,
                finding errors and improving the answer in sequence.
              </p>
            </div>
          </div>
        )}

        {/* Config controls */}
        {(mode === "parallel" || mode === "consensus") && (
          <div className="mb-4 flex items-center gap-3">
            <label className="text-xs font-mono text-muted-foreground">PARALLEL MODELS:</label>
            {[2, 3, 4, 5].map((n) => (
              <button
                key={n}
                onClick={() => setParallelCount(n)}
                className={`w-8 h-8 rounded border text-xs font-mono transition-all ${
                  parallelCount === n ? "bg-primary/20 border-primary/50 text-primary" : "border-border text-muted-foreground hover:border-primary/30"
                }`}
              >
                {n}
              </button>
            ))}
          </div>
        )}

        {mode === "boil_the_ocean" && (
          <div className="mb-4 grid grid-cols-2 gap-4">
            <div className="flex items-center gap-3">
              <label className="text-xs font-mono text-muted-foreground whitespace-nowrap">MAX PROVIDERS:</label>
              {[2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  onClick={() => setMaxModels(n)}
                  className={`w-8 h-8 rounded border text-xs font-mono transition-all ${
                    maxModels === n ? "bg-red-500/20 border-red-500/50 text-red-400" : "border-border text-muted-foreground hover:border-red-500/30"
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-3">
              <label className="text-xs font-mono text-muted-foreground whitespace-nowrap">AGENTS/PROVIDER:</label>
              {[3, 5].map((n) => (
                <button
                  key={n}
                  onClick={() => setAgentsPerModel(n)}
                  className={`w-8 h-8 rounded border text-xs font-mono transition-all ${
                    agentsPerModel === n ? "bg-red-500/20 border-red-500/50 text-red-400" : "border-border text-muted-foreground hover:border-red-500/30"
                  }`}
                >
                  {n}
                </button>
              ))}
              <span className="text-[10px] font-mono text-muted-foreground">= {maxModels * agentsPerModel} total agents</span>
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="relative">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                mode === "series_pass"
                  ? "Enter your task. The 5-role series pipeline will draft, critique, expand, challenge, and synthesize a refined answer…"
                  : mode === "boil_the_ocean"
                  ? "Enter your task. All available models will be dispatched with specialized agents. Final synthesis + adversarial review + Omega validation included…"
                  : mode === "auto"
                  ? "Enter your task. BOS-OMEGA will automatically select the optimal execution mode based on complexity and intent…"
                  : "Enter your task for BOS-OMEGA to process…"
              }
              className="w-full h-32 bg-muted/30 border border-input rounded p-3 text-sm text-foreground placeholder:text-muted-foreground resize-none focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/50 font-mono"
              disabled={createTask.isPending}
            />
            <div className="absolute bottom-2 right-2 text-[10px] text-muted-foreground font-mono">
              {input.length} chars
            </div>
          </div>
          <button
            type="submit"
            disabled={createTask.isPending || !input.trim()}
            className={`flex items-center gap-2 px-5 py-2 rounded text-sm font-mono font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
              mode === "boil_the_ocean"
                ? "bg-red-600 text-white hover:bg-red-500"
                : mode === "series_pass"
                ? "bg-purple-600 text-white hover:bg-purple-500"
                : "bg-primary text-primary-foreground hover:opacity-90"
            }`}
          >
            {createTask.isPending ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                {mode === "boil_the_ocean" ? "BOILING THE OCEAN…" : mode === "series_pass" ? "RUNNING SERIES PASS…" : "PIPELINE RUNNING…"}
              </>
            ) : (
              <>
                {mode === "boil_the_ocean" ? <Flame className="w-4 h-4" /> : <Send className="w-4 h-4" />}
                {mode === "boil_the_ocean"
                  ? `BOIL THE OCEAN (${maxModels * agentsPerModel} AGENTS)`
                  : mode === "series_pass"
                  ? "RUN SERIES PASS"
                  : "SUBMIT TO BOS-OMEGA"}
              </>
            )}
          </button>
        </form>
      </div>

      {/* Result */}
      {result && (
        <div className="bg-card border border-card-border rounded-lg overflow-hidden">
          {/* Result header */}
          <div className="px-5 py-4 border-b border-card-border flex items-center gap-4 flex-wrap">
            <TriStateBadge state={result.tri_state || "GO"} />
            <div className="font-mono text-xs text-muted-foreground">
              TYPE: <span className="text-foreground">{result.task_type}</span>
            </div>
            {result.execution_mode && (
              <div className="font-mono text-xs text-muted-foreground">
                MODE: <span className="text-primary">{result.execution_mode.toUpperCase()}</span>
              </div>
            )}
            {result.selected_provider && (
              <div className="font-mono text-xs text-muted-foreground">
                ROUTED: <span className="text-primary">{result.selected_provider}/{result.selected_model}</span>
              </div>
            )}
            <div className="ml-auto font-mono text-[10px] text-muted-foreground">{result.task_id}</div>
          </div>

          {/* Qubit-inspired Tri-State decision vector */}
          <div className="px-5 pt-4">
            <TriStateVector task_id={result.task_id} />
          </div>

          {/* Execution trace for series pass / BTO */}
          {result.run_id && (result.execution_mode === "series_pass" || result.execution_mode === "boil_the_ocean") && (
            <div className="px-5 pt-4">
              <ExecutionTrace run_id={result.run_id} mode={result.execution_mode} />
            </div>
          )}

          {/* Parallel responses (for parallel/consensus mode) */}
          {result.bos_output?.parallel_responses && result.bos_output.parallel_responses.length > 0 && result.execution_mode !== "series_pass" && (
            <div className="px-5 pt-4">
              <div className="text-[10px] font-mono text-muted-foreground mb-2 tracking-wider">
                {result.execution_mode === "boil_the_ocean" ? "TOP AGENT OUTPUTS" : "PARALLEL MODEL RESPONSES"}
              </div>
              <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(result.bos_output.parallel_responses.length, 4)}, 1fr)` }}>
                {result.bos_output.parallel_responses.slice(0, 8).map((pr, i) => (
                  <div
                    key={i}
                    className={`p-3 rounded border text-xs ${pr.selected ? "border-primary/50 bg-primary/10" : "border-border bg-muted/20"}`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-mono font-bold text-[10px] text-foreground truncate">{pr.provider}/{pr.model}</span>
                      {pr.selected && <span className="text-[9px] text-primary font-mono shrink-0 ml-1">SELECTED</span>}
                    </div>
                    <div className="flex gap-2 mb-1.5">
                      <TriStateBadge state={pr.state} />
                      {pr.confidence_score != null && <ScoreBar score={pr.confidence_score} />}
                    </div>
                    <p className="text-muted-foreground text-[10px] leading-relaxed line-clamp-3">{pr.answer}</p>
                  </div>
                ))}
              </div>
              {result.bos_output.merge_strategy && (
                <div className="mt-2 text-[10px] font-mono text-muted-foreground">
                  STRATEGY: <span className="text-primary">{result.bos_output.merge_strategy}</span>
                </div>
              )}
            </div>
          )}

          {/* Main answer */}
          {result.bos_output && (
            <div className="px-5 py-4 space-y-4">
              <div>
                <div className="text-[10px] font-mono text-muted-foreground mb-2 tracking-wider">FINAL ANSWER</div>
                <div className="bg-muted/30 border border-border rounded p-4 text-sm text-foreground leading-relaxed whitespace-pre-wrap font-mono text-xs">
                  {result.bos_output.answer}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                {(result.bos_output.assumptions?.length ?? 0) > 0 && (
                  <div>
                    <div className="text-[10px] font-mono text-amber-400 mb-1.5 tracking-wider">ASSUMPTIONS</div>
                    <ul className="space-y-1">
                      {(result.bos_output.assumptions ?? []).map((a, i) => (
                        <li key={i} className="text-xs text-muted-foreground font-mono flex gap-2">
                          <span className="text-amber-400 shrink-0">△</span>{a}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {(result.bos_output.uncertainties?.length ?? 0) > 0 && (
                  <div>
                    <div className="text-[10px] font-mono text-blue-400 mb-1.5 tracking-wider">UNCERTAINTIES</div>
                    <ul className="space-y-1">
                      {(result.bos_output.uncertainties ?? []).map((u, i) => (
                        <li key={i} className="text-xs text-muted-foreground font-mono flex gap-2">
                          <span className="text-blue-400 shrink-0">?</span>{u}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {(result.bos_output.missing_inputs?.length ?? 0) > 0 && (
                  <div>
                    <div className="text-[10px] font-mono text-amber-400 mb-1.5 tracking-wider">MISSING INPUTS</div>
                    <ul className="space-y-1">
                      {(result.bos_output.missing_inputs ?? []).map((m, i) => (
                        <li key={i} className="text-xs text-muted-foreground font-mono flex gap-2">
                          <span className="text-amber-400 shrink-0">!</span>{m}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {(result.bos_output.failure_modes?.length ?? 0) > 0 && (
                  <div>
                    <div className="text-[10px] font-mono text-red-400 mb-1.5 tracking-wider">FAILURE MODES</div>
                    <ul className="space-y-1">
                      {(result.bos_output.failure_modes ?? []).map((f, i) => (
                        <li key={i} className="text-xs text-muted-foreground font-mono flex gap-2">
                          <span className="text-red-400 shrink-0">✗</span>{f}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              {result.bos_output.recommended_next_action && (
                <div className="border border-primary/25 bg-primary/10 rounded p-3">
                  <div className="text-[10px] font-mono text-primary mb-1 tracking-wider">RECOMMENDED NEXT ACTION</div>
                  <p className="text-xs text-foreground font-mono">{result.bos_output.recommended_next_action}</p>
                </div>
              )}
            </div>
          )}

          {/* Raw output toggle */}
          <div className="px-5 pb-4">
            <button
              onClick={() => setShowRaw(!showRaw)}
              className="flex items-center gap-1 text-[11px] font-mono text-muted-foreground hover:text-foreground transition-colors"
            >
              {showRaw ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              RAW JSON OUTPUT
            </button>
            {showRaw && (
              <pre className="mt-2 bg-muted/20 border border-border rounded p-3 text-[11px] font-mono text-muted-foreground overflow-x-auto">
                {JSON.stringify(result.bos_output, null, 2)}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
