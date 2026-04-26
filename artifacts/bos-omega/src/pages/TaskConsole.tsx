import { useState } from "react";
import { useCreateTask, useGetTaskStats } from "@workspace/api-client-react";
import type { BosOutput } from "@workspace/api-client-react";
import { Composer } from "@/components/Composer";
import { MessageList, type ChatMessage, type AssistantMessage } from "@/components/MessageList";
import type { UploadedAttachment } from "@/lib/uploads";
import { formatMs } from "@/lib/utils";
import {
  Send, Loader2, Layers, GitMerge, Vote, Zap, Flame, AlertTriangle,
  CheckCircle2, ChevronRight, MessageSquarePlus,
} from "lucide-react";

type Mode = "auto" | "single" | "parallel" | "consensus" | "series_pass" | "boil_the_ocean";

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
  { value: "auto",           label: "Auto",            icon: Zap,          desc: "Selects the best execution mode based on task complexity", badge: "Recommended", badgeColor: "bg-orange-50 text-orange-800 border-orange-200", cost: "medium" },
  { value: "single",         label: "Single",          icon: Layers,       desc: "One best-fit model chosen by the router", cost: "low" },
  { value: "parallel",       label: "Parallel",        icon: GitMerge,     desc: "Multiple models run concurrently, answers merged", cost: "medium" },
  { value: "consensus",      label: "Consensus",       icon: Vote,         desc: "Majority vote across models for reliability", cost: "medium" },
  { value: "series_pass",    label: "Series pass",     icon: ChevronRight, desc: "Drafter → Critic → Expander → Adversary → Synthesizer", badge: "5-role chain", badgeColor: "bg-violet-50 text-violet-800 border-violet-200", cost: "high" },
  { value: "boil_the_ocean", label: "Boil the ocean",  icon: Flame,        desc: "All models × 5 agents + synthesis + adversarial + Omega", badge: "Maximum power", badgeColor: "bg-red-50 text-red-800 border-red-200", cost: "extreme" },
];

const COST_LABEL: Record<string, { label: string; color: string }> = {
  low:     { label: "Low cost",     color: "text-green-700 bg-green-50 border-green-200" },
  medium:  { label: "Medium cost",  color: "text-amber-800 bg-amber-50 border-amber-200" },
  high:    { label: "High cost",    color: "text-orange-800 bg-orange-50 border-orange-200" },
  extreme: { label: "Extreme cost", color: "text-red-800 bg-red-50 border-red-200" },
};

let MSG_SEQ = 0;
const newMsgId = () => `m-${Date.now()}-${++MSG_SEQ}`;

export function TaskConsole() {
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<Mode>("auto");
  const [parallelCount, setParallelCount] = useState(3);
  const [maxModels, setMaxModels] = useState(3);
  const [agentsPerModel, setAgentsPerModel] = useState(5);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [resetSignal, setResetSignal] = useState(0);

  const createTask = useCreateTask();
  const { data: stats } = useGetTaskStats();

  function submitTask(text: string, attachment_ids: string[], attachments: UploadedAttachment[]) {
    if (!text.trim() && attachment_ids.length === 0) return;

    const user_id = newMsgId();
    const assistant_id = newMsgId();
    const send_text = text.trim() || "(see attached files)";

    setMessages((prev) => [
      ...prev,
      { id: user_id, role: "user", text: send_text, attachments, ts: Date.now() },
      {
        id: assistant_id,
        role: "assistant",
        status: "pending",
        mode,
        max_models: maxModels,
        agents_per_model: agentsPerModel,
        ts: Date.now(),
      },
    ]);

    // Clear composer immediately (user message preserves the text in its bubble)
    setInput("");
    setResetSignal((n) => n + 1);

    createTask.mutate(
      {
        data: {
          input: send_text,
          mode,
          parallel_models: parallelCount,
          max_models: maxModels,
          agents_per_model: agentsPerModel,
          attachment_ids,
        },
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
          let parse_error: string | undefined;
          if (task.final_output) {
            try {
              bos_output = JSON.parse(task.final_output);
            } catch (e) {
              parse_error = e instanceof Error ? e.message : "Unknown JSON parse error";
            }
          }
          setMessages((prev) =>
            prev.map((m): ChatMessage =>
              m.id === assistant_id
                ? ({
                    ...(m as AssistantMessage),
                    status: parse_error ? "error" : "done",
                    error: parse_error
                      ? `Received malformed BOS output JSON: ${parse_error}. See raw payload below.`
                      : undefined,
                    task: {
                      task_id: task.id,
                      task_type: task.task_type,
                      tri_state: task.tri_state,
                      selected_provider: task.selected_provider,
                      selected_model: task.selected_model,
                      final_status: task.final_status,
                      final_output: task.final_output,
                      run_id: task.run_id,
                      execution_mode: task.execution_mode,
                      bos_output,
                    },
                  })
                : m,
            ),
          );
        },
        onError: (err: unknown) => {
          const message = err instanceof Error ? err.message : "Pipeline request failed";
          setMessages((prev) =>
            prev.map((m): ChatMessage =>
              m.id === assistant_id
                ? ({ ...(m as AssistantMessage), status: "error", error: message })
                : m,
            ),
          );
        },
      },
    );
  }

  const selected_mode_info = MODE_OPTIONS.find((m) => m.value === mode)!;

  return (
    <div className="space-y-8">
      {/* Page header */}
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-serif font-semibold text-foreground tracking-tight">Task console</h1>
          <p className="text-[13.5px] text-muted-foreground max-w-2xl">
            Submit a task and let BOS-Omega orchestrate the optimal multi-model execution strategy.
          </p>
        </div>
        {messages.length > 0 && (
          <button
            type="button"
            onClick={() => setMessages([])}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-[12px] font-medium text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            title="Start a new conversation"
          >
            <MessageSquarePlus className="w-3.5 h-3.5" />
            New chat
          </button>
        )}
      </header>

      {/* Stats bar */}
      {stats && (
        <div className="grid grid-cols-6 gap-3">
          {[
            { label: "Total", value: stats.total_tasks, accent: "text-foreground" },
            { label: "Go", value: stats.go_count, accent: "text-green-700" },
            { label: "Hold", value: stats.hold_count, accent: "text-amber-700" },
            { label: "Abort", value: stats.abort_count, accent: "text-red-700" },
            { label: "Avg latency", value: formatMs(stats.avg_latency_ms), accent: "text-foreground" },
            { label: "Success rate", value: `${((stats.success_rate || 0) * 100).toFixed(0)}%`, accent: "text-green-700" },
          ].map((s) => (
            <div key={s.label} className="bg-card border border-card-border rounded-xl p-4 shadow-card">
              <div className="text-[10.5px] text-muted-foreground font-medium tracking-wide uppercase">{s.label}</div>
              <div className={`text-2xl font-serif font-semibold mt-1.5 tracking-tight ${s.accent}`}>{s.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Conversation thread */}
      {messages.length > 0 && (
        <MessageList messages={messages} />
      )}

      {/* Input form */}
      <div className="bg-card border border-card-border rounded-xl p-6 shadow-card">
        <div className="flex items-center gap-3 mb-5">
          <h2 className="text-[15px] font-serif font-semibold text-foreground tracking-tight">
            {messages.length === 0 ? "New task" : "Reply"}
          </h2>
          {selected_mode_info.cost && (
            <span className={`ml-auto inline-flex items-center px-2 py-0.5 rounded-md border text-[11px] font-medium ${COST_LABEL[selected_mode_info.cost]!.color}`}>
              {COST_LABEL[selected_mode_info.cost]!.label}
            </span>
          )}
        </div>

        {/* Mode selector */}
        <div className="mb-5">
          <label className="block text-[12.5px] font-medium text-foreground mb-2">Execution mode</label>
          <div className="grid grid-cols-3 gap-2.5 mb-2.5">
            {MODE_OPTIONS.slice(0, 3).map((m) => {
              const Icon = m.icon;
              const active = mode === m.value;
              return (
                <button
                  key={m.value}
                  onClick={() => setMode(m.value)}
                  className={`flex flex-col items-start gap-1.5 p-3.5 rounded-lg border text-left transition-all ${
                    active
                      ? "bg-secondary border-border ring-2 ring-primary/10"
                      : "bg-background border-border hover:border-border hover:bg-secondary/50"
                  }`}
                >
                  <div className="flex items-center gap-2 w-full">
                    <Icon className={`w-4 h-4 shrink-0 ${active ? "text-accent" : "text-muted-foreground"}`} />
                    <span className={`text-[13px] font-medium ${active ? "text-foreground" : "text-foreground/90"}`}>{m.label}</span>
                    {m.badge && (
                      <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded border ${m.badgeColor}`}>{m.badge}</span>
                    )}
                  </div>
                  <span className="text-[11.5px] leading-snug text-muted-foreground">{m.desc}</span>
                </button>
              );
            })}
          </div>
          <div className="grid grid-cols-3 gap-2.5">
            {MODE_OPTIONS.slice(3).map((m) => {
              const Icon = m.icon;
              const active = mode === m.value;
              return (
                <button
                  key={m.value}
                  onClick={() => setMode(m.value)}
                  className={`flex flex-col items-start gap-1.5 p-3.5 rounded-lg border text-left transition-all ${
                    active
                      ? "bg-secondary border-border ring-2 ring-primary/10"
                      : "bg-background border-border hover:border-border hover:bg-secondary/50"
                  }`}
                >
                  <div className="flex items-center gap-2 w-full">
                    <Icon className={`w-4 h-4 shrink-0 ${active ? "text-accent" : "text-muted-foreground"}`} />
                    <span className={`text-[13px] font-medium ${active ? "text-foreground" : "text-foreground/90"}`}>{m.label}</span>
                    {m.badge && (
                      <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded border ${m.badgeColor}`}>{m.badge}</span>
                    )}
                  </div>
                  <span className="text-[11.5px] leading-snug text-muted-foreground">{m.desc}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Mode-specific notices */}
        {mode === "boil_the_ocean" && (
          <div className="mb-5 flex items-start gap-3 p-4 bg-red-50 border border-red-200 rounded-lg">
            <AlertTriangle className="w-4 h-4 text-red-700 shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-[13px] font-medium text-red-900">High API spend warning</p>
              <p className="text-[12px] text-red-800/90 mt-1 leading-relaxed">
                Boil the ocean dispatches up to {maxModels} providers × {agentsPerModel} agents = <strong>{maxModels * agentsPerModel} parallel LLM calls</strong>, plus synthesis and adversarial review. This can incur significant cost.
              </p>
            </div>
          </div>
        )}

        {mode === "series_pass" && (
          <div className="mb-5 flex items-start gap-3 p-4 bg-violet-50 border border-violet-200 rounded-lg">
            <CheckCircle2 className="w-4 h-4 text-violet-700 shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-[13px] font-medium text-violet-900">Sequential 5-role refinement</p>
              <p className="text-[12px] text-violet-800/90 mt-1 leading-relaxed">
                Drafter → Critic → Expander → Adversary → Synthesizer. Each model builds on the previous one, finding errors and improving the answer in sequence.
              </p>
            </div>
          </div>
        )}

        {/* Config controls */}
        {(mode === "parallel" || mode === "consensus") && (
          <div className="mb-5 flex items-center gap-3">
            <label className="text-[12.5px] font-medium text-foreground">Parallel models</label>
            <div className="flex gap-1.5">
              {[2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  onClick={() => setParallelCount(n)}
                  className={`w-9 h-9 rounded-md border text-[13px] font-medium transition-all ${
                    parallelCount === n
                      ? "bg-primary text-primary-foreground border-primary shadow-card"
                      : "bg-background border-border text-muted-foreground hover:border-primary hover:text-foreground"
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        )}

        {mode === "boil_the_ocean" && (
          <div className="mb-5 grid grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="text-[12.5px] font-medium text-foreground block">Max providers</label>
              <div className="flex gap-1.5">
                {[2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    onClick={() => setMaxModels(n)}
                    className={`w-9 h-9 rounded-md border text-[13px] font-medium transition-all ${
                      maxModels === n
                        ? "bg-primary text-primary-foreground border-primary shadow-card"
                        : "bg-background border-border text-muted-foreground hover:border-primary hover:text-foreground"
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-[12.5px] font-medium text-foreground block">
                Agents per provider <span className="text-muted-foreground font-normal">· total {maxModels * agentsPerModel}</span>
              </label>
              <div className="flex gap-1.5">
                {[3, 5].map((n) => (
                  <button
                    key={n}
                    onClick={() => setAgentsPerModel(n)}
                    className={`w-9 h-9 rounded-md border text-[13px] font-medium transition-all ${
                      agentsPerModel === n
                        ? "bg-primary text-primary-foreground border-primary shadow-card"
                        : "bg-background border-border text-muted-foreground hover:border-primary hover:text-foreground"
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        <div className="space-y-2">
          <label className="block text-[12.5px] font-medium text-foreground">
            {messages.length === 0 ? "Task description" : "Send another message"}
          </label>
          <Composer
            value={input}
            onChange={setInput}
            onSubmit={submitTask}
            disabled={createTask.isPending}
            resetSignal={resetSignal}
            placeholder={
              mode === "series_pass"
                ? "Enter a task that benefits from iterative refinement. Drag in files, paste images, or attach video for vision-capable models…"
                : mode === "boil_the_ocean"
                ? "Enter a high-stakes task. Attach reference docs, screenshots, audio, or video — they'll be fed to every model…"
                : mode === "auto"
                ? "Describe what you'd like BOS-Omega to do. Drag, paste, or attach files — text is extracted, images go to vision models…"
                : "Enter your task…"
            }
            submitLabel={
              createTask.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {mode === "boil_the_ocean" ? "Boiling the ocean…" : mode === "series_pass" ? "Running series pass…" : "Running pipeline…"}
                </>
              ) : (
                <>
                  {mode === "boil_the_ocean" ? <Flame className="w-4 h-4" /> : <Send className="w-4 h-4" />}
                  {mode === "boil_the_ocean"
                    ? `Boil the ocean (${maxModels * agentsPerModel} agents)`
                    : mode === "series_pass"
                    ? "Run series pass"
                    : "Send"}
                </>
              )
            }
            submitClassName={`inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-[13px] font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-card ${
              mode === "boil_the_ocean"
                ? "bg-red-700 text-white hover:bg-red-800"
                : mode === "series_pass"
                ? "bg-violet-700 text-white hover:bg-violet-800"
                : "bg-accent text-accent-foreground hover:bg-accent/90"
            }`}
          />
          <div className="text-[11px] text-muted-foreground text-right">
            {input.length} characters
          </div>
        </div>
      </div>
    </div>
  );
}
