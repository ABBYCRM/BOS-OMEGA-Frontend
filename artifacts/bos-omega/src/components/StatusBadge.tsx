import { cn } from "@/lib/utils";

type TriState = "GO" | "HOLD" | "ABORT";
type ProviderStatus = "HEALTHY" | "DEGRADED" | "OPEN_CIRCUIT" | "RECOVERY_TEST";

const baseBadge =
  "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border text-[11px] font-medium tracking-tight";

export function TriStateBadge({ state }: { state: TriState | string }) {
  const classes: Record<string, string> = {
    GO: "bg-green-50 text-green-800 border-green-200",
    HOLD: "bg-amber-50 text-amber-800 border-amber-200",
    ABORT: "bg-red-50 text-red-800 border-red-200",
  };
  const dots: Record<string, string> = {
    GO: "bg-green-600",
    HOLD: "bg-amber-600",
    ABORT: "bg-red-600",
  };
  return (
    <span className={cn(baseBadge, classes[state] || "bg-muted text-muted-foreground border-border")}>
      <span className={cn("w-1.5 h-1.5 rounded-full", dots[state] || "bg-muted-foreground")} />
      {state}
    </span>
  );
}

export function ProviderStatusBadge({ status }: { status: ProviderStatus | string }) {
  const classes: Record<string, string> = {
    HEALTHY: "bg-green-50 text-green-800 border-green-200",
    DEGRADED: "bg-amber-50 text-amber-800 border-amber-200",
    OPEN_CIRCUIT: "bg-red-50 text-red-800 border-red-200",
    RECOVERY_TEST: "bg-blue-50 text-blue-800 border-blue-200",
  };
  const label = (status || "").replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  return (
    <span className={cn(baseBadge, classes[status] || "bg-muted text-muted-foreground border-border")}>
      {label}
    </span>
  );
}

export function TaskStatusBadge({ status }: { status: string }) {
  const classes: Record<string, string> = {
    COMPLETED: "bg-green-50 text-green-800 border-green-200",
    ABORTED: "bg-red-50 text-red-800 border-red-200",
    HELD: "bg-amber-50 text-amber-800 border-amber-200",
    RUNNING: "bg-blue-50 text-blue-800 border-blue-200",
    pending: "bg-muted text-muted-foreground border-border",
  };
  const label = status?.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  return (
    <span className={cn(baseBadge, classes[status] || "bg-muted text-muted-foreground border-border")}>
      {label}
    </span>
  );
}
