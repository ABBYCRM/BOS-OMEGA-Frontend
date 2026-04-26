import { useState } from "react";
import { useCreateTask, useGetTaskStats } from "@workspace/api-client-react";
import type { BosOutput } from "@workspace/api-client-react";
import { TriStateBadge } from "@/components/StatusBadge";
import { formatMs } from "@/lib/utils";
import { Send, ChevronDown, ChevronUp, Loader2, Layers, GitMerge, Vote } from "lucide-react";

type Mode = "single" | "parallel" | "consensus";

export function TaskConsole() {
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<Mode>("single");
  const [parallelCount, setParallelCount] = useState(3);
  const [result, setResult] = useState<{
    task_id: string;
    task_type: string;
    tri_state: string;
    selected_provider?: string;
    selected_model?: string;
    final_status: string;
    final_output?: string;
    bos_output?: BosOutput;
  } | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  const createTask = useCreateTask();
  const { data: stats } = useGetTaskStats();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim()) return;

    createTask.mutate(
      { input: input.trim(), mode, parallel_models: parallelCount },
      {
        onSuccess: (task: { id: string; task_type: string; tri_state: string; selected_provider?: string; selected_model?: string; final_status: string; final_output?: string }) => {
          let bos_output: BosOutput | undefined;
          try {
            if (task.final_output) bos_output = JSON.parse(task.final_output);
          } catch {}
          setResult({ ...task, task_id: task.id, bos_output });
        },
      }
    );
  }

  const modeOptions: Array<{ value: Mode; label: string; icon: typeof Layers; desc: string }> = [
    { value: "single", label: "Single", icon: Layers, desc: "Best model selected by router" },
    { value: "parallel", label: "Parallel", icon: GitMerge, desc: "Multiple models run concurrently, answers merged" },
    { value: "consensus", label: "Consensus", icon: Vote, desc: "Majority vote across models" },
  ];

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
        </div>

        {/* Mode selector */}
        <div className="grid grid-cols-3 gap-2 mb-4">
          {modeOptions.map((m) => {
            const Icon = m.icon;
            return (
              <button
                key={m.value}
                onClick={() => setMode(m.value)}
                className={`flex flex-col items-center gap-1 p-3 rounded border text-left transition-all ${
                  mode === m.value
                    ? "bg-primary/15 border-primary/40 text-primary"
                    : "bg-muted/30 border-border text-muted-foreground hover:border-primary/30 hover:text-foreground"
                }`}
              >
                <Icon className="w-4 h-4" />
                <span className="text-xs font-mono font-semibold">{m.label}</span>
                <span className="text-[10px] text-center leading-tight opacity-70">{m.desc}</span>
              </button>
            );
          })}
        </div>

        {mode !== "single" && (
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

        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="relative">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Enter your task for BOS-OMEGA to process. The system will classify, route, execute, validate, and return a structured response..."
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
            className="flex items-center gap-2 px-5 py-2 bg-primary text-primary-foreground rounded text-sm font-mono font-semibold hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
          >
            {createTask.isPending ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                PIPELINE RUNNING...
              </>
            ) : (
              <>
                <Send className="w-4 h-4" />
                SUBMIT TO BOS-OMEGA
              </>
            )}
          </button>
        </form>
      </div>

      {/* Result */}
      {result && (
        <div className="bg-card border border-card-border rounded-lg overflow-hidden">
          {/* Result header */}
          <div className="px-5 py-4 border-b border-card-border flex items-center gap-4">
            <TriStateBadge state={result.tri_state || "GO"} />
            <div className="font-mono text-xs text-muted-foreground">
              TASK_TYPE: <span className="text-foreground">{result.task_type}</span>
            </div>
            {result.selected_provider && (
              <div className="font-mono text-xs text-muted-foreground">
                ROUTED: <span className="text-primary">{result.selected_provider}/{result.selected_model}</span>
              </div>
            )}
            <div className="ml-auto font-mono text-[10px] text-muted-foreground">{result.task_id}</div>
          </div>

          {/* Parallel responses */}
          {result.bos_output?.parallel_responses && result.bos_output.parallel_responses.length > 0 && (
            <div className="px-5 pt-4">
              <div className="text-[10px] font-mono text-muted-foreground mb-2 tracking-wider">PARALLEL MODEL RESPONSES</div>
              <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${result.bos_output.parallel_responses.length}, 1fr)` }}>
                {result.bos_output.parallel_responses.map((pr, i) => (
                  <div
                    key={i}
                    className={`p-3 rounded border text-xs ${pr.selected ? "border-primary/50 bg-primary/10" : "border-border bg-muted/20"}`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-mono font-bold text-[11px] text-foreground">{pr.provider}/{pr.model}</span>
                      {pr.selected && <span className="text-[10px] text-primary font-mono">SELECTED</span>}
                    </div>
                    <div className="flex gap-3 mb-2">
                      <TriStateBadge state={pr.state} />
                      <span className="font-mono text-[10px] text-muted-foreground">CONF: {(pr.confidence_score * 100).toFixed(0)}%</span>
                      <span className="font-mono text-[10px] text-muted-foreground">{formatMs(pr.latency_ms)}</span>
                    </div>
                    <p className="text-muted-foreground text-[11px] leading-relaxed line-clamp-4">{pr.answer}</p>
                  </div>
                ))}
              </div>
              {result.bos_output.merge_strategy && (
                <div className="mt-2 text-[10px] font-mono text-muted-foreground">
                  MERGE_STRATEGY: <span className="text-primary">{result.bos_output.merge_strategy}</span>
                </div>
              )}
            </div>
          )}

          {/* Main answer */}
          {result.bos_output && (
            <div className="px-5 py-4 space-y-4">
              <div>
                <div className="text-[10px] font-mono text-muted-foreground mb-2 tracking-wider">ANSWER</div>
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
                          <span className="text-amber-400">△</span>{a}
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
                          <span className="text-blue-400">?</span>{u}
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
                          <span className="text-amber-400">!</span>{m}
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
                          <span className="text-red-400">✗</span>{f}
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
