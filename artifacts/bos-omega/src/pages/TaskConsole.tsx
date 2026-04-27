import { useState } from "react";
import { useCreateTask, useGetTaskStats } from "@workspace/api-client-react";
import type { BosOutput } from "@workspace/api-client-react";
import { Composer } from "@/components/Composer";
import { MessageList, type ChatMessage, type AssistantMessage } from "@/components/MessageList";
import type { UploadedAttachment } from "@/lib/uploads";
import { formatMs } from "@/lib/utils";
import { buildLocalMemoryInjection } from "@/lib/localMemory";
import {
  Send, Loader2, Layers, GitMerge, Vote, Zap, Flame, AlertTriangle,
  CheckCircle2, ChevronRight, MessageSquarePlus, Scale, Code2, ShieldAlert, X,
  ShieldCheck, FileSearch, GitPullRequest, Wrench,
} from "lucide-react";

// BOP.FRONT_DOOR.v1 — first-run prompt cards. These mirror the four
// canonical task shapes BOS-OMEGA handles best (vendor risk, contract
// review, code review, build plan) and seed the input on click.
const FRONT_DOOR_PROMPTS: Array<{
  key: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  desc: string;
  prompt: string;
  accent: string;
}> = [
  {
    key: "vendor-risk",
    icon: ShieldCheck,
    label: "Vendor risk",
    desc: "Should we approve this vendor?",
    prompt:
      "Should we approve this vendor? Vendor: [name]. Service: [what they do]. Scope: [what data/access]. Constraints: [budget, timeline, regulatory]. Give a GO/HOLD/ABORT with risk drivers and mitigations.",
    accent: "border-emerald-200 bg-emerald-50/40 hover:bg-emerald-50",
  },
  {
    key: "contract-review",
    icon: FileSearch,
    label: "Contract review",
    desc: "Is this contract safe to sign?",
    prompt:
      "Review this contract for risk before we sign. Counterparty: [name]. Term length: [duration]. Key clauses to watch: liability cap, IP assignment, termination, indemnity, data handling. Flag every clause that's worse than market and propose a redline.",
    accent: "border-amber-200 bg-amber-50/40 hover:bg-amber-50",
  },
  {
    key: "code-review",
    icon: GitPullRequest,
    label: "Code review",
    desc: "Review this PR for risk.",
    prompt:
      "Review this pull request before merge. Goal of the change: [what it does]. Risk surface: [auth/data/payments/etc]. Check for: correctness, security, performance, observability, test coverage, and rollback safety. Give a GO/HOLD/ABORT with concrete blocking items.",
    accent: "border-blue-200 bg-blue-50/40 hover:bg-blue-50",
  },
  {
    key: "build-plan",
    icon: Wrench,
    label: "Build plan",
    desc: "Plan a step-by-step fix.",
    prompt:
      "Build a step-by-step plan to fix this workflow. Symptom: [what is broken]. Last working state: [when]. Recent changes: [what changed]. Constraints: [downtime tolerance, blast radius]. Produce a sequenced plan with diagnostics, fix steps, validation, and rollback.",
    accent: "border-violet-200 bg-violet-50/40 hover:bg-violet-50",
  },
];

type Mode = "auto" | "single" | "parallel" | "consensus" | "series_pass" | "boil_the_ocean";
type Persona = "legal" | "engineering" | "cyber";

const PERSONA_LS_KEY = "bos.persona.v1";

interface PersonaOption {
  value: Persona;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  desc: string;
  color: string;
  activeColor: string;
}

const PERSONA_OPTIONS: PersonaOption[] = [
  {
    value: "legal",
    label: "Legal Counsel",
    icon: Scale,
    desc: "Structured legal memo: jurisdictions, authority, analysis, risk, mitigations.",
    color: "border-amber-200 bg-amber-50/40 hover:bg-amber-50",
    activeColor: "bg-amber-100 border-amber-400 ring-2 ring-amber-300/40",
  },
  {
    value: "engineering",
    label: "Engineer / Coder",
    icon: Code2,
    desc: "Architecture, implementation, tests, edge cases, deployment & ops.",
    color: "border-blue-200 bg-blue-50/40 hover:bg-blue-50",
    activeColor: "bg-blue-100 border-blue-400 ring-2 ring-blue-300/40",
  },
  {
    value: "cyber",
    label: "Cyber Analyst",
    icon: ShieldAlert,
    desc: "Threat assessment with severity, attack surface, IoCs, remediation.",
    color: "border-red-200 bg-red-50/40 hover:bg-red-50",
    activeColor: "bg-red-100 border-red-400 ring-2 ring-red-300/40",
  },
];

function readStoredPersona(): Persona | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PERSONA_LS_KEY);
    if (raw === "legal" || raw === "engineering" || raw === "cyber") return raw;
  } catch {
    // ignore
  }
  return null;
}

function writeStoredPersona(p: Persona | null): void {
  if (typeof window === "undefined") return;
  try {
    if (p === null) window.localStorage.removeItem(PERSONA_LS_KEY);
    else window.localStorage.setItem(PERSONA_LS_KEY, p);
  } catch {
    // ignore
  }
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
  const [persona, setPersonaState] = useState<Persona | null>(() => readStoredPersona());
  const [parallelCount, setParallelCount] = useState(3);
  const [maxModels, setMaxModels] = useState(3);
  const [agentsPerModel, setAgentsPerModel] = useState(5);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [resetSignal, setResetSignal] = useState(0);

  const createTask = useCreateTask();
  const { data: stats } = useGetTaskStats();

  function setPersona(p: Persona | null) {
    setPersonaState(p);
    writeStoredPersona(p);
  }

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

    // Inject local memory (browser-stored, layered below server canon) into the
    // task input so it reaches every model regardless of execution mode. We do
    // this client-side so the server's canon remains authoritative. Top-ranked
    // items by layer + recency, capped to a 500-token-equivalent budget.
    void buildLocalMemoryInjection(send_text, 500).then((injection) => {
      const final_input = injection
        ? `${injection}\n\n=== USER REQUEST ===\n${send_text}`
        : send_text;

      createTask.mutate(
        {
          data: {
            input: final_input,
            mode,
            parallel_models: parallelCount,
            max_models: maxModels,
            agents_per_model: agentsPerModel,
            attachment_ids,
            ...(persona ? { persona } : {}),
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
    });
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

        {/* Persona quick-launch */}
        <div className="mb-5">
          <div className="flex items-center justify-between mb-2">
            <label className="block text-[12.5px] font-medium text-foreground">Domain persona</label>
            {persona && (
              <button
                type="button"
                onClick={() => setPersona(null)}
                className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground"
                data-testid="button-clear-persona"
              >
                <X className="w-3 h-3" />
                Clear
              </button>
            )}
          </div>
          <div className="grid grid-cols-3 gap-2.5">
            {PERSONA_OPTIONS.map((p) => {
              const Icon = p.icon;
              const active = persona === p.value;
              return (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => setPersona(active ? null : p.value)}
                  className={`flex flex-col items-start gap-1.5 p-3 rounded-lg border text-left transition-all ${
                    active ? p.activeColor : `bg-background ${p.color}`
                  }`}
                  data-testid={`button-persona-${p.value}`}
                >
                  <div className="flex items-center gap-2 w-full">
                    <Icon className={`w-4 h-4 shrink-0 ${active ? "text-foreground" : "text-muted-foreground"}`} />
                    <span className="text-[13px] font-medium text-foreground">{p.label}</span>
                    {active && (
                      <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-foreground/10 text-foreground font-medium uppercase tracking-wide">
                        Active
                      </span>
                    )}
                  </div>
                  <span className="text-[11.5px] leading-snug text-muted-foreground">{p.desc}</span>
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-muted-foreground mt-2">
            Personas compose with the Master Prompt Kernel and apply across every execution mode while preserving BOS structured output.
          </p>
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

        {/* BOP.FRONT_DOOR.v1 — first-run prompt cards. Shown only on the
            empty conversation, so the user immediately understands what
            kind of work BOS-OMEGA was built for. */}
        {messages.length === 0 && (
          <div className="mb-5" data-testid="front-door-empty-state">
            <div className="mb-2 flex items-baseline justify-between">
              <label className="block text-[12.5px] font-medium text-foreground">
                Try a task
              </label>
              <span className="text-[11px] text-muted-foreground">
                BOS-OMEGA is a structured decision engine — not a chat companion.
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              {FRONT_DOOR_PROMPTS.map((p) => {
                const Icon = p.icon;
                return (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => setInput(p.prompt)}
                    className={`flex flex-col items-start gap-1.5 p-3 rounded-lg border text-left transition-all ${p.accent}`}
                    data-testid={`button-front-door-prompt-${p.key}`}
                  >
                    <div className="flex items-center gap-2 w-full">
                      <Icon className="w-4 h-4 shrink-0 text-muted-foreground" />
                      <span className="text-[13px] font-medium text-foreground">{p.label}</span>
                      <span className="ml-auto text-[10px] text-muted-foreground font-mono uppercase">Try</span>
                    </div>
                    <span className="text-[11.5px] leading-snug text-muted-foreground">{p.desc}</span>
                  </button>
                );
              })}
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
                ? "Ask BOS-OMEGA a decision, review, risk check, or build task that benefits from iterative refinement…"
                : mode === "boil_the_ocean"
                ? "Ask BOS-OMEGA a high-stakes decision, review, risk check, or build task. Attach reference docs as needed…"
                : mode === "auto"
                ? "Ask BOS-OMEGA a decision, review, risk check, or build task. Examples: \"Should we approve this vendor?\", \"Review this PR for risk.\", \"Build a step-by-step fix plan.\""
                : "Ask BOS-OMEGA a decision, review, risk check, or build task…"
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
