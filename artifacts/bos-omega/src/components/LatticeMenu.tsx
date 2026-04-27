/**
 * Fidelity Lattice Continuity Protocol — Task #69 user-menu UI.
 *
 * A small "Lattice" pill in the Layout top bar that opens a popover
 * with two actions:
 *   - Export memory lattice → modal with the rendered blob in a
 *     readonly textarea + Copy / Download buttons.
 *   - Import memory lattice → modal with a paste textarea, a
 *     Verify-then-Confirm two-step flow, and a counts preview.
 *
 * The copy/download pattern is borrowed from MemoryUsedPanel.tsx
 * (navigator.clipboard with a textarea/execCommand fallback for
 * non-secure contexts; Blob → URL.createObjectURL → anchor click for
 * downloads). All network calls are inline fetch() — these endpoints
 * are not in the OpenAPI spec yet because their request bodies are
 * trivial and adding them would force a codegen step for every
 * downstream consumer.
 */

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Database,
  Download as DownloadIcon,
  Upload as UploadIcon,
  Copy as CopyIcon,
  Check as CheckIcon,
  Loader2,
  AlertCircle,
  X as CloseIcon,
} from "lucide-react";

type ExportResponse = {
  blob: string;
  hash: string;
  exported_at: string;
  format_version: string;
  task_count: number;
  byte_size: number;
  source_session_id: string;
};

type ImportCounts = {
  canon: number;
  continuity: number;
  patches: number;
  scratchpad: number;
  conversations: number;
  tasks: number;
};

type ImportResponse = {
  imported: ImportCounts;
  skipped: number;
  conversation_id: string;
  source_session_id: string;
  fidelity_sha256: string;
};

const EXPORTS_QUERY_KEY = ["/api/lattice/exports"] as const;

function copyToClipboard(text: string): Promise<boolean> {
  // Mirrors MemoryUsedPanel's resilient copy helper: try the modern
  // async API first, fall back to the legacy textarea/execCommand
  // path so http://localhost and other non-secure-context browsers
  // still work.
  return (async () => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return ok;
      } catch {
        return false;
      }
    }
  })();
}

function downloadText(name: string, text: string) {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function ModalShell({
  title,
  onClose,
  children,
  testid,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  testid: string;
}) {
  // Close on Escape; trap clicks on the overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
      data-testid={`${testid}-overlay`}
    >
      <div
        className="bg-card border border-card-border rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        data-testid={testid}
        role="dialog"
        aria-label={title}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h3 className="text-[14px] font-serif font-semibold text-foreground tracking-tight">
            {title}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground"
            aria-label="Close"
            data-testid={`${testid}-close`}
          >
            <CloseIcon className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

function ExportModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [data, setData] = useState<ExportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/lattice/export", {
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = (await r.json()) as ExportResponse;
        if (!cancelled) {
          setData(body);
          // The server wrote a `lattice_exports` row; refresh the
          // Settings card so the user sees the new entry without a
          // page reload.
          void queryClient.invalidateQueries({ queryKey: EXPORTS_QUERY_KEY });
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message || "Export failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [queryClient]);

  const onCopy = async () => {
    if (!data) return;
    const ok = await copyToClipboard(data.blob);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  };

  const onDownload = () => {
    if (!data) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    downloadText(`bos-omega-lattice-${stamp}.md`, data.blob);
  };

  return (
    <ModalShell title="Export memory lattice" onClose={onClose} testid="lattice-export-modal">
      {!data && !error && (
        <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground" data-testid="lattice-export-loading">
          <Loader2 className="w-4 h-4 animate-spin" />
          Building lattice…
        </div>
      )}
      {error && (
        <div className="text-[12.5px] text-amber-700 inline-flex items-center gap-2" data-testid="lattice-export-error">
          <AlertCircle className="w-4 h-4" />
          {error}
        </div>
      )}
      {data && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3 text-[11.5px] font-mono text-muted-foreground">
            <span data-testid="lattice-export-tasks">{data.task_count} tasks</span>
            <span>·</span>
            <span data-testid="lattice-export-bytes">{data.byte_size.toLocaleString()} bytes</span>
            <span>·</span>
            <span title={data.hash} data-testid="lattice-export-hash">
              sha256 {data.hash.slice(0, 12)}…
            </span>
            <span>·</span>
            <span data-testid="lattice-export-version">v{data.format_version}</span>
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={onCopy}
                className="px-3 py-1.5 border border-border rounded text-[12px] font-medium hover:bg-secondary inline-flex items-center gap-1.5"
                data-testid="lattice-export-copy"
              >
                {copied ? <CheckIcon className="w-3.5 h-3.5 text-green-700" /> : <CopyIcon className="w-3.5 h-3.5" />}
                {copied ? "Copied" : "Copy"}
              </button>
              <button
                type="button"
                onClick={onDownload}
                className="px-3 py-1.5 bg-primary text-primary-foreground rounded text-[12px] font-medium hover:bg-primary/90 inline-flex items-center gap-1.5"
                data-testid="lattice-export-download"
              >
                <DownloadIcon className="w-3.5 h-3.5" />
                Download
              </button>
            </div>
          </div>
          <textarea
            readOnly
            value={data.blob}
            className="w-full h-[55vh] bg-secondary border border-border rounded p-3 text-[11px] font-mono text-foreground"
            data-testid="lattice-export-textarea"
          />
        </div>
      )}
    </ModalShell>
  );
}

function ImportModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResponse | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    taRef.current?.focus();
  }, []);

  const onSubmit = async () => {
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const r = await fetch("/api/lattice/import", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ blob: text }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        const detail = (body && (body.error || body.code)) || `HTTP ${r.status}`;
        throw new Error(typeof detail === "string" ? detail : `HTTP ${r.status}`);
      }
      setResult(body as ImportResponse);
      // Refresh every cache key that the import touches. React Query's
      // invalidateQueries does PREFIX matching by default, so passing
      // ["conversations"] also invalidates the sidebar's
      // ["conversations","sidebar",<query>] entries — the routed
      // ["/api/conversations"] key is a separate namespace some other
      // panes use, so we invalidate both.
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/memory"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/scratchpad"] });
      // Also bump the recent-exports list for symmetry; an import can
      // legitimately follow an export in the same session.
      void queryClient.invalidateQueries({ queryKey: EXPORTS_QUERY_KEY });
    } catch (err) {
      setError((err as Error).message || "Import failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalShell title="Import memory lattice" onClose={onClose} testid="lattice-import-modal">
      {!result && (
        <div className="space-y-3">
          <p className="text-[12.5px] text-muted-foreground">
            Paste a previously-exported lattice blob below. The server
            verifies its sha256 fidelity hash before importing — a
            mismatched or modified blob is refused.
          </p>
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste the full blob here, including the header preamble and the closing ```MEMORY_LATTICE_V1 …``` fence."
            className="w-full h-[45vh] bg-background border border-input rounded p-3 text-[11px] font-mono text-foreground focus:ring-2 focus:ring-primary/10 focus:border-primary focus:outline-none"
            data-testid="lattice-import-textarea"
          />
          <div className="flex items-center justify-between gap-3">
            <div className="text-[11.5px] text-muted-foreground font-mono">
              {text.length.toLocaleString()} chars
            </div>
            {error && (
              <div className="text-[11.5px] text-amber-700 inline-flex items-center gap-1.5 flex-1 justify-end" data-testid="lattice-import-error">
                <AlertCircle className="w-3.5 h-3.5" />
                {error}
              </div>
            )}
            <button
              type="button"
              onClick={onSubmit}
              disabled={submitting || text.trim().length === 0}
              data-testid="lattice-import-submit"
              className="px-4 py-1.5 bg-primary text-primary-foreground rounded text-[12px] font-medium hover:bg-primary/90 transition-all inline-flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UploadIcon className="w-3.5 h-3.5" />}
              Verify & import
            </button>
          </div>
        </div>
      )}
      {result && (
        <div className="space-y-4" data-testid="lattice-import-result">
          <div className="text-[12.5px] text-emerald-700 inline-flex items-center gap-2">
            <CheckIcon className="w-4 h-4" />
            Continuity restored. Source session{" "}
            <span className="font-mono text-[11.5px] text-foreground">
              {result.source_session_id.slice(0, 8)}
            </span>{" "}
            verified by sha256.
          </div>
          <div className="grid grid-cols-3 gap-2">
            {(["canon", "continuity", "patches", "scratchpad", "conversations", "tasks"] as const).map((k) => (
              <div
                key={k}
                className="border border-border bg-secondary rounded p-3 text-center"
                data-testid={`lattice-import-count-${k}`}
              >
                <div className="text-lg font-mono font-bold text-foreground">
                  {result.imported[k]}
                </div>
                <div className="text-[10px] font-mono text-muted-foreground uppercase">
                  {k}
                </div>
              </div>
            ))}
          </div>
          {result.skipped > 0 && (
            <div className="text-[11.5px] text-amber-700 inline-flex items-center gap-1.5">
              <AlertCircle className="w-3.5 h-3.5" />
              {result.skipped} malformed row{result.skipped === 1 ? "" : "s"} were skipped.
            </div>
          )}
          <div className="text-[11.5px] font-mono text-muted-foreground">
            New conversation:{" "}
            <span className="text-foreground" data-testid="lattice-import-conv-id">
              {result.conversation_id}
            </span>
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-1.5 bg-primary text-primary-foreground rounded text-[12px] font-medium hover:bg-primary/90"
              data-testid="lattice-import-done"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </ModalShell>
  );
}

export function LatticeMenu() {
  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState<"export" | "import" | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  // Close the popover on outside click. The modals manage their own
  // close behavior independently.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="lattice-menu-button"
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-border text-[11.5px] font-medium text-foreground hover:bg-secondary transition-colors"
      >
        <Database className="w-3.5 h-3.5" />
        Lattice
      </button>
      {open && (
        <div
          className="absolute right-0 mt-1.5 w-56 bg-card border border-card-border rounded-lg shadow-card-hover z-40 py-1"
          role="menu"
          data-testid="lattice-menu-popover"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setModal("export");
            }}
            data-testid="lattice-menu-export"
            className="w-full text-left px-3 py-2 text-[12.5px] hover:bg-secondary inline-flex items-center gap-2"
          >
            <DownloadIcon className="w-3.5 h-3.5 text-muted-foreground" />
            Export memory lattice
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setModal("import");
            }}
            data-testid="lattice-menu-import"
            className="w-full text-left px-3 py-2 text-[12.5px] hover:bg-secondary inline-flex items-center gap-2"
          >
            <UploadIcon className="w-3.5 h-3.5 text-muted-foreground" />
            Import memory lattice
          </button>
        </div>
      )}
      {modal === "export" && <ExportModal onClose={() => setModal(null)} />}
      {modal === "import" && <ImportModal onClose={() => setModal(null)} />}
    </div>
  );
}
