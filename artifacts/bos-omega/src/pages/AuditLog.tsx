import { useListAuditLogs } from "@workspace/api-client-react";
import { formatDate } from "@/lib/utils";
import { ScrollText } from "lucide-react";

const eventTypeColors: Record<string, string> = {
  TASK_RECEIVED: "text-blue-400",
  INPUT_GATE_RESULT: "text-cyan-400",
  TASK_CLASSIFIED: "text-purple-400",
  TRI_STATE_EVALUATED: "text-yellow-400",
  MODEL_SELECTED: "text-green-400",
  LLM_CALL_STARTED: "text-primary",
  LLM_CALL_COMPLETED: "text-green-400",
  LLM_CALL_FAILED: "text-red-400",
  VALIDATION_COMPLETED: "text-amber-400",
  REPAIR_APPLIED: "text-orange-400",
  FALLBACK_TRIGGERED: "text-red-400",
  PARALLEL_EXECUTION_STARTED: "text-cyan-400",
  PARALLEL_EXECUTION_COMPLETED: "text-cyan-400",
  MERGE_COMPLETED: "text-green-400",
  TASK_COMPLETED: "text-green-400",
  TASK_ABORTED: "text-red-500",
  TASK_HELD: "text-amber-400",
  CIRCUIT_BREAKER_OPENED: "text-red-500",
  CIRCUIT_BREAKER_CLOSED: "text-green-400",
};

export function AuditLog() {
  const { data = [], isLoading } = useListAuditLogs({ limit: 200 });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <ScrollText className="w-4 h-4 text-primary" />
        <h1 className="text-sm font-mono font-bold tracking-wider">AUDIT LOG</h1>
        <span className="text-[11px] font-mono text-muted-foreground">({data.length} entries)</span>
      </div>

      <div className="bg-card border border-card-border rounded-lg overflow-hidden">
        <div className="px-4 py-2 border-b border-border bg-muted/20">
          <div className="grid grid-cols-4 gap-4 text-[10px] font-mono text-muted-foreground tracking-wider">
            <span>TIMESTAMP</span>
            <span>EVENT TYPE</span>
            <span>MESSAGE</span>
            <span>TASK ID</span>
          </div>
        </div>
        <div className="max-h-[600px] overflow-y-auto">
          {isLoading ? (
            <div className="p-4 text-xs font-mono text-muted-foreground">Loading audit logs...</div>
          ) : data.length === 0 ? (
            <div className="p-8 text-center text-xs font-mono text-muted-foreground">No audit entries yet.</div>
          ) : (
            data.map((log, i) => (
              <div key={log.id} className={`px-4 py-2 border-b border-border/30 last:border-0 hover:bg-muted/10 transition-colors ${i % 2 === 0 ? "" : "bg-muted/5"}`}>
                <div className="grid grid-cols-4 gap-4 text-xs font-mono">
                  <span className="text-muted-foreground text-[10px]">{formatDate(log.created_at)}</span>
                  <span className={eventTypeColors[log.event_type] || "text-muted-foreground"}>{log.event_type}</span>
                  <span className="text-foreground">{log.message}</span>
                  <span className="text-primary text-[10px]">{log.task_id ? log.task_id.slice(0, 8) + "..." : "—"}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
