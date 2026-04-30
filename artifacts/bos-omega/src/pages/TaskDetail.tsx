import { useRoute } from "wouter";
import { useGetTask } from "@workspace/api-client-react";
import { TaskStatusBadge } from "@/components/StatusBadge";
import { MemoryUsedPanel } from "@/components/MemoryUsedPanel";
import { ActivePersonaPanel } from "@/components/ActivePersonaPanel";
import { ScratchpadPanel } from "@/components/ScratchpadPanel";
import { CopyContinuityBundle } from "@/components/ContinuityBundleControls";
import { formatDate, formatMs, formatCost } from "@/lib/utils";
import { Link } from "wouter";
import { ArrowLeft, CheckCircle, XCircle, Play } from "lucide-react";

export function TaskDetail() {
  const [, params] = useRoute("/tasks/:id");
  const id = params?.id || "";

  // Provide queryKey explicitly to satisfy orval's generated UseQueryOptions
  // type (matches the URL pattern orval uses internally for caching).
  const { data, isLoading } = useGetTask(id, {
    query: { queryKey: [`/api/tasks/${id}`], enabled: !!id, retry: false },
  });

  if (isLoading) {
    return <div className="text-xs font-mono text-muted-foreground">Loading task trace...</div>;
  }

  if (!data) {
    return (
      <div className="text-xs font-mono text-red-700">
        Task not found.{" "}
        <Link href="/tasks"><span className="text-primary hover:underline">Back to Task Logs</span></Link>
      </div>
    );
  }

  const { task, attempts = [], validation = [], fallbacks = [], audit = [], bos_output } = data;
  return (
    <div className="max-w-5xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/tasks">
          <span className="flex items-center gap-1 text-xs font-mono text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
            <ArrowLeft className="w-3 h-3" />
            BACK
          </span>
        </Link>
        <div className="w-px h-4 bg-border" />
        <div className="font-mono text-xs text-muted-foreground">TASK_ID: <span className="text-foreground">{id}</span></div>
        {/* Task #64: continuity bundle export + Resume in console.
            Resume routes to the conversation when the task was pinned to
            one (the post-Lattice-conversation case for almost every
            task), and falls back to ?task=<id> for legacy orphans so the
            link always lands somewhere useful. */}
        <div className="ml-auto flex items-center gap-2">
          <CopyContinuityBundle
            taskId={id}
            conversationId={(task as { conversation_id?: string | null }).conversation_id ?? null}
            compact
            label="Copy bundle"
          />
          {(task as { conversation_id?: string | null }).conversation_id ? (
            <Link href={`/console?conversation=${(task as { conversation_id?: string }).conversation_id}`}>
              <span
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-[12px] font-medium text-foreground hover:bg-secondary cursor-pointer"
                data-testid="link-resume-in-console"
              >
                <Play className="w-3.5 h-3.5" />
                Resume in console
              </span>
            </Link>
          ) : (
            <Link href={`/console?task=${id}`}>
              <span
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-[12px] font-medium text-muted-foreground hover:bg-secondary cursor-pointer"
                data-testid="link-resume-task"
              >
                <Play className="w-3.5 h-3.5" />
                Open in console
              </span>
            </Link>
          )}
        </div>
      </div>

      {/* Task summary */}
      <div className="bg-card border border-card-border rounded-lg p-5">
        <div className="flex items-center gap-4 mb-4">
          <TaskStatusBadge status={task.final_status} />
          <span className="font-mono text-xs text-muted-foreground">TYPE: <span className="text-foreground">{task.task_type}</span></span>
          <span className="font-mono text-xs text-muted-foreground">MODE: <span className="text-foreground">{task.mode || "single"}</span></span>
          <span className="ml-auto font-mono text-[10px] text-muted-foreground">{formatDate(task.created_at)}</span>
        </div>
        <div className="bg-secondary border border-border rounded p-3 text-xs font-mono text-foreground leading-relaxed">
          {task.input_text}
        </div>
        {task.selected_provider && (
          <div className="mt-2 text-[11px] font-mono text-muted-foreground">
            ROUTED TO: <span className="text-primary">{task.selected_provider} / {task.selected_model}</span>
          </div>
        )}
      </div>

      {/* Memory used (Task #47): per-layer counts, rendered section list,
          and the bounded preview the orchestrator persisted on the
          MEMORY_INJECTED audit event. Collapsed by default to keep the
          trace compact. */}
      <MemoryUsedPanel audit={audit} taskId={id} />

      {/* Task #57: persona overlay used for this task (slot A/B/C). The
          panel reads persona_slot + persona_title off the TASK_RECEIVED
          audit row, links to the slot in the console editor, and falls
          back to "no longer available" if the slot was edited or cleared
          after the task ran. Renders nothing for tasks that didn't use a
          persona. */}
      <ActivePersonaPanel audit={audit} />

      {/* Task #64: read-only scratchpad scoped to this task. Surfaces
          the auto-summary the orchestrator wrote at completion plus any
          manually pinned notes that target this task. Read-only here —
          the live console is the surface for write actions. */}
      <ScratchpadPanel
        taskId={id}
        readOnly
        heading="Scratchpad for this task"
        subtitle="Pins and the auto-summary written when this task completed."
      />

      {/* Pipeline trace */}
      <div className="bg-card border border-card-border rounded-lg p-5">
        <h3 className="text-[10px] font-mono text-muted-foreground tracking-wider mb-4">PIPELINE TRACE</h3>
        <div className="space-y-1">
          {audit.map((entry, i) => (
            <div key={entry.id} className="flex items-start gap-3 py-1.5 border-b border-border/30 last:border-0">
              <span className="font-mono text-[10px] text-muted-foreground w-16 flex-shrink-0 pt-0.5">{String(i + 1).padStart(2, "0")}</span>
              <div className="flex-shrink-0 w-40">
                <span className="font-mono text-[10px] text-primary">{entry.event_type}</span>
              </div>
              <span className="font-mono text-xs text-foreground flex-1">{entry.message}</span>
              <span className="font-mono text-[10px] text-muted-foreground flex-shrink-0">{formatDate(entry.created_at)}</span>
            </div>
          ))}
          {audit.length === 0 && (
            <div className="text-xs font-mono text-muted-foreground">No audit trail available</div>
          )}
        </div>
      </div>

      {/* Model attempts */}
      {attempts.length > 0 && (
        <div className="bg-card border border-card-border rounded-lg p-5">
          <h3 className="text-[10px] font-mono text-muted-foreground tracking-wider mb-4">MODEL ATTEMPTS ({attempts.length})</h3>
          <div className="space-y-2">
            {attempts.map((a) => (
              <div key={a.id} className={`border rounded p-3 ${a.status === "success" ? "border-green-200 bg-green-500/5" : "border-red-200 bg-red-500/5"}`}>
                <div className="flex items-center gap-3 mb-1">
                  <span className={`font-mono text-xs font-bold ${a.status === "success" ? "text-green-700" : "text-red-700"}`}>
                    #{a.attempt_number} {a.provider}/{a.model}
                  </span>
                  {a.is_parallel && (
                    <span className="text-[10px] font-mono text-cyan-400 border border-cyan-500/30 px-1.5 rounded bg-cyan-500/10">PARALLEL</span>
                  )}
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                    {formatMs(a.latency_ms)} | {a.token_input ?? 0}in / {a.token_output ?? 0}out | {formatCost(a.cost_estimate)}
                  </span>
                </div>
                {a.error_type && (
                  <span className="text-[11px] font-mono text-red-700">ERROR: {a.error_type}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Validation */}
      {validation.length > 0 && (
        <div className="bg-card border border-card-border rounded-lg p-5">
          <h3 className="text-[10px] font-mono text-muted-foreground tracking-wider mb-4">VALIDATION RESULTS</h3>
          {validation.map((v) => (
            <div key={v.id} className="grid grid-cols-5 gap-3">
              {[
                { label: "SCHEMA", pass: v.schema_pass },
                { label: "SAFETY", pass: v.safety_pass },
                { label: "INSTRUCTION", pass: v.instruction_pass },
                { label: "COMPLETENESS", pass: v.completeness_pass },
              ].map((check) => (
                <div key={check.label} className={`p-3 rounded border text-center ${check.pass ? "border-green-200 bg-green-500/10" : "border-red-200 bg-red-500/10"}`}>
                  {check.pass
                    ? <CheckCircle className="w-4 h-4 text-green-700 mx-auto mb-1" />
                    : <XCircle className="w-4 h-4 text-red-700 mx-auto mb-1" />}
                  <div className="text-[10px] font-mono text-muted-foreground">{check.label}</div>
                </div>
              ))}
              <div className="p-3 rounded border border-border bg-secondary text-center">
                <div className="text-lg font-mono font-bold text-primary">{((v.confidence_score || 0) * 100).toFixed(0)}%</div>
                <div className="text-[10px] font-mono text-muted-foreground">CONFIDENCE</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* BOS Output */}
      {bos_output && (
        <div className="bg-card border border-card-border rounded-lg p-5">
          <h3 className="text-[10px] font-mono text-muted-foreground tracking-wider mb-4">BOS OUTPUT</h3>
          <pre className="bg-secondary border border-border rounded p-4 text-[11px] font-mono text-muted-foreground overflow-x-auto">
            {JSON.stringify(bos_output, null, 2)}
          </pre>
        </div>
      )}

      {/* Fallbacks */}
      {fallbacks.length > 0 && (
        <div className="bg-card border border-card-border rounded-lg p-5">
          <h3 className="text-[12px] font-medium text-foreground mb-3">Fallback events ({fallbacks.length})</h3>
          {fallbacks.map((f) => (
            <div key={f.id} className="flex items-center gap-3 py-2 border-b border-border/30 last:border-0 text-xs font-mono">
              <span className="text-red-700">{f.from_provider}/{f.from_model}</span>
              <span className="text-muted-foreground">→</span>
              <span className="text-green-700">{f.to_provider}/{f.to_model}</span>
              <span className="text-muted-foreground flex-1">REASON: {f.reason}</span>
              <span className="text-muted-foreground text-[10px]">{formatDate(f.created_at)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
