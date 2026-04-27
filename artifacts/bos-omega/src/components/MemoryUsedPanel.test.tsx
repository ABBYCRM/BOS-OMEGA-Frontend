import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryUsedPanel } from "./MemoryUsedPanel";

// Synthetic MEMORY_INJECTED audit row matching the orchestrator-emitted
// metadata shape from artifacts/api-server/src/bos/pipeline.ts. Mirrors a
// real `single`-mode task (one of the five execution modes per task spec).
const memoryInjectedEntry = {
  id: "audit-1",
  event_type: "MEMORY_INJECTED",
  message: "Memory context built (123 chars)",
  metadata: {
    canon_items: 8,
    continuity_items: 1,
    patches_items: 0,
    scratchpad_items: 1,
    memory_context_chars: 11654,
    section_headers: [
      "=== CANON CONTEXT ===",
      "=== CONTINUITY ===",
      "=== SCRATCHPAD ===",
    ],
    memory_context_preview:
      "=== CANON CONTEXT ===\n[CANON:BOS-OMEGA SAFETY CANON] BOS-OMEGA SAFETY CANON",
  },
  created_at: "2026-04-27T01:00:00.000Z",
};

const noiseEntry = {
  id: "audit-0",
  event_type: "TASK_RECEIVED",
  message: "task received",
  metadata: null,
  created_at: "2026-04-27T00:59:59.000Z",
};

// Each test gets a fresh QueryClient so cached responses from one case
// can't leak into another. retry: false stops failure cases from spinning.
function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  // The lazy-fetch path goes through the global fetch via customFetch.
  // Default to a stub that fails loudly so any test that triggers it
  // without setting up its own mock will be obvious.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("unmocked fetch call"))),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MemoryUsedPanel", () => {
  it("renders nothing when audit has no MEMORY_INJECTED entry", () => {
    const { container } = renderWithClient(<MemoryUsedPanel audit={[noiseEntry]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the panel header with per-layer counts and is collapsed by default (single mode)", () => {
    renderWithClient(<MemoryUsedPanel audit={[noiseEntry, memoryInjectedEntry]} />);

    // Panel root is present.
    const panel = screen.getByTestId("memory-used-panel");
    expect(panel).toBeInTheDocument();

    // Header label.
    expect(screen.getByText("MEMORY USED")).toBeInTheDocument();

    // Per-layer counters in the header (the panel renders both layer
    // labels and the rendered section list, so we narrow to the header
    // toggle button to avoid matching the same labels in the body grid).
    const toggle = screen.getByTestId("memory-used-panel-toggle");
    expect(toggle.textContent).toMatch(/CANON:\s*8/);
    expect(toggle.textContent).toMatch(/CONTINUITY:\s*1/);
    expect(toggle.textContent).toMatch(/PATCHES:\s*0/);
    expect(toggle.textContent).toMatch(/SCRATCHPAD:\s*1/);
    expect(toggle.textContent).toMatch(/11654 chars/);

    // Collapsed by default — body and its children must not be in the DOM.
    expect(screen.queryByTestId("memory-used-panel-body")).toBeNull();
    expect(screen.queryByTestId("memory-section-headers")).toBeNull();
    expect(screen.queryByTestId("memory-context-preview")).toBeNull();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("expands on click and renders layer grid, section chips, and preview", () => {
    renderWithClient(<MemoryUsedPanel audit={[memoryInjectedEntry]} />);

    const toggle = screen.getByTestId("memory-used-panel-toggle");
    fireEvent.click(toggle);

    // Body now rendered.
    expect(screen.getByTestId("memory-used-panel-body")).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    // Layer tiles — one per layer.
    expect(screen.getByTestId("memory-layer-canon")).toHaveTextContent("8");
    expect(screen.getByTestId("memory-layer-continuity")).toHaveTextContent("1");
    expect(screen.getByTestId("memory-layer-patches")).toHaveTextContent("0");
    expect(screen.getByTestId("memory-layer-scratchpad")).toHaveTextContent("1");

    // Section header chips.
    const chips = screen.getByTestId("memory-section-headers");
    expect(chips).toHaveTextContent("=== CANON CONTEXT ===");
    expect(chips).toHaveTextContent("=== CONTINUITY ===");
    expect(chips).toHaveTextContent("=== SCRATCHPAD ===");
    expect(screen.getByText(/SECTIONS RENDERED \(3\)/)).toBeInTheDocument();

    // Preview <pre> exposes the persisted memory_context_preview verbatim.
    const preview = screen.getByTestId("memory-context-preview");
    expect(preview.tagName).toBe("PRE");
    expect(preview.textContent).toContain("=== CANON CONTEXT ===");
    expect(preview.textContent).toContain("BOS-OMEGA SAFETY CANON");
  });

  it("collapses again on second click", () => {
    renderWithClient(<MemoryUsedPanel audit={[memoryInjectedEntry]} />);

    const toggle = screen.getByTestId("memory-used-panel-toggle");
    fireEvent.click(toggle);
    expect(screen.getByTestId("memory-used-panel-body")).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByTestId("memory-used-panel-body")).toBeNull();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("falls back gracefully when metadata fields are missing", () => {
    const minimalEntry = {
      id: "audit-x",
      event_type: "MEMORY_INJECTED",
      message: "Memory context built (0 chars)",
      metadata: null,
      created_at: "2026-04-27T01:00:00.000Z",
    };
    renderWithClient(<MemoryUsedPanel audit={[minimalEntry]} />);
    const toggle = screen.getByTestId("memory-used-panel-toggle");
    // Defaults render as zero — no NaN/undefined leaks into the UI.
    expect(toggle.textContent).toMatch(/CANON:\s*0/);
    expect(toggle.textContent).toMatch(/0 chars/);
  });

  // === Task #49: "View full context" affordance ===

  it("does NOT show the 'View full context' affordance without a taskId", () => {
    renderWithClient(<MemoryUsedPanel audit={[memoryInjectedEntry]} />);
    fireEvent.click(screen.getByTestId("memory-used-panel-toggle"));
    expect(screen.queryByTestId("memory-context-view-full")).toBeNull();
  });

  it("does NOT show the affordance when the preview already covers the full text", () => {
    // chars equals preview.length → preview is NOT truncated, so the button
    // would be a no-op. Hide it.
    const fullCoverageEntry = {
      ...memoryInjectedEntry,
      metadata: {
        ...memoryInjectedEntry.metadata,
        memory_context_chars: memoryInjectedEntry.metadata.memory_context_preview.length,
      },
    };
    renderWithClient(<MemoryUsedPanel audit={[fullCoverageEntry]} taskId="task-1" />);
    fireEvent.click(screen.getByTestId("memory-used-panel-toggle"));
    expect(screen.queryByTestId("memory-context-view-full")).toBeNull();
    // The preview is still shown.
    expect(screen.getByTestId("memory-context-preview")).toBeInTheDocument();
  });

  it("shows the affordance and lazy-loads the full context on click", async () => {
    // Mock the new endpoint response.
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/tasks/task-1/memory-context")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                memory_context: "FULL CONTEXT BODY 0123456789".repeat(10),
                chars: 11654,
                truncated: false,
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
          );
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      }),
    );

    renderWithClient(<MemoryUsedPanel audit={[memoryInjectedEntry]} taskId="task-1" />);
    fireEvent.click(screen.getByTestId("memory-used-panel-toggle"));

    // Affordance is visible because chars (11654) > preview.length.
    const viewFull = screen.getByTestId("memory-context-view-full");
    expect(viewFull).toBeInTheDocument();
    // Header signals the truncation explicitly so users know what they're looking at.
    expect(screen.getByText(/truncated to .* of 11654 chars/)).toBeInTheDocument();
    // The lazy fetch must NOT have fired yet — the panel only loads on click.
    expect(screen.queryByTestId("memory-context-full")).toBeNull();
    expect(screen.queryByTestId("memory-context-full-loading")).toBeNull();

    fireEvent.click(viewFull);

    // Eventually the full body renders.
    await waitFor(() => {
      expect(screen.getByTestId("memory-context-full")).toBeInTheDocument();
    });
    expect(screen.getByTestId("memory-context-full").textContent).toContain(
      "FULL CONTEXT BODY",
    );
    // Preview is replaced (not duplicated).
    expect(screen.queryByTestId("memory-context-preview")).toBeNull();
    // User can flip back to preview without re-fetching.
    fireEvent.click(screen.getByTestId("memory-context-show-preview"));
    expect(screen.getByTestId("memory-context-preview")).toBeInTheDocument();
    expect(screen.queryByTestId("memory-context-full")).toBeNull();
  });

  it("surfaces a fallback error message when the full-context fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ error: "Task not found", code: "NOT_FOUND" }),
            { status: 404, headers: { "Content-Type": "application/json" } },
          ),
        ),
      ),
    );

    renderWithClient(<MemoryUsedPanel audit={[memoryInjectedEntry]} taskId="task-1" />);
    fireEvent.click(screen.getByTestId("memory-used-panel-toggle"));
    fireEvent.click(screen.getByTestId("memory-context-view-full"));

    await waitFor(() => {
      expect(screen.getByTestId("memory-context-full-error")).toBeInTheDocument();
    });
    // Error block keeps the preview visible so the user isn't left with an
    // empty pane after a failed fetch.
    expect(screen.getByTestId("memory-context-full-error").textContent).toContain(
      "=== CANON CONTEXT ===",
    );
  });
});
