import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Loader2, AlertCircle } from "lucide-react";
import { useUpdatePersona, type PersonaSlotView } from "@/lib/personas";

const TITLE_MAX = 120;
const CONTENT_MAX = 20000;

interface PersonaEditorProps {
  slot: PersonaSlotView | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PersonaEditor({ slot, open, onOpenChange }: PersonaEditorProps) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { update, is_pending } = useUpdatePersona();

  // Reset form whenever a new slot is opened so the user always sees the
  // current canonical row, not stale state from a previous edit session.
  useEffect(() => {
    if (open && slot) {
      setTitle(slot.title);
      setContent(slot.content);
      setError(null);
    }
  }, [open, slot]);

  if (!slot) return null;

  const trimmed_title = title.trim();
  const trimmed_content = content.trim();
  const can_save =
    !is_pending &&
    trimmed_title.length >= 1 &&
    trimmed_title.length <= TITLE_MAX &&
    trimmed_content.length >= 1 &&
    trimmed_content.length <= CONTENT_MAX &&
    (trimmed_title !== slot.title.trim() || trimmed_content !== slot.content.trim());

  async function handleSave() {
    if (!slot) return;
    setError(null);
    try {
      await update(slot.slot, { title: trimmed_title, content: trimmed_content });
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save persona");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit Persona Slot {slot.slot}</DialogTitle>
          <DialogDescription>
            The title labels the button. The content is added as one extra context pass on every model call,
            wrapped as <code className="text-[11px]">=== DOMAIN PERSONA: {trimmed_title.toUpperCase() || "TITLE"} ===</code>.
            It composes with the BOS Master Prompt Kernel — it does not replace it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="persona-title">Button label</Label>
            <Input
              id="persona-title"
              value={title}
              onChange={(e) => setTitle(e.target.value.slice(0, TITLE_MAX))}
              placeholder="e.g. Legal Counsel"
              data-testid={`input-persona-title-${slot.slot}`}
            />
            <div className="flex justify-between text-[11px] text-muted-foreground">
              <span>Shown on the persona button.</span>
              <span>{trimmed_title.length}/{TITLE_MAX}</span>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="persona-content">Persona instruction</Label>
            <Textarea
              id="persona-content"
              value={content}
              onChange={(e) => setContent(e.target.value.slice(0, CONTENT_MAX))}
              placeholder="Describe the persona's perspective, output format, and constraints…"
              rows={12}
              className="font-mono text-[12.5px] leading-relaxed"
              data-testid={`input-persona-content-${slot.slot}`}
            />
            <div className="flex justify-between text-[11px] text-muted-foreground">
              <span>Becomes the DOMAIN PERSONA overlay on every LLM call when this slot is active.</span>
              <span>{trimmed_content.length}/{CONTENT_MAX}</span>
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-2.5 text-[12px] text-red-800">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={is_pending}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={!can_save}
            data-testid={`button-save-persona-${slot.slot}`}
          >
            {is_pending ? (
              <>
                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                Saving…
              </>
            ) : (
              "Save persona"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
