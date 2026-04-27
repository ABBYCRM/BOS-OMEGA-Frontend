import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, RotateCcw, X } from "lucide-react";
import { toast } from "@/hooks/use-toast";

export interface LightboxImage {
  /** attachment id served by /api/uploads/{id}/raw */
  id: string;
  /** Human-readable alt text shown to screen readers */
  alt: string;
  /** Original (server-side) filename, used as filename fallback */
  original_name: string;
  /** Optional caption shown below the image (e.g. "EDITED · BEFORE") */
  caption?: string;
  /**
   * The user prompt that produced this image. Used to derive a
   * sensible download filename and to power the "Regenerate" button.
   * Optional because rehydrated/orphan rows may not carry it.
   */
  prompt?: string;
}

interface ImageLightboxProps {
  /** Ordered list of images to navigate between (left/right arrows). */
  images: LightboxImage[];
  /** Index of the currently displayed image. Null = closed. */
  index: number | null;
  /** Switch to a different index (used by keyboard nav). */
  onIndexChange: (next: number) => void;
  /** Close the lightbox. */
  onClose: () => void;
}

/**
 * Sanitize a prompt into something safe to use as a filename:
 *   - collapse whitespace
 *   - drop characters that misbehave on Windows / macOS / Linux
 *   - cap length so we don't produce 4 KB filenames
 *
 * Returns "" when the prompt yields nothing usable so the caller can
 * fall back to original_name or a generic stem.
 */
function sanitizeForFilename(prompt: string): string {
  return prompt
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);
}

function deriveFilename(img: LightboxImage): string {
  // Always emit .png — the provider bridge persists generated images
  // as PNG and the UI is the only place we control the filename. The
  // original_name fallback may include a different extension; we keep
  // its stem but force the extension below.
  const stem_from_prompt = img.prompt ? sanitizeForFilename(img.prompt) : "";
  const stem_from_original = img.original_name
    ? sanitizeForFilename(img.original_name.replace(/\.[^.]+$/, ""))
    : "";
  const stem = stem_from_prompt || stem_from_original || "bos-omega-image";
  return `bos-omega-${stem}.png`;
}

/**
 * Stream the raw bytes through a same-origin fetch so the browser
 * picks up our session cookie (the /api/uploads/:id/raw route is
 * owner / super_admin gated). Anchor-with-download attribute alone
 * cannot rename a cross-route resource reliably, so we materialize
 * a blob URL and click it.
 */
async function downloadImage(img: LightboxImage): Promise<void> {
  try {
    const r = await fetch(`/api/uploads/${encodeURIComponent(img.id)}/raw`, {
      credentials: "include",
    });
    if (!r.ok) throw new Error(`Download failed: ${r.status}`);
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = deriveFilename(img);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Defer revoke so Safari/Firefox have a chance to start the
    // download before the URL is invalidated.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    toast({
      title: "Download failed",
      description: err instanceof Error ? err.message : "Could not download image.",
      variant: "destructive",
    });
  }
}

export function ImageLightbox({ images, index, onIndexChange, onClose }: ImageLightboxProps) {
  const open = index !== null && index >= 0 && index < images.length;
  const current = open ? images[index!] : null;
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  // Track which element invoked the lightbox so we can restore focus
  // to it on close — without this a keyboard user lands on <body>
  // after Esc, which loses their place in the message list.
  const invokerRef = useRef<HTMLElement | null>(null);

  const goPrev = useCallback(() => {
    if (index === null || images.length <= 1) return;
    onIndexChange((index - 1 + images.length) % images.length);
  }, [index, images.length, onIndexChange]);

  const goNext = useCallback(() => {
    if (index === null || images.length <= 1) return;
    onIndexChange((index + 1) % images.length);
  }, [index, images.length, onIndexChange]);

  // Single keyboard handler bound while the lightbox is open. We use
  // window-level keydown because focus may live on the image itself
  // (via the close button getting blurred); document-level capture
  // also keeps Esc working when an outer modal would otherwise eat it.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        goPrev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goNext();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, goPrev, goNext, onClose]);

  // Lock body scroll while the modal is up so the page underneath
  // doesn't scroll behind the backdrop.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Park initial focus on the close button when the modal opens so a
  // keyboard user can immediately Tab through the action row or
  // press Esc to dismiss. We also remember the previously focused
  // element (typically the inline Zoom button or the image-button
  // itself) so we can restore focus to it when the modal closes —
  // otherwise focus drops to <body> and the user loses their place
  // in the message thread.
  useEffect(() => {
    if (!open) return undefined;
    const active = document.activeElement;
    invokerRef.current = active instanceof HTMLElement ? active : null;
    // Defer one frame so the ref is attached before we focus.
    const id = window.requestAnimationFrame(() => {
      closeBtnRef.current?.focus();
    });
    return () => {
      window.cancelAnimationFrame(id);
      // Restore focus on close (either Esc or backdrop). Wrapped in
      // a try/catch because the invoker may have been unmounted by a
      // re-render mid-flight.
      try {
        invokerRef.current?.focus();
      } catch {
        /* invoker gone — let focus default to <body> */
      }
    };
  }, [open]);

  if (!open || !current) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Zoomed view of ${current.alt}`}
      data-testid="image-lightbox"
      className="fixed inset-0 z-[100] flex flex-col bg-black/90 backdrop-blur-sm"
      // Backdrop click closes — but we filter on the actual target so
      // clicks on the image / action buttons don't trigger it.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Top action bar */}
      <div className="flex items-center justify-between gap-2 px-4 py-3 text-white">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-xs font-mono text-white/70 truncate">
            {current.caption ? `${current.caption} · ` : ""}
            {current.original_name}
          </span>
          {images.length > 1 && (
            <span className="text-[11px] font-mono text-white/50 shrink-0">
              {index! + 1} / {images.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => downloadImage(current)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-white/30 text-[12px] text-white hover:bg-white/10 transition-colors"
            data-testid="button-lightbox-download"
            title="Download image"
          >
            <Download className="w-3.5 h-3.5" />
            Download
          </button>
          {current.prompt && (
            <button
              type="button"
              onClick={() => {
                window.dispatchEvent(
                  new CustomEvent("bos:regenerate-image", {
                    detail: { prompt: current.prompt },
                  }),
                );
                onClose();
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-white/30 text-[12px] text-white hover:bg-white/10 transition-colors"
              data-testid="button-lightbox-regenerate"
              title="Re-submit the original prompt as a fresh task"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Regenerate
            </button>
          )}
          <button
            ref={closeBtnRef}
            type="button"
            onClick={onClose}
            className="inline-flex items-center justify-center w-8 h-8 rounded-md border border-white/30 text-white hover:bg-white/10 transition-colors"
            aria-label="Close zoomed view"
            data-testid="button-lightbox-close"
            title="Close (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Image stage. Click on padding closes; click on image does not. */}
      <div
        className="flex-1 flex items-center justify-center px-2 sm:px-12 pb-4 min-h-0"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        {images.length > 1 && (
          <button
            type="button"
            onClick={goPrev}
            className="hidden sm:inline-flex items-center justify-center w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white border border-white/20 mr-2 shrink-0"
            aria-label="Previous image"
            data-testid="button-lightbox-prev"
            title="Previous (←)"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
        )}
        <img
          key={current.id}
          src={`/api/uploads/${encodeURIComponent(current.id)}/raw`}
          alt={current.alt}
          className="max-w-full max-h-full object-contain shadow-2xl"
        />
        {images.length > 1 && (
          <button
            type="button"
            onClick={goNext}
            className="hidden sm:inline-flex items-center justify-center w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white border border-white/20 ml-2 shrink-0"
            aria-label="Next image"
            data-testid="button-lightbox-next"
            title="Next (→)"
          >
            <ChevronRight className="w-5 h-5" />
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Helper exposed so non-lightbox download buttons (e.g. inline next to
 * the figcaption) share the exact same filename derivation + auth path
 * as the lightbox's own download action.
 */
export async function downloadLightboxImage(img: LightboxImage): Promise<void> {
  return downloadImage(img);
}
