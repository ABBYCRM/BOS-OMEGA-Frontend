/**
 * Task #64 — Continuity bundle controls.
 *
 *   <CopyContinuityBundle taskId={...} conversationId={...} label="..." />
 *   <RehydrateBundleModal onClose={...} onImported={...} />
 *
 * Copy:
 *   GET /api/continuity-bundle?task_id=<id> (or ?conversation_id=<id>),
 *   write the returned `blob` text to the clipboard, and surface a
 *   one-line confirmation under the button (size + item counts) so the
 *   user can verify "yes, that copied" without needing to open dev
 *   tools. Falls back to a downloadable .txt file when the Clipboard
 *   API isn't available (e.g. user denied permission, insecure context).
 *
 * Rehydrate:
 *   Two-step Verify → Confirm flow:
 *     Step 1 — paste bundle, click Verify → POST /preview, render the
 *              parsed payload's counts, hash status, conflicts.
 *     Step 2 — Confirm → POST /import, then navigate the user into the
 *              freshly created "Imported …" conversation so they
 *              immediately see the rehydrated thread.
 *   The Confirm button is disabled when the hash mismatches AND
 *   "import anyway" is unchecked, so the production path requires
 *   integrity by default but doesn't strand a user staring at a hash
 *   error if they intentionally edited the bundle (e.g. truncated it
 *   to fit a small paste).
 */
import { useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  Copy, Check, Loader2, AlertTriangle, ShieldCheck, ShieldAlert,
  ClipboardPaste, X, Download,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface BundleStats {
  scratchpad_count: number;
  continuity_count: number;
  turns_count: number;
  bytes: number;
  approx_tokens: number;
}

interface BundleResponse {
  blob: string;
  hash: string;
  byte_size: number;
  format_version: string;
  stats: BundleStats;
  scope: "task" | "conversation";
  task_id: string | null;
  conversation_id: string | null;
  conversation_title: string | null;
  canon_hash: string;
}

interface BundlePreview {
  scope: "task" | "conversation";
  hash_ok: boolean;
  recomputed_hash: string;
  declared_hash: string;
  canon_hash: string;
  canon_match: boolean | null;
  persona_slot: { slot: "A"|"B"|"C"; title: string; content: string } | null;
  budgets: { canon: number; continuity: number; patches: number; scratchpad: number };
  counts: { scratchpad: number; continuity: number; turns: number };
  conflicts: { scratchpad_overwrites: string[]; continuity_overwrites: string[] };
  byte_size: number;
}

interface ImportResponse {
  imported: { scratchpad: number; continuity: number; turns: number };
  conversation_id: string;
  new_task_ids: string[];
  verified: boolean;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}

async function fetchBundle(opts: { taskId?: string | null; conversationId?: string | null }): Promise<BundleResponse> {
  const params = new URLSearchParams();
  // Scope rule (matches the user's mental model): a conversation
  // contains its tasks, so when the call site has both ids the user
  // expects the *whole conversation* to be exported. Sending both
  // params would let the server pick task_id (alphabetical priority),
  // which silently downgrades the export to a single turn — exactly
  // the bug the architect flagged on TaskConsole's Copy button.
  if (opts.conversationId) {
    params.set("conversation_id", opts.conversationId);
  } else if (opts.taskId) {
    params.set("task_id", opts.taskId);
  }
  const r = await fetch(`/api/continuity-bundle?${params.toString()}`, { credentials: "include" });
  if (!r.ok) {
    const detail = await r.json().catch(() => ({}));
    throw new Error(detail?.error ?? `Bundle export failed (${r.status})`);
  }
  return (await r.json()) as BundleResponse;
}

async function previewBundle(bundle: string): Promise<BundlePreview> {
  const r = await fetch(`/api/continuity-bundle/preview`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bundle }),
  });
  const detail = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(detail?.error ?? `Preview failed (${r.status})`);
  return detail as BundlePreview;
}

async function importBundle(bundle: string, require_hash_ok: boolean): Promise<ImportResponse> {
  const r = await fetch(`/api/continuity-bundle/import`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bundle, mode: "merge", require_hash_ok }),
  });
  const detail = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(detail?.error ?? `Import failed (${r.status})`);
  return detail as ImportResponse;
}

async function copyToClipboardOrDownload(text: string, suggestedName: string): Promise<"clipboard" | "download"> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return "clipboard";
    } catch {
      // fall through to download
    }
  }
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return "download";
}

// ---------- Copy button ----------

export interface CopyContinuityBundleProps {
  taskId?: string | null;
  conversationId?: string | null;
  label?: string;
  compact?: boolean;
}

export function CopyContinuityBundle({ taskId, conversationId, label, compact = false }: CopyContinuityBundleProps) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ kind: "clipboard" | "download"; bytes: number; stats: BundleStats } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onClick = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const data = await fetchBundle({ taskId, conversationId });
      const name = `bos-omega-continuity-${data.scope}-${(taskId ?? conversationId ?? "thread").slice(0, 8)}.txt`;
      const kind = await copyToClipboardOrDownload(data.blob, name);
      setResult({ kind, bytes: data.byte_size, stats: data.stats });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Copy failed");
    } finally {
      setBusy(false);
    }
  };

  const disabled = !taskId && !conversationId;

  return (
    <div className={compact ? "inline-block" : "space-y-1"}>
      <button
        type="button"
        onClick={onClick}
        disabled={busy || disabled}
        className={cn(
          "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-[12px] font-medium transition-colors",
          "border-border text-foreground hover:bg-secondary disabled:opacity-50 disabled:cursor-not-allowed",
        )}
        title={disabled ? "Select a task or conversation first" : "Copy a cross-AI continuity bundle to clipboard"}
        data-testid="button-copy-continuity-bundle"
      >
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
          : result?.kind === "download" ? <Download className="w-3.5 h-3.5" />
          : result ? <Check className="w-3.5 h-3.5 text-emerald-700" />
          : <Copy className="w-3.5 h-3.5" />}
        {label ?? "Copy continuity bundle"}
      </button>
      {!compact && result && (
        <div className="text-[11px] font-mono text-muted-foreground" data-testid="continuity-copy-toast">
          {result.kind === "clipboard"
            ? "Copied to clipboard. "
            : "Downloaded as file (clipboard unavailable). "}
          {formatBytes(result.bytes)} · {result.stats.scratchpad_count} pin/auto · {result.stats.continuity_count} continuity · {result.stats.turns_count} turn{result.stats.turns_count === 1 ? "" : "s"}
        </div>
      )}
      {!compact && error && (
        <div className="text-[11px] font-mono text-red-700">{error}</div>
      )}
    </div>
  );
}

// ---------- Rehydrate modal ----------

export interface RehydrateBundleModalProps {
  open: boolean;
  onClose: () => void;
  /** Called after successful import. Receives the new conversation id so
   *  the caller can navigate the user there (TaskConsole) or just close
   *  the modal (LocalMemory page). */
  onImported?: (conversation_id: string) => void;
  /** When true, navigate to /console?conversation=<id> on success. */
  navigateOnImport?: boolean;
}

export function RehydrateBundleModal({
  open, onClose, onImported, navigateOnImport = true,
}: RehydrateBundleModalProps) {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<BundlePreview | null>(null);
  const [overrideHash, setOverrideHash] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<ImportResponse | null>(null);
  const [, navigate] = useLocation();
  const qc = useQueryClient();

  if (!open) return null;

  const reset = () => {
    setText(""); setPreview(null); setOverrideHash(false);
    setBusy(false); setError(null); setSuccess(null);
  };
  const close = () => { reset(); onClose(); };

  const onVerify = async () => {
    setBusy(true); setError(null); setPreview(null); setSuccess(null);
    try {
      const p = await previewBundle(text);
      setPreview(p);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verify failed");
    } finally {
      setBusy(false);
    }
  };

  const onConfirm = async () => {
    setBusy(true); setError(null);
    try {
      const result = await importBundle(text, !overrideHash);
      setSuccess(result);
      onImported?.(result.conversation_id);
      // Bust caches so the new conversation appears in the sidebar +
      // any scratchpad / memory list that was open.
      void qc.invalidateQueries({ queryKey: ["conversations", "sidebar"] });
      void qc.invalidateQueries({ queryKey: ["scratchpad-panel"] });
      // Local memory page lives outside this query graph; no-op there.
      if (navigateOnImport) {
        // Brief delay so the user sees the success screen before nav.
        setTimeout(() => {
          navigate(`/console?conversation=${result.conversation_id}`);
          close();
        }, 800);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  };

  const canConfirm = preview && (preview.hash_ok || overrideHash) && !success;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="bg-card border border-card-border rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <ClipboardPaste className="w-4 h-4 text-blue-600" />
            <h2 className="text-[14px] font-serif font-semibold text-foreground">Rehydrate from continuity bundle</h2>
          </div>
          <button
            type="button"
            onClick={close}
            className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-secondary"
            data-testid="button-rehydrate-close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <p className="text-[12.5px] text-muted-foreground">
            Paste a <code className="px-1 py-0.5 bg-muted rounded text-[11px] font-mono">bos-omega.continuity-bundle.v1</code> block
            from any AI conversation (or another BOS-OMEGA session). We verify the fidelity hash, show you what would
            be imported, and then create a new conversation seeded with the prior turns plus the rehydrated scratchpad
            and continuity rows.
          </p>

          <textarea
            value={text}
            onChange={(e) => { setText(e.target.value); setPreview(null); setSuccess(null); setError(null); }}
            placeholder="Paste the bundle here…"
            rows={10}
            className="w-full text-[12px] px-3 py-2 rounded border border-border bg-background font-mono"
            data-testid="textarea-rehydrate-bundle"
          />

          {error && (
            <div className="text-[12px] font-mono text-red-700 border border-red-200 bg-red-50 rounded p-2 flex items-start gap-2">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {!preview && !success && (
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={close}
                className="text-[12px] px-3 py-1.5 rounded border border-border text-muted-foreground hover:text-foreground"
              >Cancel</button>
              <button
                type="button"
                onClick={onVerify}
                disabled={busy || text.trim().length === 0}
                className="inline-flex items-center gap-1.5 text-[12px] px-3 py-1.5 rounded bg-foreground text-background disabled:opacity-50"
                data-testid="button-rehydrate-verify"
              >
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
                Verify
              </button>
            </div>
          )}

          {preview && !success && (
            <div className="border border-border rounded-md p-3 space-y-2 bg-secondary/40">
              <div className="flex items-center gap-2 text-[12.5px]">
                {preview.hash_ok
                  ? <span className="inline-flex items-center gap-1 text-emerald-700"><ShieldCheck className="w-3.5 h-3.5" /> Fidelity hash verified</span>
                  : <span className="inline-flex items-center gap-1 text-red-700"><ShieldAlert className="w-3.5 h-3.5" /> Hash mismatch — bundle was edited or truncated</span>}
              </div>
              <div className="grid grid-cols-3 gap-2 text-[11.5px] font-mono">
                <div className="bg-card border border-border rounded p-2">
                  <div className="text-muted-foreground">Scope</div>
                  <div className="text-foreground">{preview.scope}</div>
                </div>
                <div className="bg-card border border-border rounded p-2">
                  <div className="text-muted-foreground">Bundle size</div>
                  <div className="text-foreground">{formatBytes(preview.byte_size)}</div>
                </div>
                <div className="bg-card border border-border rounded p-2">
                  <div className="text-muted-foreground">Canon hash</div>
                  <div className={preview.canon_match === false ? "text-amber-700" : "text-foreground"}>
                    {preview.canon_hash.slice(0, 8)}…
                    {preview.canon_match === true && " ✓ matches local"}
                    {preview.canon_match === false && " ⚠ differs from local"}
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2 text-[11.5px] font-mono">
                <div className="bg-card border border-border rounded p-2">
                  <div className="text-muted-foreground">Scratchpad</div>
                  <div className="text-foreground">
                    {preview.counts.scratchpad} item{preview.counts.scratchpad === 1 ? "" : "s"}
                    {preview.conflicts.scratchpad_overwrites.length > 0 && (
                      <span className="text-amber-700"> · {preview.conflicts.scratchpad_overwrites.length} would overwrite</span>
                    )}
                  </div>
                </div>
                <div className="bg-card border border-border rounded p-2">
                  <div className="text-muted-foreground">Continuity</div>
                  <div className="text-foreground">
                    {preview.counts.continuity} item{preview.counts.continuity === 1 ? "" : "s"}
                    {preview.conflicts.continuity_overwrites.length > 0 && (
                      <span className="text-amber-700"> · {preview.conflicts.continuity_overwrites.length} would overwrite</span>
                    )}
                  </div>
                </div>
                <div className="bg-card border border-border rounded p-2">
                  <div className="text-muted-foreground">Turns</div>
                  <div className="text-foreground">{preview.counts.turns}</div>
                </div>
              </div>
              {preview.persona_slot && (
                <div className="text-[11.5px] font-mono text-muted-foreground">
                  Persona overlay: <span className="text-foreground">slot {preview.persona_slot.slot} — {preview.persona_slot.title}</span>
                </div>
              )}

              {!preview.hash_ok && (
                <label className="flex items-center gap-2 text-[12px] text-amber-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={overrideHash}
                    onChange={(e) => setOverrideHash(e.target.checked)}
                    data-testid="checkbox-override-hash"
                  />
                  Import anyway (the hash failed; the bundle was edited or truncated).
                </label>
              )}

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => { setPreview(null); setOverrideHash(false); }}
                  className="text-[12px] px-3 py-1.5 rounded border border-border text-muted-foreground hover:text-foreground"
                >Back</button>
                <button
                  type="button"
                  onClick={onConfirm}
                  disabled={busy || !canConfirm}
                  className="inline-flex items-center gap-1.5 text-[12px] px-3 py-1.5 rounded bg-foreground text-background disabled:opacity-50"
                  data-testid="button-rehydrate-confirm"
                >
                  {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                  Confirm import
                </button>
              </div>
            </div>
          )}

          {success && (
            <div className="border border-emerald-300 bg-emerald-50 rounded-md p-3 text-[12.5px] text-emerald-900" data-testid="rehydrate-success">
              <div className="flex items-center gap-2 mb-1 font-semibold">
                <Check className="w-4 h-4" /> Import complete.
              </div>
              <div className="font-mono text-[11.5px]">
                {success.imported.scratchpad} scratchpad · {success.imported.continuity} continuity · {success.imported.turns} turn{success.imported.turns === 1 ? "" : "s"}
                {" · "}new conversation: <code>{success.conversation_id.slice(0, 8)}…</code>
                {!success.verified && <span className="text-amber-800"> · imported despite hash mismatch</span>}
              </div>
              {!navigateOnImport && (
                <button
                  type="button"
                  onClick={close}
                  className="mt-2 text-[12px] px-3 py-1.5 rounded border border-border text-foreground hover:bg-card"
                >Close</button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
