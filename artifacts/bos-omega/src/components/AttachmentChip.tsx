import { X, FileText, Image as ImageIcon, FileCode, FileSpreadsheet, Music, Video, File as FileIcon, AlertTriangle, Loader2, CheckCircle2, MinusCircle } from "lucide-react";
import { formatBytes, thumbnailUrl, type UploadedAttachment } from "@/lib/uploads";

export type ChipState =
  | { phase: "uploading"; progress: number; name: string; size: number; kind?: string }
  | { phase: "ready"; attachment: UploadedAttachment }
  | { phase: "failed"; name: string; error: string };

interface Props {
  state: ChipState;
  onRemove: () => void;
}

function kindIcon(kind: string) {
  switch (kind) {
    case "image":       return <ImageIcon className="w-4 h-4" />;
    case "document":    return <FileText className="w-4 h-4" />;
    case "spreadsheet": return <FileSpreadsheet className="w-4 h-4" />;
    case "code":        return <FileCode className="w-4 h-4" />;
    case "audio":       return <Music className="w-4 h-4" />;
    case "video":       return <Video className="w-4 h-4" />;
    case "text":        return <FileText className="w-4 h-4" />;
    default:            return <FileIcon className="w-4 h-4" />;
  }
}

function StatusPip({ status, error }: { status: string; error: string | null }) {
  if (status === "done") {
    return (
      <span className="inline-flex items-center gap-0.5 text-[10px] font-mono text-green-700" title="Content extracted">
        <CheckCircle2 className="w-3 h-3" /> ready
      </span>
    );
  }
  if (status === "skipped") {
    return (
      <span className="inline-flex items-center gap-0.5 text-[10px] font-mono text-muted-foreground" title={error ?? "Not text-extractable"}>
        <MinusCircle className="w-3 h-3" /> skipped
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="inline-flex items-center gap-0.5 text-[10px] font-mono text-red-700" title={error ?? "Extraction failed"}>
        <AlertTriangle className="w-3 h-3" /> failed
      </span>
    );
  }
  return null;
}

export function AttachmentChip({ state, onRemove }: Props) {
  if (state.phase === "uploading") {
    return (
      <div className="inline-flex items-center gap-2 bg-muted/50 border border-border rounded-md pl-2 pr-1 py-1 max-w-xs">
        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-[12px] truncate font-medium text-foreground">{state.name}</div>
          <div className="h-0.5 bg-muted rounded mt-1 overflow-hidden">
            <div className="h-full bg-primary transition-all" style={{ width: `${state.progress}%` }} />
          </div>
        </div>
        <button onClick={onRemove} className="p-1 rounded hover:bg-background text-muted-foreground" aria-label="Cancel upload">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  if (state.phase === "failed") {
    return (
      <div className="inline-flex items-center gap-2 bg-red-50 border border-red-200 rounded-md pl-2 pr-1 py-1 max-w-xs">
        <AlertTriangle className="w-4 h-4 text-red-700 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-[12px] truncate font-medium text-red-900">{state.name}</div>
          <div className="text-[10px] text-red-700 truncate" title={state.error}>{state.error}</div>
        </div>
        <button onClick={onRemove} className="p-1 rounded hover:bg-red-100 text-red-700" aria-label="Remove">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  const a = state.attachment;
  return (
    <div className="inline-flex items-center gap-2 bg-card border border-border rounded-md pl-1.5 pr-1 py-1 max-w-xs shadow-card">
      {a.kind === "image" && a.has_thumbnail ? (
        <img
          src={thumbnailUrl(a.id)}
          alt=""
          className="w-9 h-9 object-cover rounded"
          loading="lazy"
        />
      ) : (
        <div className="w-9 h-9 rounded bg-muted/60 flex items-center justify-center text-muted-foreground shrink-0">
          {kindIcon(a.kind)}
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="text-[12px] font-medium text-foreground truncate" title={a.original_name}>
          {a.original_name}
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className="uppercase tracking-wider">{a.kind}</span>
          <span>·</span>
          <span>{formatBytes(a.size_bytes)}</span>
          {a.duration_ms && (
            <>
              <span>·</span>
              <span>{Math.round(a.duration_ms / 1000)}s</span>
            </>
          )}
          {(a.kind === "image" || a.kind === "video") && a.width && a.height && (
            <>
              <span>·</span>
              <span>{a.width}×{a.height}</span>
            </>
          )}
        </div>
        <div className="mt-0.5"><StatusPip status={a.extraction_status} error={a.extraction_error} /></div>
      </div>
      <button onClick={onRemove} className="p-1 rounded hover:bg-muted text-muted-foreground" aria-label="Remove">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
