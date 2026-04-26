import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useOverrideUnlockTask,
  useOverrideForceTriState,
  useOverrideResetRun,
} from "@workspace/api-client-react";
import { fetchAuthState } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Unlock, ShieldAlert, RotateCcw, Loader2 } from "lucide-react";

type Decision = "GO" | "HOLD" | "ABORT";

type Action = "unlock" | "force-tri-state" | "reset-run";

export function OverrideActions({ taskId, runId }: { taskId: string; runId?: string | null }) {
  const qc = useQueryClient();
  const { data: auth } = useQuery({ queryKey: ["auth-state"], queryFn: fetchAuthState, retry: false });
  const isSuper = auth?.authenticated && auth.user.role === "super_admin";

  const [open, setOpen] = useState<Action | null>(null);
  const [reason, setReason] = useState("");
  const [decision, setDecision] = useState<Decision>("GO");
  const [error, setError] = useState<string | null>(null);

  const unlockMut = useOverrideUnlockTask();
  const forceMut = useOverrideForceTriState();
  const resetMut = useOverrideResetRun();
  const isPending = unlockMut.isPending || forceMut.isPending || resetMut.isPending;

  const closeAndReset = () => {
    setOpen(null);
    setReason("");
    setDecision("GO");
    setError(null);
  };

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: [`/api/tasks/${taskId}`] });
    void qc.invalidateQueries({ queryKey: ["/api/tasks"] });
  };

  const onSubmit = async () => {
    setError(null);
    try {
      if (open === "unlock") {
        await unlockMut.mutateAsync({ data: { task_id: taskId, reason } });
      } else if (open === "force-tri-state") {
        await forceMut.mutateAsync({ data: { task_id: taskId, decision, reason } });
      } else if (open === "reset-run") {
        if (!runId) throw new Error("No run id available for this task");
        await resetMut.mutateAsync({ data: { run_id: runId, reason } });
      }
      refresh();
      closeAndReset();
    } catch (e) {
      const msg = (e as { data?: { error?: string }; message?: string })?.data?.error
        || (e as Error).message
        || "Override failed";
      setError(msg);
    }
  };

  if (!isSuper) return null;

  return (
    <>
      <div className="bg-amber-50/50 border border-amber-200 rounded-lg p-4">
        <div className="flex items-center gap-2 mb-3">
          <ShieldAlert className="w-4 h-4 text-amber-700" />
          <h3 className="text-[12px] font-semibold text-amber-900 tracking-tight">Super-admin overrides</h3>
        </div>
        <p className="text-[11px] text-amber-900/80 mb-3">
          These actions snap state past the orchestrator. Every override is recorded in the audit log with your reason text.
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            size="sm"
            variant="outline"
            className="border-amber-300 text-amber-900 hover:bg-amber-100"
            onClick={() => setOpen("unlock")}
            data-testid="button-override-unlock"
          >
            <Unlock className="w-3 h-3 mr-1.5" /> Unlock HOLD
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="border-amber-300 text-amber-900 hover:bg-amber-100"
            onClick={() => setOpen("force-tri-state")}
            data-testid="button-override-force-tri-state"
          >
            <ShieldAlert className="w-3 h-3 mr-1.5" /> Force tri-state
          </Button>
          {runId && (
            <Button
              size="sm"
              variant="outline"
              className="border-amber-300 text-amber-900 hover:bg-amber-100"
              onClick={() => setOpen("reset-run")}
              data-testid="button-override-reset-run"
            >
              <RotateCcw className="w-3 h-3 mr-1.5" /> Reset run
            </Button>
          )}
        </div>
      </div>

      <Dialog open={open !== null} onOpenChange={(v) => !v && closeAndReset()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {open === "unlock" && "Force-unlock HOLD"}
              {open === "force-tri-state" && "Force tri-state decision"}
              {open === "reset-run" && "Reset stuck run"}
            </DialogTitle>
            <DialogDescription>
              This action is recorded in the audit log with your name, the target id, and the reason text below.
              It cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {open === "force-tri-state" && (
              <div>
                <label className="text-xs font-mono text-muted-foreground mb-1 block">Force decision to</label>
                <Select value={decision} onValueChange={(v) => setDecision(v as Decision)}>
                  <SelectTrigger data-testid="select-force-decision">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="GO">GO</SelectItem>
                    <SelectItem value="HOLD">HOLD</SelectItem>
                    <SelectItem value="ABORT">ABORT</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            <div>
              <label className="text-xs font-mono text-muted-foreground mb-1 block">
                Reason (required, ≥3 chars)
              </label>
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why are you overriding this?"
                data-testid="input-override-reason"
              />
            </div>
            {error && (
              <div className="text-sm text-red-800 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeAndReset}>Cancel</Button>
            <Button
              onClick={onSubmit}
              disabled={isPending || reason.trim().length < 3}
              data-testid="button-confirm-override"
            >
              {isPending ? <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" /> : null}
              Confirm override
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
