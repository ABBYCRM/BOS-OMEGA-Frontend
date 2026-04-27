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

  // === Task #50: per-item provenance — clickable memory items ===

  it("renders one entry per injected item with a deep-link to the Memory Manager", async () => {
    // Stub /api/memory so the cross-reference query resolves; one of the
    // injected ids is intentionally missing so the panel must mark it as
    // "no longer available" instead of producing a broken link.
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/api/memory") || url.includes("/api/memory?")) {
          return Promise.resolve(
            new Response(
              JSON.stringify([
                {
                  id: "mem-canon-1",
                  layer: "canon",
                  title: "BOS Safety Canon",
                  content: "...",
                  authority_level: 9,
                  created_at: "2026-01-01T00:00:00.000Z",
                  updated_at: "2026-01-01T00:00:00.000Z",
                },
                {
                  id: "mem-cont-1",
                  layer: "continuity",
                  title: "Field log",
                  content: "...",
                  authority_level: 5,
                  created_at: "2026-01-01T00:00:00.000Z",
                  updated_at: "2026-01-01T00:00:00.000Z",
                },
                // mem-scratch-deleted intentionally absent
              ]),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
          );
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      }),
    );

    const entry = {
      ...memoryInjectedEntry,
      metadata: {
        ...memoryInjectedEntry.metadata,
        injected_items: [
          { id: "mem-canon-1", layer: "canon", title: "BOS Safety Canon" },
          { id: "mem-cont-1", layer: "continuity", title: "Field log" },
          { id: "mem-scratch-deleted", layer: "scratchpad", title: "Old note" },
        ],
      },
    };

    renderWithClient(<MemoryUsedPanel audit={[entry]} />);
    fireEvent.click(screen.getByTestId("memory-used-panel-toggle"));

    // The list itself renders synchronously off the audit metadata.
    expect(screen.getByTestId("memory-injected-items")).toBeInTheDocument();
    expect(screen.getByText(/ITEMS INJECTED \(3\)/)).toBeInTheDocument();

    // Two ids exist in the live list → links rendered with /memory#item-<id> hrefs.
    const canonLink = screen.getByTestId("memory-injected-link-mem-canon-1");
    expect(canonLink.getAttribute("href")).toBe("/memory#item-mem-canon-1");
    expect(canonLink.textContent).toContain("BOS Safety Canon");

    const continuityLink = screen.getByTestId("memory-injected-link-mem-cont-1");
    expect(continuityLink.getAttribute("href")).toBe("/memory#item-mem-cont-1");
    expect(continuityLink.textContent).toContain("Field log");

    // The deleted row resolves async — wait for the live list to load and
    // mark the missing id as unavailable rather than rendering a link.
    await waitFor(() => {
      expect(
        screen.getByTestId("memory-injected-missing-mem-scratch-deleted"),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByTestId("memory-injected-link-mem-scratch-deleted"),
    ).toBeNull();
    expect(
      screen.getByTestId("memory-injected-missing-mem-scratch-deleted")
        .textContent,
    ).toContain("no longer available");
  });

  it("shows an inline notice when the live cross-reference lookup fails", async () => {
    // /api/memory rejects → liveIds stays null and links render
    // optimistically, but the panel must surface a small notice so users
    // know "no longer available" markers may be missing for this view.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network down"))),
    );

    const entry = {
      ...memoryInjectedEntry,
      metadata: {
        ...memoryInjectedEntry.metadata,
        injected_items: [
          { id: "mem-canon-1", layer: "canon", title: "BOS Safety Canon" },
        ],
      },
    };

    renderWithClient(<MemoryUsedPanel audit={[entry]} />);
    fireEvent.click(screen.getByTestId("memory-used-panel-toggle"));

    // Items still render with optimistic links (no false "unavailable").
    expect(
      screen.getByTestId("memory-injected-link-mem-canon-1"),
    ).toBeInTheDocument();
    // …but the "couldn't verify items" badge appears once the query errors.
    await waitFor(() => {
      expect(
        screen.getByTestId("memory-injected-lookup-failed"),
      ).toBeInTheDocument();
    });
  });

  it("hides the items section entirely on legacy tasks with no injected_items", () => {
    // memoryInjectedEntry intentionally has no `injected_items` field —
    // mirrors a task recorded before Task #50 shipped. The panel must
    // continue to render the layer counts / sections / preview without
    // showing an empty "ITEMS INJECTED" header.
    renderWithClient(<MemoryUsedPanel audit={[memoryInjectedEntry]} />);
    fireEvent.click(screen.getByTestId("memory-used-panel-toggle"));
    expect(screen.queryByTestId("memory-injected-items")).toBeNull();
    expect(screen.queryByText(/ITEMS INJECTED/)).toBeNull();
    // Other sections still render.
    expect(screen.getByTestId("memory-section-headers")).toBeInTheDocument();
    expect(screen.getByTestId("memory-context-preview")).toBeInTheDocument();
  });

  // === Task #51: per-layer dropped notice ===

  it("hides the dropped notice and header badge when no layer dropped anything", () => {
    // memoryInjectedEntry has no *_dropped fields → all coerce to 0.
    renderWithClient(<MemoryUsedPanel audit={[memoryInjectedEntry]} />);
    expect(screen.queryByTestId("memory-dropped-header-badge")).toBeNull();
    fireEvent.click(screen.getByTestId("memory-used-panel-toggle"));
    expect(screen.queryByTestId("memory-dropped-notice")).toBeNull();
  });

  it("renders a per-layer dropped notice with budgets when layers dropped > 0", () => {
    const droppedEntry = {
      ...memoryInjectedEntry,
      metadata: {
        ...memoryInjectedEntry.metadata,
        canon_dropped: 3,
        continuity_dropped: 1,
        patches_dropped: 0,
        scratchpad_dropped: 0,
      },
    };
    renderWithClient(<MemoryUsedPanel audit={[droppedEntry]} />);

    // Collapsed-state badge surfaces the total so users notice without
    // having to expand the panel.
    const badge = screen.getByTestId("memory-dropped-header-badge");
    expect(badge.textContent).toMatch(/4 dropped/);

    fireEvent.click(screen.getByTestId("memory-used-panel-toggle"));

    // The notice itself is now visible.
    const notice = screen.getByTestId("memory-dropped-notice");
    expect(notice).toBeInTheDocument();

    // Per-layer lines: only the layers with dropped > 0 appear, with
    // both the dropped count AND the layer's token budget called out.
    const canonLine = screen.getByTestId("memory-dropped-canon");
    expect(canonLine.textContent).toContain("3");
    expect(canonLine.textContent).toContain("canon");
    // Budget value comes from MEMORY_TOKEN_BUDGETS mirror in the panel.
    expect(canonLine.textContent).toMatch(/3,000-token/);

    const continuityLine = screen.getByTestId("memory-dropped-continuity");
    expect(continuityLine.textContent).toContain("1");
    // Singular "note" for count == 1, and the continuity budget number.
    expect(continuityLine.textContent).toMatch(/continuity note ranked/);
    expect(continuityLine.textContent).toMatch(/1,500-token/);

    // Layers with zero dropped MUST NOT be listed.
    expect(screen.queryByTestId("memory-dropped-patches")).toBeNull();
    expect(screen.queryByTestId("memory-dropped-scratchpad")).toBeNull();

    // Explainer mentions every layer's budget so users understand the cutoff.
    expect(notice.textContent).toMatch(/canon 3,000/);
    expect(notice.textContent).toMatch(/continuity 1,500/);
    expect(notice.textContent).toMatch(/patches 1,000/);
    expect(notice.textContent).toMatch(/scratchpad 750/);

    // Deep-link into Memory Manager so users can act on it.
    const link = screen.getByTestId("memory-dropped-manager-link");
    expect(link.getAttribute("href")).toBe("/memory");
  });

  it("renders the dropped notice even when the layer's items count is zero", () => {
    // Edge case: a layer can drop items even if NONE fit (budget too small
    // for any single ranked item). The notice must still appear.
    const allDroppedEntry = {
      ...memoryInjectedEntry,
      metadata: {
        ...memoryInjectedEntry.metadata,
        scratchpad_items: 0,
        scratchpad_dropped: 5,
      },
    };
    renderWithClient(<MemoryUsedPanel audit={[allDroppedEntry]} />);
    fireEvent.click(screen.getByTestId("memory-used-panel-toggle"));
    expect(screen.getByTestId("memory-dropped-notice")).toBeInTheDocument();
    const line = screen.getByTestId("memory-dropped-scratchpad");
    expect(line.textContent).toContain("5");
    expect(line.textContent).toMatch(/scratchpad notes ranked/); // plural
  });

  // === Task #53: copy + download affordances on the full-context view ===

  it("does NOT show copy/download buttons until the full context has been fetched", () => {
    // No taskId / no fetch → buttons must not render even with the panel open.
    renderWithClient(<MemoryUsedPanel audit={[memoryInjectedEntry]} />);
    fireEvent.click(screen.getByTestId("memory-used-panel-toggle"));
    expect(screen.queryByTestId("memory-context-copy-full")).toBeNull();
    expect(screen.queryByTestId("memory-context-download-full")).toBeNull();
  });

  it("does NOT show copy/download buttons while the user is still on the preview", async () => {
    // Stub the lazy fetch so the data is available, but don't click "View
    // full context" — copying the preview would be misleading because it's
    // capped at 8000 chars by the orchestrator.
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              memory_context: "FULL CONTEXT",
              chars: 11654,
              truncated: false,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
      ),
    );
    renderWithClient(<MemoryUsedPanel audit={[memoryInjectedEntry]} taskId="task-1" />);
    fireEvent.click(screen.getByTestId("memory-used-panel-toggle"));
    // Preview is showing, fullText is null → no copy/download buttons.
    expect(screen.getByTestId("memory-context-preview")).toBeInTheDocument();
    expect(screen.queryByTestId("memory-context-copy-full")).toBeNull();
    expect(screen.queryByTestId("memory-context-download-full")).toBeNull();
  });

  it("copies the full text to the clipboard with a visual confirmation", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const fullBody = "FULL CONTEXT BODY 0123456789".repeat(10);
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              memory_context: fullBody,
              chars: 11654,
              truncated: false,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
      ),
    );

    renderWithClient(<MemoryUsedPanel audit={[memoryInjectedEntry]} taskId="task-1" />);
    fireEvent.click(screen.getByTestId("memory-used-panel-toggle"));
    fireEvent.click(screen.getByTestId("memory-context-view-full"));

    // Wait for the fetch to resolve and the buttons to appear.
    const copyBtn = await screen.findByTestId("memory-context-copy-full");
    expect(copyBtn.textContent).toMatch(/COPY/);
    expect(copyBtn.textContent).not.toMatch(/COPIED/);

    fireEvent.click(copyBtn);

    // Clipboard receives the full body, not the bounded preview.
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(fullBody);

    // Visual confirmation flips to COPIED.
    await waitFor(() => {
      expect(
        screen.getByTestId("memory-context-copy-full").textContent,
      ).toMatch(/COPIED/);
    });
  });

  it("downloads the full text as a .txt file named with the task id", async () => {
    const fullBody = "FULL CONTEXT BODY".repeat(20);
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              memory_context: fullBody,
              chars: 11654,
              truncated: false,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
      ),
    );

    // Spy the URL helpers so we can verify the blob URL lifecycle without
    // touching real browser internals (jsdom doesn't actually download).
    const createObjectURL = vi.fn((_b: Blob) => "blob:mock-url");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      value: createObjectURL,
      configurable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      value: revokeObjectURL,
      configurable: true,
    });

    // Capture the synthesized <a> click so we can read href + download attrs.
    const clicks: { href: string; download: string }[] = [];
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      clicks.push({ href: this.href, download: this.download });
    };

    // Real task ids are UUIDs from randomUUID() in pipeline.ts — use a
    // representative one here so the asserted filename mirrors what users
    // actually see (and so we don't accidentally regress to the awkward
    // "task-task-42-..." pattern a `task-`-prefixed fixture would produce).
    const realisticTaskId = "550e8400-e29b-41d4-a716-446655440000";

    try {
      renderWithClient(
        <MemoryUsedPanel audit={[memoryInjectedEntry]} taskId={realisticTaskId} />,
      );
      fireEvent.click(screen.getByTestId("memory-used-panel-toggle"));
      fireEvent.click(screen.getByTestId("memory-context-view-full"));

      const downloadBtn = await screen.findByTestId(
        "memory-context-download-full",
      );
      fireEvent.click(downloadBtn);

      // Blob → object URL → <a download> → click → revoke. All must fire,
      // and the filename must follow the task-<id>-memory-context.txt spec.
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(createObjectURL.mock.calls[0][0]).toBeInstanceOf(Blob);
      expect(clicks).toHaveLength(1);
      expect(clicks[0].download).toBe(
        `task-${realisticTaskId}-memory-context.txt`,
      );
      expect(clicks[0].href).toContain("blob:mock-url");
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
    } finally {
      HTMLAnchorElement.prototype.click = originalClick;
    }
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
