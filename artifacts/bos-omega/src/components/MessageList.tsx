import { useEffect, useRef, useState } from "react";
import type { BosOutput } from "@workspace/api-client-react";
import { useGetRunSeriesPasses, useGetRunParallelAgents, useGetRunSynthesis, useGetRun } from "@workspace/api-client-react";
import type { UploadedAttachment } from "@/lib/uploads";
import { TriStateBadge, FrontDoorGuidanceBadge } from "@/components/StatusBadge";
import { TriStateVector } from "@/components/TriStateVector";
import { formatMs } from "@/lib/utils";
import {
  Copy, Check, ChevronDown, ChevronUp, Loader2, Bot, User, Award,
  AlertTriangle, FileText, Image as ImageIcon, FileCode, FileSpreadsheet, Music, Video, File as FileIcon,
  Pin,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/hooks/use-toast";

const SERIES_ROLE_COLORS: Record<string, string> = {
  DRAFTER: "text-sky-700",
  CRITIC: "text-red-700",
  EXPANDER: "text-violet-700",
  ADVERSARY: "text-orange-700",
  SYNTHESIZER: "text-green-700",
  OMEGA_VALIDATOR: "text-primary",
};

const AGENT_ROLE_COLORS: Record<string, string> = {
  ARCHITECT: "text-sky-700",
  CRITIC: "text-red-700",
  RESEARCHER: "text-violet-700",
  BUILDER: "text-amber-700",
  VALIDATOR: "text-green-700",
};

export interface UserMessage {
  id: string;
  role: "user";
  text: string;
  attachments: UploadedAttachment[];
  ts: number;
}

export interface AssistantMessage {
  id: string;
  role: "assistant";
  status: "pending" | "done" | "error";
  mode: string;
  max_models?: number;
  agents_per_model?: number;
  task?: {
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
  };
  error?: string;
  ts: number;
}

export type ChatMessage = UserMessage | AssistantMessage;

function attachmentIcon(kind: string) {
  switch (kind) {
    case "image":       return <ImageIcon className="w-3.5 h-3.5" />;
    case "document":    return <FileText className="w-3.5 h-3.5" />;
    case "spreadsheet": return <FileSpreadsheet className="w-3.5 h-3.5" />;
    case "code":        return <FileCode className="w-3.5 h-3.5" />;
    case "audio":       return <Music className="w-3.5 h-3.5" />;
    case "video":       return <Video className="w-3.5 h-3.5" />;
    case "text":        return <FileText className="w-3.5 h-3.5" />;
    default:            return <FileIcon className="w-3.5 h-3.5" />;
  }
}

function ScoreBar({ score }: { score?: number | null }) {
  if (score == null) return null;
  const pct = Math.round(score * 100);
  const color = pct >= 80 ? "bg-green-500" : pct >= 60 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1 bg-muted rounded-full overflow-hidden">
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
            <div className="text-[10px] font-mono text-red-700">
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
                  agent.status === "completed" ? "border-border bg-secondary" : "border-red-200 bg-red-50"
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
                  <div className="text-[10px] font-mono text-red-700">{agent.error_type || "failed"}</div>
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
  try { if (report.omega_validation) omega = JSON.parse(report.omega_validation); } catch {}
  return (
    <div className="space-y-4">
      {omega.state && (
        <div className="flex items-center gap-4 flex-wrap">
          <div className="text-[10px] font-mono text-muted-foreground">OMEGA VALIDATION</div>
          <TriStateBadge state={omega.state} />
          <div className="flex gap-3 text-[10px] font-mono">
            <span className={omega.schema_pass ? "text-green-700" : "text-red-700"}>SCHEMA {omega.schema_pass ? "✓" : "✗"}</span>
            <span className={omega.safety_pass ? "text-green-700" : "text-red-700"}>SAFETY {omega.safety_pass ? "✓" : "✗"}</span>
            <span className={omega.completeness_pass ? "text-green-700" : "text-red-700"}>COMPLETE {omega.completeness_pass ? "✓" : "✗"}</span>
          </div>
        </div>
      )}
      {omega.notes && <p className="text-xs font-mono text-muted-foreground">{omega.notes}</p>}
      <div className="grid grid-cols-2 gap-4">
        {report.consensus_points && report.consensus_points.length > 0 && (
          <div>
            <div className="text-[10px] font-mono text-green-700 mb-1.5 tracking-wider">CONSENSUS</div>
            <ul className="space-y-1">
              {report.consensus_points.slice(0, 5).map((p, i) => (
                <li key={i} className="text-[11px] font-mono text-muted-foreground flex gap-1.5">
                  <span className="text-green-700">✓</span>{p}
                </li>
              ))}
            </ul>
          </div>
        )}
        {report.contradictions && report.contradictions.length > 0 && (
          <div>
            <div className="text-[10px] font-mono text-red-700 mb-1.5 tracking-wider">CONTRADICTIONS RESOLVED</div>
            <ul className="space-y-1">
              {report.contradictions.slice(0, 5).map((p, i) => (
                <li key={i} className="text-[11px] font-mono text-muted-foreground flex gap-1.5">
                  <span className="text-red-700">⚡</span>{p}
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
  const [activeTab, setActiveTab] = useState<"series" | "agents" | "synthesis">(
    mode === "series_pass" ? "series" : "agents",
  );
  const { data: run } = useGetRun(run_id);
  // Use `as const` so the array literal preserves the narrow id literal types
  // and survives the .filter() — without it the inferred id widens to string
  // and the consumers (setActiveTab, tab.id) can't pattern-match.
  const tabs: Array<{ id: "series" | "agents" | "synthesis"; label: string; show: boolean }> = [
    { id: "series" as const, label: "SERIES PASSES", show: mode === "series_pass" },
    { id: "agents" as const, label: "PARALLEL AGENTS", show: mode === "boil_the_ocean" },
    { id: "synthesis" as const, label: "SYNTHESIS REPORT", show: mode === "boil_the_ocean" },
  ].filter((t) => t.show);

  return (
    <div className="border border-border rounded-lg overflow-hidden mt-3">
      <div className="bg-secondary border-b border-border px-4 py-2.5 flex items-center gap-4 flex-wrap">
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
                <Award className="w-3 h-3 text-amber-700" />
                <span className="text-[10px] font-mono text-amber-700">{(run.run.final_score * 100).toFixed(0)}%</span>
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

function MODE_LABEL(mode: string, max_models?: number, agents_per_model?: number): string {
  switch (mode) {
    case "boil_the_ocean": return `Boiling the ocean across ${(max_models ?? 0) * (agents_per_model ?? 0)} agents…`;
    case "series_pass":    return "Running 5-role series pass…";
    case "consensus":      return "Polling models for consensus…";
    case "parallel":       return "Dispatching parallel models…";
    case "single":         return "Routing to best-fit model…";
    case "auto":           return "BOS-Omega is choosing the optimal strategy…";
    default:               return "Working…";
  }
}

// Task #67: Pin an assistant message into the per-user scratchpad layer.
// POSTs to /api/scratchpad/pin with the message's task_id (as
// `source_task_id` per the contract), an optional user-provided title
// (prompted on click — leave empty to let the server derive one from
// the content's first line), and the full answer text as content.
//
// On success a toast confirms the pin landed. The resulting memory_items
// row is what later tasks see in their scratchpad context — not the
// live conversation transcript.
//
// State machine is hardened against:
//   - Double-click → an in-flight ref guards against re-entry even before
//     React batches the disabled re-render.
//   - Stale timers → a single resetTimer ref is cleared on every state
//     transition and on unmount so an old "back to idle" timeout cannot
//     re-enable the button mid-request.
export function PinButton({ task_id, answer }: { task_id?: string; answer: string }) {
  const [state, setState] = useState<"idle" | "pinning" | "pinned" | "error">("idle");
  const inFlightRef = useRef(false);
  const resetTimerRef = useRef<number | null>(null);

  const clearResetTimer = () => {
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
  };

  // Cancel any pending reset on unmount so the timer can't fire on a
  // disposed component (avoids a React warning + the documented stale-
  // transition bug raised in code review).
  useEffect(() => clearResetTimer, []);

  const scheduleReset = (ms: number) => {
    clearResetTimer();
    resetTimerRef.current = window.setTimeout(() => {
      resetTimerRef.current = null;
      setState("idle");
    }, ms);
  };

  const onPin = async () => {
    if (inFlightRef.current || state === "pinning" || state === "pinned") return;

    // Optional title prompt. Default = first line of the answer
    // (truncated) so the user can hit Enter to accept; clearing the
    // field and submitting empty falls through to the server's
    // deriveTitle so the contract stays satisfied either way.
    const head = (answer.split("\n")[0] ?? "").trim().slice(0, 80);
    const default_title = head ? `Pin: ${head}` : "";
    const entered = window.prompt(
      "Title for this pin (leave blank to auto-generate):",
      default_title,
    );
    if (entered === null) return; // user cancelled — leave state untouched
    const title = entered.trim().length > 0 ? entered.trim() : undefined;

    inFlightRef.current = true;
    clearResetTimer();
    setState("pinning");
    try {
      const body: Record<string, unknown> = {
        content: answer,
        source_task_id: task_id,
      };
      if (title !== undefined) body.title = title;
      const r = await fetch("/api/scratchpad/pin", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`POST /api/scratchpad/pin failed: ${r.status}`);
      setState("pinned");
      toast({
        title: "Pinned to scratchpad",
        description: "This answer will be available to future tasks via your continuity context.",
      });
      scheduleReset(2000);
    } catch (err) {
      setState("error");
      toast({
        title: "Pin failed",
        description: err instanceof Error ? err.message : "Could not save to scratchpad.",
        variant: "destructive",
      });
      scheduleReset(2500);
    } finally {
      inFlightRef.current = false;
    }
  };
  const label =
    state === "pinning" ? "Pinning…" :
    state === "pinned"  ? "Pinned"   :
    state === "error"   ? "Failed"   : "Pin";
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onPin}
      data-testid="button-pin-message"
      disabled={state === "pinning" || state === "pinned"}
      className="h-auto inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-60 disabled:cursor-default"
      aria-label={state === "pinned" ? "Pinned to scratchpad" : "Pin to scratchpad"}
      title={
        state === "pinned" ? "Pinned to scratchpad" :
        state === "error"  ? "Pin failed — try again" :
        "Pin this answer into your scratchpad memory layer"
      }
    >
      {state === "pinning"
        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
        : state === "pinned"
          ? <Check className="w-3.5 h-3.5 text-green-700" />
          : <Pin className="w-3.5 h-3.5" />}
      {label}
    </Button>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
      document.body.removeChild(ta);
    }
  };
  return (
    <button
      type="button"
      onClick={onCopy}
      className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
      aria-label={copied ? "Copied" : "Copy to clipboard"}
      title={copied ? "Copied" : "Copy answer"}
    >
      {copied ? <Check className="w-3.5 h-3.5 text-green-700" /> : <Copy className="w-3.5 h-3.5" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function UserBubble({ msg }: { msg: UserMessage }) {
  return (
    <div className="flex gap-3 justify-end">
      <div className="max-w-[78%] flex flex-col items-end gap-1.5">
        {msg.attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 justify-end">
            {msg.attachments.map((a) => (
              <div
                key={a.id}
                className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-secondary border border-border text-[11.5px] text-foreground max-w-[220px]"
                title={a.original_name}
              >
                <span className="text-muted-foreground">{attachmentIcon(a.kind)}</span>
                <span className="truncate">{a.original_name}</span>
              </div>
            ))}
          </div>
        )}
        {msg.text && (
          <div className="bg-primary text-primary-foreground rounded-2xl rounded-tr-sm px-4 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap break-words shadow-card select-text">
            {msg.text}
          </div>
        )}
      </div>
      <div className="w-7 h-7 rounded-full bg-secondary border border-border flex items-center justify-center text-muted-foreground shrink-0 mt-1">
        <User className="w-3.5 h-3.5" />
      </div>
    </div>
  );
}

function AssistantBubble({ msg }: { msg: AssistantMessage }) {
  const [showDetails, setShowDetails] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  const answer_text = msg.task?.bos_output?.answer ?? "";
  const has_details = !!msg.task?.bos_output && (
    (msg.task.bos_output.assumptions?.length ?? 0) > 0 ||
    (msg.task.bos_output.uncertainties?.length ?? 0) > 0 ||
    (msg.task.bos_output.missing_inputs?.length ?? 0) > 0 ||
    (msg.task.bos_output.failure_modes?.length ?? 0) > 0 ||
    !!msg.task.bos_output.recommended_next_action ||
    (msg.task.bos_output.parallel_responses?.length ?? 0) > 0
  );

  return (
    <div className="flex gap-3 justify-start">
      <div className="w-7 h-7 rounded-full bg-accent/15 border border-accent/30 flex items-center justify-center text-accent shrink-0 mt-1">
        <Bot className="w-3.5 h-3.5" />
      </div>
      <div className="max-w-[88%] flex-1 min-w-0">
        <div className="bg-card border border-card-border rounded-2xl rounded-tl-sm shadow-card overflow-hidden">
          {/* Header */}
          <div className="flex items-center gap-2 px-4 py-2 border-b border-card-border bg-secondary/40 flex-wrap">
            <span className="text-[10px] font-mono font-bold text-primary tracking-wider">BOS-OMEGA</span>
            <span className="text-[10px] font-mono text-muted-foreground uppercase">{msg.mode.replace("_", " ")}</span>
            {msg.task?.bos_output?.front_door_route ? (
              <FrontDoorGuidanceBadge route={msg.task.bos_output.front_door_route} />
            ) : (
              msg.task?.tri_state && <TriStateBadge state={msg.task.tri_state} />
            )}
            {msg.task?.selected_provider && (
              <span className="text-[10px] font-mono text-muted-foreground">
                {msg.task.selected_provider}/{msg.task.selected_model}
              </span>
            )}
            {msg.status === "done" && answer_text && (
              <div className="ml-auto flex items-center gap-1">
                <PinButton task_id={msg.task?.task_id} answer={answer_text} />
                <CopyButton text={answer_text} />
              </div>
            )}
          </div>

          {/* Body */}
          <div className="px-4 py-3.5">
            {msg.status === "pending" && (
              <div className="flex items-center gap-2.5 text-[13.5px] text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin text-accent" />
                <span>{MODE_LABEL(msg.mode, msg.max_models, msg.agents_per_model)}</span>
              </div>
            )}

            {msg.status === "error" && (
              <div className="flex items-start gap-2 text-[13px] text-red-800 bg-red-50 border border-red-200 rounded-md p-3">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <div>
                  <div className="font-medium mb-0.5">Pipeline failed</div>
                  <div className="text-[12px] text-red-800/90">{msg.error ?? "Unknown error"}</div>
                </div>
              </div>
            )}

            {msg.status === "done" && msg.task && (
              <>
                {answer_text ? (
                  <div className="text-[14px] text-foreground leading-relaxed whitespace-pre-wrap break-words select-text">
                    {answer_text}
                  </div>
                ) : (
                  <div className="text-[13px] text-muted-foreground italic">No answer text returned.</div>
                )}

                {/* Task #83 — render images produced by the image-generation
                    provider bridge. Each ref carries an attachment_id served
                    by /api/uploads/{id}/raw with the same auth-check as user
                    uploads (owner / super_admin). The "MOCK" pill makes it
                    impossible to confuse a deterministic mock-mode image
                    with a real provider response. */}
                {(msg.task.bos_output?.generated_attachments?.length ?? 0) > 0 && (
                  <div className="mt-3 grid gap-3 grid-cols-1 sm:grid-cols-2">
                    {msg.task.bos_output!.generated_attachments!.map((ref) => (
                      <figure
                        key={ref.id}
                        className="rounded-md border border-border bg-muted/30 overflow-hidden"
                      >
                        <a
                          href={`/api/uploads/${ref.id}/raw`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block bg-checker"
                        >
                          <img
                            src={`/api/uploads/${ref.id}/raw`}
                            alt={ref.original_name}
                            width={ref.width ?? undefined}
                            height={ref.height ?? undefined}
                            loading="lazy"
                            className="block w-full h-auto object-contain max-h-96 bg-white"
                            style={{ imageRendering: ref.mock ? "pixelated" : "auto" }}
                          />
                        </a>
                        <figcaption className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-[10px] font-mono text-muted-foreground border-t border-border">
                          <span className="truncate">
                            {ref.provider}:{ref.model}
                          </span>
                          {ref.mock && (
                            <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-900 border border-amber-300 font-semibold tracking-wider">
                              MOCK
                            </span>
                          )}
                        </figcaption>
                      </figure>
                    ))}
                  </div>
                )}

                {has_details && (
                  <button
                    type="button"
                    onClick={() => setShowDetails((v) => !v)}
                    className="mt-3 inline-flex items-center gap-1 text-[11px] font-mono text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {showDetails ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                    {showDetails ? "Hide structured details" : "Show structured details"}
                  </button>
                )}

                {showDetails && msg.task.bos_output && (
                  <div className="mt-3 space-y-4">
                    <TriStateVector task_id={msg.task.task_id} />

                    {(msg.task.bos_output.parallel_responses?.length ?? 0) > 0 && msg.task.execution_mode !== "series_pass" && (
                      <div>
                        <div className="text-[10px] font-mono text-muted-foreground mb-2 tracking-wider">
                          {msg.task.execution_mode === "boil_the_ocean" ? "TOP AGENT OUTPUTS" : "PARALLEL MODEL RESPONSES"}
                        </div>
                        <div
                          className="grid gap-2"
                          style={{ gridTemplateColumns: `repeat(${Math.min(msg.task.bos_output.parallel_responses!.length, 4)}, 1fr)` }}
                        >
                          {msg.task.bos_output.parallel_responses!.slice(0, 8).map((pr, i) => (
                            <div
                              key={i}
                              className={`p-3 rounded border text-xs ${pr.selected ? "border-primary bg-secondary" : "border-border bg-secondary"}`}
                            >
                              <div className="flex items-center justify-between mb-1">
                                <span className="font-mono font-bold text-[10px] text-foreground truncate">{pr.provider}/{pr.model}</span>
                                {pr.selected && <span className="text-[9px] text-primary font-mono shrink-0 ml-1">SELECTED</span>}
                              </div>
                              <div className="flex gap-2 mb-1.5">
                                <TriStateBadge state={pr.state} />
                                {pr.confidence_score != null && <ScoreBar score={pr.confidence_score} />}
                              </div>
                              <p className="text-muted-foreground text-[10px] leading-relaxed line-clamp-3 select-text">{pr.answer}</p>
                            </div>
                          ))}
                        </div>
                        {msg.task.bos_output.merge_strategy && (
                          <div className="mt-2 text-[10px] font-mono text-muted-foreground">
                            STRATEGY: <span className="text-primary">{msg.task.bos_output.merge_strategy}</span>
                          </div>
                        )}
                      </div>
                    )}

                    <div className="grid grid-cols-2 gap-4">
                      {(msg.task.bos_output.assumptions?.length ?? 0) > 0 && (
                        <div>
                          <div className="text-[10px] font-mono text-amber-700 mb-1.5 tracking-wider">ASSUMPTIONS</div>
                          <ul className="space-y-1">
                            {msg.task.bos_output.assumptions!.map((a, i) => (
                              <li key={i} className="text-xs text-muted-foreground font-mono flex gap-2 select-text">
                                <span className="text-amber-700 shrink-0">△</span>{a}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {(msg.task.bos_output.uncertainties?.length ?? 0) > 0 && (
                        <div>
                          <div className="text-[10px] font-mono text-blue-700 mb-1.5 tracking-wider">UNCERTAINTIES</div>
                          <ul className="space-y-1">
                            {msg.task.bos_output.uncertainties!.map((u, i) => (
                              <li key={i} className="text-xs text-muted-foreground font-mono flex gap-2 select-text">
                                <span className="text-blue-700 shrink-0">?</span>{u}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {(msg.task.bos_output.missing_inputs?.length ?? 0) > 0 && (
                        <div>
                          <div className="text-[10px] font-mono text-amber-700 mb-1.5 tracking-wider">MISSING INPUTS</div>
                          <ul className="space-y-1">
                            {msg.task.bos_output.missing_inputs!.map((m, i) => (
                              <li key={i} className="text-xs text-muted-foreground font-mono flex gap-2 select-text">
                                <span className="text-amber-700 shrink-0">!</span>{m}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {(msg.task.bos_output.failure_modes?.length ?? 0) > 0 && (
                        <div>
                          <div className="text-[10px] font-mono text-red-700 mb-1.5 tracking-wider">FAILURE MODES</div>
                          <ul className="space-y-1">
                            {msg.task.bos_output.failure_modes!.map((f, i) => (
                              <li key={i} className="text-xs text-muted-foreground font-mono flex gap-2 select-text">
                                <span className="text-red-700 shrink-0">✗</span>{f}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>

                    {msg.task.bos_output.recommended_next_action && (
                      <div className="border border-border bg-secondary rounded p-3">
                        <div className="text-[10px] font-mono text-primary mb-1 tracking-wider">RECOMMENDED NEXT ACTION</div>
                        <p className="text-xs text-foreground font-mono select-text">{msg.task.bos_output.recommended_next_action}</p>
                      </div>
                    )}

                    {msg.task.run_id && (msg.task.execution_mode === "series_pass" || msg.task.execution_mode === "boil_the_ocean") && (
                      <ExecutionTrace run_id={msg.task.run_id} mode={msg.task.execution_mode} />
                    )}

                    <div>
                      <button
                        type="button"
                        onClick={() => setShowRaw((v) => !v)}
                        className="inline-flex items-center gap-1 text-[11px] font-mono text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {showRaw ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                        RAW JSON OUTPUT
                      </button>
                      {showRaw && (
                        <pre className="mt-2 bg-secondary border border-border rounded p-3 text-[11px] font-mono text-muted-foreground overflow-x-auto select-text">
                          {JSON.stringify(msg.task.bos_output, null, 2)}
                        </pre>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
        {msg.task?.task_id && (
          <div className="mt-1 ml-1 text-[10px] font-mono text-muted-foreground">{msg.task.task_id}</div>
        )}
      </div>
    </div>
  );
}

export function MessageList({ messages }: { messages: ChatMessage[] }) {
  const endRef = useRef<HTMLDivElement>(null);

  const last = messages[messages.length - 1];
  const last_id = last?.id;
  const last_assistant_status = last && last.role === "assistant" ? last.status : null;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [last_id, last_assistant_status]);

  if (messages.length === 0) return null;

  return (
    <div
      className="space-y-5"
      role="log"
      aria-live="polite"
      aria-relevant="additions text"
      aria-label="BOS-Omega conversation"
    >
      {messages.map((m) =>
        m.role === "user" ? (
          <UserBubble key={m.id} msg={m} />
        ) : (
          <AssistantBubble key={m.id} msg={m} />
        ),
      )}
      <div ref={endRef} />
    </div>
  );
}
