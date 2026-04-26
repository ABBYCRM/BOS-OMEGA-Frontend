import { useListFallbackEvents } from "@workspace/api-client-react";
import { formatDate } from "@/lib/utils";
import { GitBranch } from "lucide-react";

export function FallbackEvents() {
  const { data = [], isLoading } = useListFallbackEvents({ limit: 100 });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <GitBranch className="w-4 h-4 text-primary" />
        <h1 className="text-sm font-mono font-bold tracking-wider">FALLBACK EVENTS</h1>
        <span className="text-[11px] font-mono text-muted-foreground">({data.length} events)</span>
      </div>

      {isLoading ? (
        <div className="text-xs font-mono text-muted-foreground">Loading fallback events...</div>
      ) : data.length === 0 ? (
        <div className="bg-card border border-card-border rounded-lg p-8 text-center">
          <GitBranch className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
          <div className="text-sm font-mono text-muted-foreground">No fallback events recorded.</div>
          <div className="text-xs font-mono text-muted-foreground mt-1">Fallbacks occur when a provider fails and routes to another.</div>
        </div>
      ) : (
        <div className="space-y-2">
          {data.map((event) => (
            <div key={event.id} className="bg-card border border-card-border rounded-lg px-5 py-3 flex items-center gap-4">
              <div className="flex items-center gap-2 flex-1">
                <div className="text-xs font-mono">
                  <span className="text-red-400 font-semibold">{event.from_provider || "—"}/{event.from_model || "—"}</span>
                  <span className="text-muted-foreground mx-2">→</span>
                  <span className="text-green-400 font-semibold">{event.to_provider || "—"}/{event.to_model || "—"}</span>
                </div>
              </div>
              <div className="flex-1">
                <span className="text-[11px] font-mono text-muted-foreground">REASON: </span>
                <span className="text-[11px] font-mono text-amber-400">{event.reason}</span>
              </div>
              <div className="text-[10px] font-mono text-muted-foreground flex-shrink-0">{formatDate(event.created_at)}</div>
              {event.task_id && (
                <div className="text-[10px] font-mono text-primary flex-shrink-0">TASK: {event.task_id.slice(0, 8)}...</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
