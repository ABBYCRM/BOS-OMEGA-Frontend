/**
 * Task #67 — Component test for the production PinButton exported from
 * MessageList.tsx. Tests the REAL component (not a re-implementation),
 * so any drift in the production POST payload, prompt flow, or button
 * states is caught here.
 *
 * Covers:
 *   - Renders the "Pin" label by default with the right testid.
 *   - Click prompts the user for a title (cancel → no fetch fired).
 *   - Confirmed click POSTs to /api/scratchpad/pin with the right body
 *     shape ({content, source_task_id, title?}) per the Task #67
 *     contract.
 *   - On 201 the button transitions to "Pinned" and disables itself,
 *     and the success toast fires.
 *   - On a non-OK response the button transitions to "Failed" and the
 *     destructive toast fires; an empty title is omitted from the body.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/hooks/use-toast", () => ({
  toast: vi.fn(),
}));

import { PinButton } from "./MessageList";
import { toast } from "@/hooks/use-toast";

describe("PinButton (production component from MessageList.tsx)", () => {
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

  it("renders Pin label by default and is enabled", () => {
    render(<PinButton task_id="t1" answer="Hello" />);
    const btn = screen.getByTestId("button-pin-message");
    expect(btn).toBeTruthy();
    expect(btn.textContent).toContain("Pin");
    expect(btn.hasAttribute("disabled")).toBe(false);
  });

  it("does NOT POST when the user cancels the title prompt", async () => {
    (window.prompt as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    render(<PinButton task_id="t1" answer="Hello" />);
    fireEvent.click(screen.getByTestId("button-pin-message"));
    // Allow any synchronous handler chain to settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
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
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      content: "The full answer",
      source_task_id: "task-abc",
      title: "My title",
    });

    await waitFor(() => {
      expect(screen.getByTestId("button-pin-message").textContent).toContain("Pinned");
    });
    expect(screen.getByTestId("button-pin-message").hasAttribute("disabled")).toBe(true);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: expect.stringMatching(/Pinned/i),
    }));
  });

  it("transitions to Failed on non-OK response and shows destructive toast (empty title omitted)", async () => {
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
      expect(screen.getByTestId("button-pin-message").textContent).toMatch(/Fail/i);
    });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.title).toBeUndefined();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      variant: "destructive",
    }));
  });
});
