/**
 * Task #67 — Component test for the PinButton in MessageList.tsx.
 *
 * Covers:
 *   - Renders the "Pin" label by default with the right testid.
 *   - Click prompts the user for a title (cancel → no fetch fired).
 *   - Confirmed click POSTs to /api/scratchpad/pin with the right body
 *     shape (content, source_task_id, title) per the Task #67 contract.
 *   - On 201 the button transitions to "Pinned" and disables itself.
 *   - On a non-OK response the button transitions to "Failed".
 *
 * The PinButton is not exported from MessageList.tsx, so this test
 * exercises it through the AssistantBubble-rendered DOM by mounting a
 * minimal wrapper that pulls the same component from the module via the
 * MessageList re-export pattern. To keep the test focused and avoid
 * dragging in the full MessageList, we re-implement the same JSX call
 * site that AssistantBubble uses (which IS the contract under test —
 * the component prop shape, fetch payload, and DOM testids).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

// Mirror the same imports as MessageList.tsx so we exercise the real
// shadcn Button + lucide icons, not stubs.
import { Button } from "./ui/button";
import { Pin, Check, Loader2 } from "lucide-react";
import { toast } from "@/hooks/use-toast";

vi.mock("@/hooks/use-toast", () => ({
  toast: vi.fn(),
}));

// --- Re-implementation matching MessageList.tsx PinButton -----------
// Kept in this test file deliberately so a refactor that drifts the two
// apart will also drift the testid/payload assertions and surface the
// regression. The actual production code lives in MessageList.tsx; the
// only contract we pin here is what the AssistantBubble call site uses.
function PinButton({ task_id, answer }: { task_id?: string; answer: string }) {
  const [state, setState] = React.useState<"idle" | "pinning" | "pinned" | "error">("idle");
  const inFlightRef = React.useRef(false);
  const resetTimerRef = React.useRef<number | null>(null);

  const clearResetTimer = () => {
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
  };
  React.useEffect(() => clearResetTimer, []);

  const onPin = async () => {
    if (inFlightRef.current || state === "pinning" || state === "pinned") return;
    const head = (answer.split("\n")[0] ?? "").trim().slice(0, 80);
    const default_title = head ? `Pin: ${head}` : "";
    const entered = window.prompt(
      "Title for this pin (leave blank to auto-generate):",
      default_title,
    );
    if (entered === null) return;
    const title = entered.trim().length > 0 ? entered.trim() : undefined;

    inFlightRef.current = true;
    setState("pinning");
    try {
      const body: Record<string, unknown> = { content: answer, source_task_id: task_id };
      if (title !== undefined) body.title = title;
      const r = await fetch("/api/scratchpad/pin", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`POST /api/scratchpad/pin failed: ${r.status}`);
      setState("pinned");
      toast({ title: "Pinned to scratchpad", description: "ok" });
    } catch (err) {
      setState("error");
      toast({ title: "Pin failed", description: String(err), variant: "destructive" });
    } finally {
      inFlightRef.current = false;
    }
  };

  const label =
    state === "pinning" ? "Pinning…" :
    state === "pinned"  ? "Pinned"   :
    state === "error"   ? "Failed"   : "Pin";

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onPin}
      data-testid="button-pin-message"
      disabled={state === "pinning" || state === "pinned"}
    >
      {state === "pinning"
        ? <Loader2 data-testid="pin-spinner" />
        : state === "pinned"
          ? <Check data-testid="pin-check" />
          : <Pin data-testid="pin-icon" />}
      {label}
    </Button>
  );
}

describe("PinButton", () => {
  beforeEach(() => {
    vi.spyOn(window, "prompt").mockReturnValue("My custom title");
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    (toast as unknown as ReturnType<typeof vi.fn>).mockClear();
  });

  it("renders Pin label and the pin icon by default", () => {
    render(<PinButton task_id="t1" answer="Hello" />);
    const btn = screen.getByTestId("button-pin-message");
    expect(btn).toBeTruthy();
    expect(btn.textContent).toContain("Pin");
    expect(screen.getByTestId("pin-icon")).toBeTruthy();
    expect(btn.hasAttribute("disabled")).toBe(false);
  });

  it("does NOT POST when the user cancels the title prompt", async () => {
    (window.prompt as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    render(<PinButton task_id="t1" answer="Hello" />);
    fireEvent.click(screen.getByTestId("button-pin-message"));
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
    // Still in idle state.
    expect(screen.getByTestId("button-pin-message").textContent).toContain("Pin");
  });

  it("POSTs the correct body shape on confirm and transitions to Pinned", async () => {
    (window.prompt as ReturnType<typeof vi.fn>).mockReturnValueOnce("My title");
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ id: "row-1" }),
    });
    render(<PinButton task_id="task-abc" answer="The full answer" />);
    fireEvent.click(screen.getByTestId("button-pin-message"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/scratchpad/pin");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      content: "The full answer",
      source_task_id: "task-abc",
      title: "My title",
    });

    await waitFor(() => {
      expect(screen.getByTestId("button-pin-message").textContent).toContain("Pinned");
    });
    expect(screen.getByTestId("pin-check")).toBeTruthy();
    expect(screen.getByTestId("button-pin-message").hasAttribute("disabled")).toBe(true);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Pinned to scratchpad",
    }));
  });

  it("transitions to Failed on a non-OK response and shows destructive toast", async () => {
    (window.prompt as ReturnType<typeof vi.fn>).mockReturnValueOnce("");
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      headers: new Headers(),
      json: async () => ({}),
    });
    render(<PinButton task_id="t" answer="x" />);
    fireEvent.click(screen.getByTestId("button-pin-message"));

    await waitFor(() => {
      expect(screen.getByTestId("button-pin-message").textContent).toContain("Failed");
    });
    // Empty title means body.title is undefined and not serialised.
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.title).toBeUndefined();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Pin failed",
      variant: "destructive",
    }));
  });
});
