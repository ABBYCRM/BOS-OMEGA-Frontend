import { cn } from "@/lib/utils";

type TriState = "GO" | "HOLD" | "ABORT";
type ProviderStatus = "HEALTHY" | "DEGRADED" | "OPEN_CIRCUIT" | "RECOVERY_TEST";

export function TriStateBadge({ state }: { state: TriState | string }) {
  const classes: Record<string, string> = {
    GO: "bg-green-500/15 text-green-400 border-green-500/30",
    HOLD: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    ABORT: "bg-red-500/15 text-red-400 border-red-500/30",
  };
  const dots: Record<string, string> = {
    GO: "bg-green-400",
    HOLD: "bg-amber-400",
    ABORT: "bg-red-400",
  };
  return (
    <span className={cn("inline-flex items-center gap-1.5 px-2 py-0.5 rounded border text-[11px] font-mono font-bold tracking-wider", classes[state] || "bg-muted text-muted-foreground border-border")}>
      <span className={cn("w-1.5 h-1.5 rounded-full", dots[state] || "bg-muted-foreground")} />
      {state}
    </span>
  );
}

export function ProviderStatusBadge({ status }: { status: ProviderStatus | string }) {
  const classes: Record<string, string> = {
    HEALTHY: "bg-green-500/15 text-green-400 border-green-500/30",
    DEGRADED: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    OPEN_CIRCUIT: "bg-red-500/15 text-red-400 border-red-500/30",
    RECOVERY_TEST: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  };
  return (
    <span className={cn("inline-flex items-center px-2 py-0.5 rounded border text-[11px] font-mono tracking-wider", classes[status] || "bg-muted text-muted-foreground border-border")}>
      {status?.replace("_", " ")}
    </span>
  );
}

export function TaskStatusBadge({ status }: { status: string }) {
  const classes: Record<string, string> = {
    COMPLETED: "bg-green-500/15 text-green-400 border-green-500/30",
    ABORTED: "bg-red-500/15 text-red-400 border-red-500/30",
    HELD: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    RUNNING: "bg-blue-500/15 text-blue-400 border-blue-500/30",
    pending: "bg-muted text-muted-foreground border-border",
  };
  return (
    <span className={cn("inline-flex items-center px-2 py-0.5 rounded border text-[11px] font-mono tracking-wider", classes[status] || "bg-muted text-muted-foreground border-border")}>
      {status}
    </span>
  );
}
