import { useGetTriStateByTask } from "@workspace/api-client-react";
import { Atom, Zap } from "lucide-react";

interface EvidenceSignal {
  name: string;
  category: string;
  description: string;
  impact: { go: number; hold: number; abort: number };
}

const CATEGORY_ICONS: Record<string, string> = {
  safety: "🛡",
  completeness: "▦",
  confidence: "◈",
  source_quality: "◍",
  tool_availability: "◉",
  intent_clarity: "◎",
  risk: "△",
};

const CATEGORY_COLORS: Record<string, string> = {
  safety: "text-red-700 border-red-200 bg-red-500/5",
  completeness: "text-amber-700 border-amber-200 bg-amber-500/5",
  confidence: "text-sky-700 border-sky-500/30 bg-sky-500/5",
  source_quality: "text-violet-700 border-violet-200 bg-purple-500/5",
  tool_availability: "text-green-700 border-green-200 bg-green-500/5",
  intent_clarity: "text-blue-700 border-blue-200 bg-blue-500/5",
  risk: "text-orange-700 border-orange-200 bg-orange-500/5",
};

function formatImpact(impact: { go: number; hold: number; abort: number }): string {
  const parts: string[] = [];
  if (impact.go !== 0) parts.push(`GO ${impact.go > 0 ? "+" : ""}${impact.go.toFixed(2)}`);
  if (impact.hold !== 0) parts.push(`HOLD ${impact.hold > 0 ? "+" : ""}${impact.hold.toFixed(2)}`);
  if (impact.abort !== 0) parts.push(`ABORT ${impact.abort > 0 ? "+" : ""}${impact.abort.toFixed(2)}`);
  return parts.join(" · ");
}

export function TriStateVector({ task_id }: { task_id: string }) {
  const { data: decision, isLoading } = useGetTriStateByTask(task_id, { query: { retry: false } });

  if (isLoading) {
    return (
      <div className="border border-border rounded-lg p-4 bg-primary/5">
        <div className="text-[10px] font-mono text-muted-foreground">Loading qubit decision vector…</div>
      </div>
    );
  }
  if (!decision) return null;

  const go = decision.go_score;
  const hold = decision.hold_score;
  const abort = decision.abort_score;
  const goPct = Math.round(go * 100);
  const holdPct = Math.round(hold * 100);
  const abortPct = Math.round(abort * 100);
  const confidence = decision.confidence_score ?? 0;

  let signals: EvidenceSignal[] = [];
  try {
    if (decision.evidence_signals) signals = JSON.parse(decision.evidence_signals);
  } catch {}

  const final_color =
    decision.final_state === "GO" ? "text-green-700 border-green-500/40 bg-green-500/10" :
    decision.final_state === "HOLD" ? "text-amber-700 border-amber-500/40 bg-amber-500/10" :
    "text-red-700 border-red-200 bg-red-500/10";

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      {/* Header */}
      <div className="bg-secondary border-b border-border px-4 py-2.5 flex items-center gap-3">
        <Atom className="w-4 h-4 text-primary animate-pulse" />
        <span className="text-[10px] font-mono font-bold text-primary tracking-wider">QUBIT-INSPIRED TRI-STATE DECISION</span>
        <span className="text-[10px] font-mono text-muted-foreground">vector → collapse</span>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[10px] font-mono text-muted-foreground">CONFIDENCE</span>
          <div className="w-16 h-1 bg-muted rounded-full overflow-hidden">
            <div className="h-full bg-primary" style={{ width: `${Math.round(confidence * 100)}%` }} />
          </div>
          <span className="text-[10px] font-mono text-primary w-7">{Math.round(confidence * 100)}%</span>
        </div>
      </div>

      <div className="p-4 space-y-4">
        {/* State vector bar — proportional 3-segment */}
        <div>
          <div className="text-[10px] font-mono text-muted-foreground tracking-wider mb-1.5">PRE-COLLAPSE AMPLITUDE VECTOR</div>
          <div className="flex h-7 rounded overflow-hidden border border-border bg-secondary">
            {goPct > 0 && (
              <div
                className="bg-green-500/40 border-r border-green-500/60 flex items-center justify-center transition-all"
                style={{ width: `${goPct}%` }}
              >
                {goPct >= 12 && <span className="text-[10px] font-mono font-bold text-green-800">GO {goPct}%</span>}
              </div>
            )}
            {holdPct > 0 && (
              <div
                className="bg-amber-500/40 border-r border-amber-500/60 flex items-center justify-center transition-all"
                style={{ width: `${holdPct}%` }}
              >
                {holdPct >= 12 && <span className="text-[10px] font-mono font-bold text-amber-800">HOLD {holdPct}%</span>}
              </div>
            )}
            {abortPct > 0 && (
              <div
                className="bg-red-500/40 flex items-center justify-center transition-all"
                style={{ width: `${abortPct}%` }}
              >
                {abortPct >= 12 && <span className="text-[10px] font-mono font-bold text-red-800">ABORT {abortPct}%</span>}
              </div>
            )}
          </div>
          {/* Per-state breakdown row for small slices */}
          <div className="grid grid-cols-3 gap-2 mt-2">
            <div className="text-[10px] font-mono text-green-700">GO {(go * 100).toFixed(1)}%</div>
            <div className="text-[10px] font-mono text-amber-700 text-center">HOLD {(hold * 100).toFixed(1)}%</div>
            <div className="text-[10px] font-mono text-red-700 text-right">ABORT {(abort * 100).toFixed(1)}%</div>
          </div>
        </div>

        {/* Collapsed result */}
        <div className={`flex items-center gap-3 p-2.5 rounded border ${final_color}`}>
          <Zap className="w-3.5 h-3.5" />
          <span className="text-[10px] font-mono tracking-wider">COLLAPSED →</span>
          <span className="text-sm font-mono font-bold">{decision.final_state}</span>
          <span className="text-[10px] font-mono opacity-80 ml-auto">{decision.collapse_reason}</span>
        </div>

        {/* Evidence signals */}
        {signals.length > 0 && (
          <div>
            <div className="text-[10px] font-mono text-muted-foreground tracking-wider mb-2">
              EVIDENCE SIGNALS ({signals.length}) — each shifted the amplitude vector
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {signals.map((sig, i) => {
                const colorClass = CATEGORY_COLORS[sig.category] || "text-muted-foreground border-border bg-secondary";
                return (
                  <div key={i} className={`p-2 rounded border text-[10px] font-mono ${colorClass}`}>
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span>{CATEGORY_ICONS[sig.category] || "•"}</span>
                      <span className="font-bold">{sig.name}</span>
                    </div>
                    <div className="opacity-70 text-[9px] leading-tight mb-0.5">{sig.description}</div>
                    <div className="text-[9px] opacity-60">Δ {formatImpact(sig.impact)}</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="text-[9px] font-mono text-muted-foreground/70 italic border-t border-border pt-2">
          Note: This is qubit-inspired control — not literal quantum computing. The vector is advisory until collapsed; only the collapsed state controls execution.
        </div>
      </div>
    </div>
  );
}
