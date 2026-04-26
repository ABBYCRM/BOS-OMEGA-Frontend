import { useCallback, useEffect, useRef, useState } from "react";
import { Paperclip, Image as ImageIcon, FileText, Music, Video, X } from "lucide-react";
import { uploadFile, type UploadedAttachment } from "@/lib/uploads";
import { AttachmentChip, type ChipState } from "./AttachmentChip";

export type ReadyAttachment = UploadedAttachment;

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (text: string, attachment_ids: string[]) => void;
  disabled?: boolean;
  placeholder?: string;
  submitLabel: React.ReactNode;
  submitClassName?: string;
  /** When the parent finishes (success or error), bump this to clear attachments. */
  resetSignal?: number;
}

interface SlotBase { id: string; name: string; }
interface UploadingSlot extends SlotBase { phase: "uploading"; progress: number; size: number; controller: AbortController; }
interface ReadySlot     extends SlotBase { phase: "ready"; attachment: UploadedAttachment; }
interface FailedSlot    extends SlotBase { phase: "failed"; error: string; }
type Slot = UploadingSlot | ReadySlot | FailedSlot;

let SLOT_SEQ = 0;
const newSlotId = () => `slot-${Date.now()}-${++SLOT_SEQ}`;

const ACCEPT_ALL =
  "image/*,video/*,audio/*,.pdf,.docx,.txt,.md,.csv,.tsv,.json,.yaml,.yml,.xml,.html,.htm,.css,.scss," +
  ".js,.jsx,.ts,.tsx,.mjs,.cjs,.py,.rb,.go,.rs,.java,.kt,.swift,.c,.cc,.cpp,.h,.hpp,.cs,.php,.lua," +
  ".sh,.sql,.r,.scala,.pl,.dart,.vue,.svelte,.toml,.ini,.env,.log";

export function Composer({
  value, onChange, onSubmit, disabled, placeholder, submitLabel, submitClassName, resetSignal,
}: Props) {
  const [slots, setSlots] = useState<Slot[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);

  // Auto-grow textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [value]);

  // Reset attachments when parent signals (e.g. after successful submit)
  useEffect(() => {
    if (resetSignal !== undefined) setSlots([]);
  }, [resetSignal]);

  // Close +menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-attach-menu]")) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  const startUpload = useCallback((file: File) => {
    const slot_id = newSlotId();
    const controller = new AbortController();
    setSlots((prev) => [
      ...prev,
      { phase: "uploading", id: slot_id, name: file.name, progress: 0, size: file.size, controller },
    ]);

    uploadFile(
      file,
      (p) => {
        setSlots((prev) =>
          prev.map((s) => (s.id === slot_id && s.phase === "uploading" ? { ...s, progress: p.percent } : s)),
        );
      },
      controller.signal,
    )
      .then((att) => {
        setSlots((prev) => prev.map((s) => (s.id === slot_id ? { phase: "ready", id: slot_id, name: att.original_name, attachment: att } : s)));
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") {
          // User cancelled — drop the slot entirely.
          setSlots((prev) => prev.filter((s) => s.id !== slot_id));
          return;
        }
        const message = err instanceof Error ? err.message : "Upload failed";
        setSlots((prev) => prev.map((s) => (s.id === slot_id ? { phase: "failed", id: slot_id, name: file.name, error: message } : s)));
      });
  }, []);

  const handleFiles = useCallback(
    (files: FileList | File[]) => {
      const arr = Array.from(files);
      arr.forEach(startUpload);
    },
    [startUpload],
  );

  const handleRemove = (slot: Slot) => {
    if (slot.phase === "uploading") slot.controller.abort();
    setSlots((prev) => prev.filter((s) => s.id !== slot.id));
  };

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const it of items) {
        if (it.kind === "file") {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        handleFiles(files);
      }
    },
    [handleFiles],
  );

  const onDragEnter = (e: React.DragEvent) => {
    if (e.dataTransfer?.types.includes("Files")) {
      e.preventDefault();
      setDragActive(true);
    }
  };
  const onDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (e.target === e.currentTarget) setDragActive(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
  };

  const ready_ids = slots.filter((s): s is ReadySlot => s.phase === "ready").map((s) => s.attachment.id);
  const has_uploading = slots.some((s) => s.phase === "uploading");

  const handleSubmit = () => {
    if (disabled || has_uploading) return;
    if (!value.trim() && ready_ids.length === 0) return;
    onSubmit(value, ready_ids);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const slotState = (s: Slot): ChipState => {
    if (s.phase === "uploading") return { phase: "uploading", name: s.name, progress: s.progress, size: s.size };
    if (s.phase === "failed")    return { phase: "failed", name: s.name, error: s.error };
    return { phase: "ready", attachment: s.attachment };
  };

  return (
    <div
      className={`relative bg-background border rounded-lg transition-all ${
        dragActive ? "border-primary ring-2 ring-primary/20" : "border-input focus-within:ring-2 focus-within:ring-primary/10 focus-within:border-primary"
      }`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragActive && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-primary/5 rounded-lg pointer-events-none">
          <div className="text-[13px] font-medium text-primary">Drop files to attach</div>
        </div>
      )}

      {slots.length > 0 && (
        <div className="flex flex-wrap gap-2 p-3 pb-0">
          {slots.map((s) => (
            <AttachmentChip key={s.id} state={slotState(s)} onRemove={() => handleRemove(s)} />
          ))}
        </div>
      )}

      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={handlePaste}
        placeholder={placeholder}
        disabled={disabled}
        rows={3}
        className="w-full bg-transparent border-0 resize-none p-4 pb-2 text-[13.5px] text-foreground placeholder:text-muted-foreground/70 focus:outline-none disabled:opacity-50 min-h-[88px] max-h-[320px]"
      />

      <div className="flex items-center justify-between p-2 pt-0">
        <div className="flex items-center gap-1 relative" data-attach-menu>
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            disabled={disabled}
            aria-label="Attach"
            className="p-2 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-50"
            title="Attach files (or drag/drop, paste)"
          >
            <Paperclip className="w-4 h-4" />
          </button>
          {menuOpen && (
            <div className="absolute bottom-full left-0 mb-1 bg-card border border-border rounded-md shadow-card py-1 min-w-[180px] z-20" data-attach-menu>
              <MenuItem icon={<FileText className="w-3.5 h-3.5" />} label="Files / documents"
                onClick={() => { setMenuOpen(false); fileInputRef.current?.click(); }} />
              <MenuItem icon={<ImageIcon className="w-3.5 h-3.5" />} label="Images"
                onClick={() => { setMenuOpen(false); imageInputRef.current?.click(); }} />
              <MenuItem icon={<Music className="w-3.5 h-3.5" />} label="Audio"
                onClick={() => { setMenuOpen(false); audioInputRef.current?.click(); }} />
              <MenuItem icon={<Video className="w-3.5 h-3.5" />} label="Video"
                onClick={() => { setMenuOpen(false); videoInputRef.current?.click(); }} />
            </div>
          )}
          <span className="text-[11px] text-muted-foreground ml-1 hidden sm:inline">
            Drag, paste, or attach. ⌘/Ctrl+Enter to send.
          </span>
        </div>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={disabled || has_uploading || (!value.trim() && ready_ids.length === 0)}
          className={submitClassName ?? "inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-[13px] font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-card bg-accent text-accent-foreground hover:bg-accent/90"}
        >
          {submitLabel}
        </button>
      </div>

      {/* hidden file inputs */}
      <input ref={fileInputRef} type="file" hidden multiple accept={ACCEPT_ALL}
        onChange={(e) => { if (e.target.files) handleFiles(e.target.files); e.target.value = ""; }} />
      <input ref={imageInputRef} type="file" hidden multiple accept="image/*"
        onChange={(e) => { if (e.target.files) handleFiles(e.target.files); e.target.value = ""; }} />
      <input ref={audioInputRef} type="file" hidden multiple accept="audio/*"
        onChange={(e) => { if (e.target.files) handleFiles(e.target.files); e.target.value = ""; }} />
      <input ref={videoInputRef} type="file" hidden multiple accept="video/*"
        onChange={(e) => { if (e.target.files) handleFiles(e.target.files); e.target.value = ""; }} />
    </div>
  );
}

function MenuItem({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-2 px-3 py-1.5 text-[12.5px] text-foreground hover:bg-muted text-left"
    >
      <span className="text-muted-foreground">{icon}</span>
      {label}
    </button>
  );
}

// Re-export so callers can use it as `Composer.Reset = X` if they want
export { X as ComposerCloseIcon };
