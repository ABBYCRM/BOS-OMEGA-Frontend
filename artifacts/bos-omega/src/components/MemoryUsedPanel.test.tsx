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

  // === Task #59: per-user memory budget overrides ===
  //
  // The MEMORY_INJECTED audit row now carries the per-layer budgets that ran
  // for THIS task (recorded in artifacts/api-server/src/bos/pipeline.ts). The
  // panel reads them when rendering the per-tile tooltips, the dropped-notice
  // list, and the dropped-notice footer copy, falling back to engine defaults
  // for legacy tasks that have no `budgets` field.

  it("renders the recorded per-task budgets in the dropped-notice copy when present", () => {
    const overrideEntry = {
      id: "audit-budget",
      event_type: "MEMORY_INJECTED",
      message: "Memory context built (123 chars)",
      metadata: {
        canon_items: 2,
        continuity_items: 0,
        patches_items: 0,
        scratchpad_items: 0,
        canon_dropped: 1,
        continuity_dropped: 0,
        patches_dropped: 0,
        scratchpad_dropped: 0,
        memory_context_chars: 1000,
        section_headers: ["=== CANON CONTEXT ==="],
        memory_context_preview: "=== CANON CONTEXT ===",
        // The user's stored override at task time: 6 000 / 4 500 / 2 000 / 500.
        budgets: {
          canon: 6000,
          continuity: 4500,
          patches: 2000,
          scratchpad: 500,
        },
      },
      created_at: "2026-04-27T01:00:00.000Z",
    };
    renderWithClient(<MemoryUsedPanel audit={[overrideEntry]} />);
    fireEvent.click(screen.getByTestId("memory-used-panel-toggle"));

    // Dropped-notice list line cites the recorded canon budget (6 000),
    // not the engine default (3 000).
    const droppedRow = screen.getByTestId("memory-dropped-canon");
    expect(droppedRow.textContent).toContain("6,000-token");
    expect(droppedRow.textContent).not.toContain("3,000-token");

    // Footer copy lists all four recorded values, not the defaults.
    const notice = screen.getByTestId("memory-dropped-notice");
    expect(notice.textContent).toMatch(/canon\s+6,000/);
    expect(notice.textContent).toMatch(/continuity\s+4,500/);
    expect(notice.textContent).toMatch(/patches\s+2,000/);
    expect(notice.textContent).toMatch(/scratchpad\s+500/);
  });

  it("falls back to engine defaults when the audit row predates Task #59 (no budgets field)", () => {
    // Same rendering path but no `budgets` in metadata — the panel must
    // not crash, must not show NaN/undefined, and must surface the engine
    // defaults so the dropped-notice copy still tells the user the right
    // story for legacy tasks.
    const legacyDroppedEntry = {
      id: "audit-legacy",
      event_type: "MEMORY_INJECTED",
      message: "Memory context built (1000 chars)",
      metadata: {
        canon_items: 2,
        continuity_items: 0,
        patches_items: 0,
        scratchpad_items: 0,
        canon_dropped: 1,
        continuity_dropped: 0,
        patches_dropped: 0,
        scratchpad_dropped: 0,
        memory_context_chars: 1000,
        section_headers: ["=== CANON CONTEXT ==="],
        memory_context_preview: "=== CANON CONTEXT ===",
        // No `budgets` here — simulates a task created before Task #59.
      },
      created_at: "2026-04-27T01:00:00.000Z",
    };
    renderWithClient(<MemoryUsedPanel audit={[legacyDroppedEntry]} />);
    fireEvent.click(screen.getByTestId("memory-used-panel-toggle"));

    const notice = screen.getByTestId("memory-dropped-notice");
    // Defaults: canon=3000, continuity=1500, patches=1000, scratchpad=750.
    expect(notice.textContent).toMatch(/canon\s+3,000/);
    expect(notice.textContent).toMatch(/continuity\s+1,500/);
    expect(notice.textContent).toMatch(/patches\s+1,000/);
    expect(notice.textContent).toMatch(/scratchpad\s+750/);
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

  it("does NOT show the FULL-scope copy/download buttons until the full context has been fetched", () => {
    // The full-scope buttons only become visible once the lazy fetch
    // has returned a body. Without a taskId the fetch never fires, so
    // the FULL buttons must stay hidden. (The PREVIEW buttons added in
    // Task #61 are covered separately below.)
    renderWithClient(<MemoryUsedPanel audit={[memoryInjectedEntry]} />);
    fireEvent.click(screen.getByTestId("memory-used-panel-toggle"));
    expect(screen.queryByTestId("memory-context-copy-full")).toBeNull();
    expect(screen.queryByTestId("memory-context-download-full")).toBeNull();
  });

  it("does NOT show the FULL-scope copy/download buttons while the user is still on the preview", async () => {
    // Stub the lazy fetch so the data is available, but don't click "View
    // full context". The FULL-scope buttons must stay hidden until the
    // user actually opens the FULL view (otherwise the buttons could be
    // mistaken for FULL exports while the preview is on screen).
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
    // Preview is showing, fullText is null → no FULL-scope buttons.
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

  // === Task #61: copy + download affordances on the preview view ===
  //
  // Task #53 added Copy/Download to the FULL view only, which left users
  // debugging legacy tasks (recorded before Task #48 — only the bounded
  // preview was ever stored, no full text to fetch) with no way to pull
  // the memory text out of the browser. Task #61 adds parallel preview-
  // scope buttons so any audit row with a `memory_context_preview` can
  // be exported, with copy/filename clearly labeled "preview" so the
  // export is never mistaken for the full context.

  it("renders preview-scope COPY/DOWNLOAD buttons whenever the panel has preview text (legacy task path)", () => {
    // Legacy task: only `memory_context_preview` is stored, no
    // `memory_context_chars`, so previewIsTruncated is false and the
    // "VIEW FULL CONTEXT" affordance is hidden — but the user still
    // needs a way to export what IS recorded. The preview-scope
    // buttons must be visible here, even with no taskId.
    const legacyEntry = {
      id: "audit-legacy",
      event_type: "MEMORY_INJECTED",
      message: "Memory context built (legacy)",
      metadata: {
        canon_items: 1,
        section_headers: ["=== CANON CONTEXT ==="],
        memory_context_preview: "=== CANON CONTEXT ===\nlegacy preview body",
        // No memory_context_chars, no memory_context_full — pre-Task #48 shape.
      },
      created_at: "2026-04-27T01:00:00.000Z",
    };
    renderWithClient(<MemoryUsedPanel audit={[legacyEntry]} />);
    fireEvent.click(screen.getByTestId("memory-used-panel-toggle"));

    // The full-scope buttons stay hidden (no full text to copy).
    expect(screen.queryByTestId("memory-context-copy-full")).toBeNull();
    expect(screen.queryByTestId("memory-context-download-full")).toBeNull();
    // The "VIEW FULL CONTEXT" link is also hidden — chars <= preview.length.
    expect(screen.queryByTestId("memory-context-view-full")).toBeNull();

    // …but the preview-scope buttons ARE visible so the user can still export.
    const copyBtn = screen.getByTestId("memory-context-copy-preview");
    expect(copyBtn.textContent).toMatch(/COPY PREVIEW/);
    expect(screen.getByTestId("memory-context-download-preview")).toBeInTheDocument();
  });

  it("hides the preview-scope buttons when the audit row carries no preview text", () => {
    // Audit row with no memory_context_preview — there's nothing to copy
    // or download, so the preview-scope buttons must NOT render (we
    // never want a no-op button).
    const noPreviewEntry = {
      id: "audit-empty",
      event_type: "MEMORY_INJECTED",
      message: "Memory context built (0 chars)",
      metadata: {
        canon_items: 0,
        section_headers: [],
        // memory_context_preview intentionally absent.
      },
      created_at: "2026-04-27T01:00:00.000Z",
    };
    renderWithClient(<MemoryUsedPanel audit={[noPreviewEntry]} />);
    fireEvent.click(screen.getByTestId("memory-used-panel-toggle"));
    expect(screen.queryByTestId("memory-context-copy-preview")).toBeNull();
    expect(screen.queryByTestId("memory-context-download-preview")).toBeNull();
  });

  it("copies the preview text to the clipboard from the preview view", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    renderWithClient(<MemoryUsedPanel audit={[memoryInjectedEntry]} />);
    fireEvent.click(screen.getByTestId("memory-used-panel-toggle"));

    const copyBtn = screen.getByTestId("memory-context-copy-preview");
    fireEvent.click(copyBtn);

    // Clipboard receives EXACTLY the persisted preview body (the panel
    // must not invent or re-stringify the text).
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(
      memoryInjectedEntry.metadata.memory_context_preview,
    );
    // Visual confirmation flips to COPIED.
    await waitFor(() => {
      expect(
        screen.getByTestId("memory-context-copy-preview").textContent,
      ).toMatch(/COPIED/);
    });
  });

  it("downloads the preview as a .txt file with a -preview filename suffix", () => {
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

    const clicks: { href: string; download: string }[] = [];
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      clicks.push({ href: this.href, download: this.download });
    };

    const realisticTaskId = "550e8400-e29b-41d4-a716-446655440000";
    try {
      renderWithClient(
        <MemoryUsedPanel audit={[memoryInjectedEntry]} taskId={realisticTaskId} />,
      );
      fireEvent.click(screen.getByTestId("memory-used-panel-toggle"));
      fireEvent.click(screen.getByTestId("memory-context-download-preview"));

      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(createObjectURL.mock.calls[0][0]).toBeInstanceOf(Blob);
      expect(clicks).toHaveLength(1);
      // Filename carries the explicit -preview suffix so users (and
      // their downloads folder) can never confuse a preview export
      // with a full export of the same task.
      expect(clicks[0].download).toBe(
        `task-${realisticTaskId}-memory-context-preview.txt`,
      );
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
    } finally {
      HTMLAnchorElement.prototype.click = originalClick;
    }
  });

  it("falls back to a 'task-unknown' filename when no taskId is provided to the preview download", () => {
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
    const clicks: { href: string; download: string }[] = [];
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      clicks.push({ href: this.href, download: this.download });
    };
    try {
      // No taskId — mirrors the legacy/embedded use case where the panel
      // is rendered without a task context. The export must still produce
      // a sensible filename instead of crashing or exporting "undefined".
      renderWithClient(<MemoryUsedPanel audit={[memoryInjectedEntry]} />);
      fireEvent.click(screen.getByTestId("memory-used-panel-toggle"));
      fireEvent.click(screen.getByTestId("memory-context-download-preview"));
      expect(clicks).toHaveLength(1);
      expect(clicks[0].download).toBe("task-unknown-memory-context-preview.txt");
    } finally {
      HTMLAnchorElement.prototype.click = originalClick;
    }
  });

  it("labels the preview-scope buttons as 'preview only' when the preview is truncated", () => {
    // memoryInjectedEntry.memory_context_chars (11654) > preview.length,
    // so previewIsTruncated is true. The button tooltips must call out
    // that this is a preview export and point users at VIEW FULL CONTEXT.
    renderWithClient(
      <MemoryUsedPanel audit={[memoryInjectedEntry]} taskId="task-1" />,
    );
    fireEvent.click(screen.getByTestId("memory-used-panel-toggle"));

    const copyBtn = screen.getByTestId("memory-context-copy-preview");
    expect(copyBtn.getAttribute("aria-label")).toMatch(/preview only/);
    expect(copyBtn.getAttribute("title")).toMatch(/full context is 11654 chars/);

    const downloadBtn = screen.getByTestId("memory-context-download-preview");
    expect(downloadBtn.getAttribute("aria-label")).toMatch(/preview only/);
    expect(downloadBtn.getAttribute("title")).toMatch(/full context is 11654 chars/);

    // The header truncation badge ("(truncated to N of M chars)") is
    // already shown next to the section title — that visual cue plus the
    // "PREVIEW" suffix in the button text means the user can never read
    // the export as the full context.
    expect(
      screen.getByText(/truncated to .* of 11654 chars/),
    ).toBeInTheDocument();
  });

  it("hides the preview-scope buttons once the user opens the FULL view (FULL buttons take over)", async () => {
    // Once the user opens the FULL view, the FULL-scope buttons render
    // instead — we don't want two pairs of buttons stacked on top of
    // each other in the same header row.
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

    // Preview-scope buttons visible while preview is on screen.
    expect(screen.getByTestId("memory-context-copy-preview")).toBeInTheDocument();
    expect(screen.getByTestId("memory-context-download-preview")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("memory-context-view-full"));

    // Once the FULL view loads, the FULL buttons appear and the PREVIEW
    // buttons disappear.
    await screen.findByTestId("memory-context-copy-full");
    expect(screen.queryByTestId("memory-context-copy-preview")).toBeNull();
    expect(screen.queryByTestId("memory-context-download-preview")).toBeNull();

    // Switch back to the preview view — PREVIEW buttons reappear.
    fireEvent.click(screen.getByTestId("memory-context-show-preview"));
    expect(screen.getByTestId("memory-context-copy-preview")).toBeInTheDocument();
    expect(screen.queryByTestId("memory-context-copy-full")).toBeNull();
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

  // === Task #54: per-tile dropped counter on each layer tile ===

  it("renders a per-tile dropped counter on every layer tile, defaulting to 0", () => {
    // memoryInjectedEntry has no *_dropped fields → each tile must still
    // render a "0 dropped" footer so the four tiles stay visually balanced
    // and so users can confirm at a glance that nothing was cut.
    renderWithClient(<MemoryUsedPanel audit={[memoryInjectedEntry]} />);
    fireEvent.click(screen.getByTestId("memory-used-panel-toggle"));

    for (const layer of ["canon", "continuity", "patches", "scratchpad"]) {
      const tile = screen.getByTestId(`memory-layer-${layer}-dropped`);
      expect(tile).toBeInTheDocument();
      expect(tile.textContent).toMatch(/0 dropped/);
      // Zero-state is muted (not amber) so it doesn't draw attention.
      expect(tile.className).not.toMatch(/text-amber-700/);
      // Tooltip exists so hover users can read the plain-English explainer
      // even when the count is zero (confirms "nothing was cut").
      expect(tile.getAttribute("title")).toMatch(
        /No .* notes were dropped/,
      );
    }

    // Inline caption explains what "dropped" means for users who don't hover.
    expect(
      screen.getByText(
        /"Dropped" = item was ranked relevant but didn't fit the layer's token budget\./,
      ),
    ).toBeInTheDocument();
  });

  it("highlights non-zero per-tile dropped counts in amber with an explanatory tooltip", () => {
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
    fireEvent.click(screen.getByTestId("memory-used-panel-toggle"));

    // Non-zero tiles: amber, bolded, count + word "dropped".
    const canonDropped = screen.getByTestId("memory-layer-canon-dropped");
    expect(canonDropped.textContent).toMatch(/3 dropped/);
    expect(canonDropped.className).toMatch(/text-amber-700/);
    expect(canonDropped.className).toMatch(/font-bold/);
    // Tooltip gives the full plain-English explanation including the budget,
    // so users get the answer to "why didn't the AI use my note?" on hover.
    expect(canonDropped.getAttribute("title")).toMatch(
      /3 canon notes ranked but didn't fit the 3,000-token canon budget/,
    );

    const continuityDropped = screen.getByTestId(
      "memory-layer-continuity-dropped",
    );
    expect(continuityDropped.textContent).toMatch(/1 dropped/);
    // Singular "note" when count == 1, plus the continuity budget value.
    expect(continuityDropped.getAttribute("title")).toMatch(
      /1 continuity note ranked but didn't fit the 1,500-token continuity budget/,
    );

    // Zero tiles stay muted so non-zero ones stand out in the row.
    const patchesDropped = screen.getByTestId("memory-layer-patches-dropped");
    expect(patchesDropped.textContent).toMatch(/0 dropped/);
    expect(patchesDropped.className).not.toMatch(/text-amber-700/);

    const scratchpadDropped = screen.getByTestId(
      "memory-layer-scratchpad-dropped",
    );
    expect(scratchpadDropped.textContent).toMatch(/0 dropped/);
    expect(scratchpadDropped.className).not.toMatch(/text-amber-700/);
  });

  // === Task #58: per-row provenance for dropped items ===

  it("hides the dropped-items toggle entirely on legacy tasks with no dropped_items field", () => {
    // Legacy: dropped count > 0 but no per-row provenance recorded.
    // The amber notice still renders (count + budget), but the
    // expand-list affordance must NOT show — there's nothing to expand.
    const legacyDropped = {
      ...memoryInjectedEntry,
      metadata: {
        ...memoryInjectedEntry.metadata,
        canon_dropped: 2,
      },
    };
    renderWithClient(<MemoryUsedPanel audit={[legacyDropped]} />);
    fireEvent.click(screen.getByTestId("memory-used-panel-toggle"));
    expect(screen.getByTestId("memory-dropped-notice")).toBeInTheDocument();
    expect(screen.queryByTestId("memory-dropped-items-section")).toBeNull();
    expect(screen.queryByTestId("memory-dropped-items-toggle")).toBeNull();
  });

  it("renders the dropped-items toggle (collapsed by default) when dropped_items are present", () => {
    const droppedEntry = {
      ...memoryInjectedEntry,
      metadata: {
        ...memoryInjectedEntry.metadata,
        canon_dropped: 2,
        dropped_items: [
          { id: "mem-canon-2", layer: "canon", title: "Niche policy clause" },
          { id: "mem-canon-3", layer: "canon", title: "Edge-case rubric" },
        ],
      },
    };
    renderWithClient(<MemoryUsedPanel audit={[droppedEntry]} />);
    fireEvent.click(screen.getByTestId("memory-used-panel-toggle"));

    const toggle = screen.getByTestId("memory-dropped-items-toggle");
    expect(toggle).toBeInTheDocument();
    expect(toggle.textContent).toMatch(/SHOW DROPPED ITEMS \(2\)/);
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    // Collapsed by default — body and inner items list must not be in the DOM.
    expect(screen.queryByTestId("memory-dropped-items-body")).toBeNull();
    expect(screen.queryByTestId("memory-dropped-item-items")).toBeNull();
  });

  it("expands the dropped-items list with deep-links and marks deleted rows as no-longer-available", async () => {
    // The cross-reference query — same /api/memory endpoint as ITEMS INJECTED
    // — answers with one of the two dropped ids; the other must render as
    // "no longer available" instead of a broken anchor.
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/api/memory") || url.includes("/api/memory?")) {
          return Promise.resolve(
            new Response(
              JSON.stringify([
                {
                  id: "mem-canon-2",
                  layer: "canon",
                  title: "Niche policy clause",
                  content: "...",
                  authority_level: 5,
                  created_at: "2026-01-01T00:00:00.000Z",
                  updated_at: "2026-01-01T00:00:00.000Z",
                },
                // mem-scratch-deleted intentionally absent from the live list.
              ]),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
          );
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      }),
    );

    const droppedEntry = {
      ...memoryInjectedEntry,
      metadata: {
        ...memoryInjectedEntry.metadata,
        canon_dropped: 1,
        scratchpad_dropped: 1,
        dropped_items: [
          { id: "mem-canon-2", layer: "canon", title: "Niche policy clause" },
          { id: "mem-scratch-deleted", layer: "scratchpad", title: "Old hint" },
        ],
      },
    };
    renderWithClient(<MemoryUsedPanel audit={[droppedEntry]} />);
    fireEvent.click(screen.getByTestId("memory-used-panel-toggle"));
    fireEvent.click(screen.getByTestId("memory-dropped-items-toggle"));

    // Body now rendered.
    expect(screen.getByTestId("memory-dropped-items-body")).toBeInTheDocument();
    expect(
      screen.getByTestId("memory-dropped-items-toggle"),
    ).toHaveAttribute("aria-expanded", "true");

    // Heading inside the list uses the dropped label (not "ITEMS INJECTED").
    // Both the toggle button and the heading carry the same "DROPPED ITEMS (n)"
    // text, so we look it up scoped to the list body to assert on the heading.
    const body = screen.getByTestId("memory-dropped-items-body");
    expect(body.textContent).toMatch(/DROPPED ITEMS \(2\)/);

    // Surviving id renders as a Memory Manager deep-link with the reused
    // testIdPrefix so we don't collide with any injected items list above.
    const link = screen.getByTestId("memory-dropped-item-link-mem-canon-2");
    expect(link.getAttribute("href")).toBe("/memory#item-mem-canon-2");
    expect(link.textContent).toContain("Niche policy clause");

    // Deleted row resolves async — wait for the live list to load and
    // mark the missing id as unavailable rather than rendering a link.
    await waitFor(() => {
      expect(
        screen.getByTestId("memory-dropped-item-missing-mem-scratch-deleted"),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByTestId("memory-dropped-item-link-mem-scratch-deleted"),
    ).toBeNull();
    expect(
      screen.getByTestId("memory-dropped-item-missing-mem-scratch-deleted")
        .textContent,
    ).toContain("no longer available");

    // Toggle back to collapsed.
    fireEvent.click(screen.getByTestId("memory-dropped-items-toggle"));
    expect(screen.queryByTestId("memory-dropped-items-body")).toBeNull();
  });

  it("discloses truncation when total dropped count exceeds the recorded dropped_items array", () => {
    // Per-layer dropped lists are capped server-side at DROPPED_TITLES_CAP
    // (currently 20). When the orchestrator dropped MORE notes than the
    // audit row carries, the UI must say so explicitly — otherwise users
    // read "I dropped 25, only 20 named" as a missing-data bug.
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response("[]", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      ),
    );

    const droppedEntry = {
      ...memoryInjectedEntry,
      metadata: {
        ...memoryInjectedEntry.metadata,
        canon_dropped: 25, // 25 dropped from canon, only 2 carried in dropped_items
        dropped_items: [
          { id: "mem-canon-2", layer: "canon", title: "Niche policy clause" },
          { id: "mem-canon-3", layer: "canon", title: "Other clause" },
        ],
      },
    };
    renderWithClient(<MemoryUsedPanel audit={[droppedEntry]} />);
    fireEvent.click(screen.getByTestId("memory-used-panel-toggle"));

    // Toggle button shows "2 of 25" instead of just "(2)".
    const toggle = screen.getByTestId("memory-dropped-items-toggle");
    expect(toggle.textContent).toMatch(/DROPPED ITEMS \(2 of 25\)/);

    // Truncation hint only renders inside the expanded body.
    expect(screen.queryByTestId("memory-dropped-items-truncated")).toBeNull();
    fireEvent.click(toggle);
    const hint = screen.getByTestId("memory-dropped-items-truncated");
    expect(hint.textContent).toMatch(/Showing first 2 of 25 dropped notes/);
  });

  it("does NOT show the truncation hint when dropped_items carries every dropped note", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response("[]", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      ),
    );

    const droppedEntry = {
      ...memoryInjectedEntry,
      metadata: {
        ...memoryInjectedEntry.metadata,
        canon_dropped: 2, // matches dropped_items.length exactly
        dropped_items: [
          { id: "mem-canon-2", layer: "canon", title: "Niche policy clause" },
          { id: "mem-canon-3", layer: "canon", title: "Other clause" },
        ],
      },
    };
    renderWithClient(<MemoryUsedPanel audit={[droppedEntry]} />);
    fireEvent.click(screen.getByTestId("memory-used-panel-toggle"));

    // Toggle uses the simple "(n)" form.
    expect(
      screen.getByTestId("memory-dropped-items-toggle").textContent,
    ).toMatch(/DROPPED ITEMS \(2\)/);
    fireEvent.click(screen.getByTestId("memory-dropped-items-toggle"));
    expect(screen.queryByTestId("memory-dropped-items-truncated")).toBeNull();
  });

  it("does NOT fetch /api/memory until the dropped-items list is expanded", () => {
    const fetchSpy = vi.fn(() =>
      Promise.reject(new Error("should not be called")),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const droppedEntry = {
      ...memoryInjectedEntry,
      metadata: {
        ...memoryInjectedEntry.metadata,
        canon_dropped: 1,
        dropped_items: [
          { id: "mem-canon-2", layer: "canon", title: "Niche policy clause" },
        ],
      },
    };
    renderWithClient(<MemoryUsedPanel audit={[droppedEntry]} />);
    fireEvent.click(screen.getByTestId("memory-used-panel-toggle"));
    // Panel is open; dropped items toggle is visible but NOT expanded yet.
    expect(screen.getByTestId("memory-dropped-items-toggle")).toBeInTheDocument();
    // The cross-reference fetch must not have fired — saving a roundtrip
    // for the common case where the user only reads the count + budget copy.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shows a per-tile dropped counter even when the layer's items count is zero", () => {
    // Edge case: a layer can drop items even if NONE fit (budget too small
    // for any single ranked item). The tile still shows the count + 0 items
    // so users know the budget cut everything, not that nothing was relevant.
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
    const tile = screen.getByTestId("memory-layer-scratchpad-dropped");
    expect(tile.textContent).toMatch(/5 dropped/);
    expect(tile.className).toMatch(/text-amber-700/);
    // Plural "notes" for count > 1 in the tooltip.
    expect(tile.getAttribute("title")).toMatch(
      /5 scratchpad notes ranked but didn't fit the 750-token scratchpad budget/,
    );
  });

  // === Task #60: per-layer trimmed-titles disclosure ===
  //
  // The orchestrator records per-layer `*_dropped_titles` arrays on
  // MEMORY_INJECTED (added in Task #52, bounded to DROPPED_TITLES_CAP=20
  // in artifacts/api-server/src/bos/memoryHelpers.ts). The Memory Used
  // panel surfaces them as an expandable list under each layer's line in
  // the dropped notice so users can see *which* notes were trimmed and
  // click through to the Memory Manager when an id is recoverable from
  // the parallel `dropped_items` array.

  it("hides the per-layer trimmed-titles toggle on legacy rows with no *_dropped_titles", () => {
    // Legacy: dropped count > 0, no titles array → toggle must NOT render.
    const legacyDropped = {
      ...memoryInjectedEntry,
      metadata: {
        ...memoryInjectedEntry.metadata,
        canon_dropped: 2,
      },
    };
    renderWithClient(<MemoryUsedPanel audit={[legacyDropped]} />);
    fireEvent.click(screen.getByTestId("memory-used-panel-toggle"));
    expect(screen.getByTestId("memory-dropped-notice")).toBeInTheDocument();
    expect(screen.queryByTestId("memory-dropped-titles-canon")).toBeNull();
    expect(
      screen.queryByTestId("memory-dropped-titles-toggle-canon"),
    ).toBeNull();
  });

  it("renders one trimmed-titles toggle per dropped layer (collapsed by default)", () => {
    const droppedEntry = {
      ...memoryInjectedEntry,
      metadata: {
        ...memoryInjectedEntry.metadata,
        canon_dropped: 2,
        continuity_dropped: 1,
        canon_dropped_titles: ["Niche policy clause", "Edge-case rubric"],
        continuity_dropped_titles: ["Last week's field log"],
      },
    };
    renderWithClient(<MemoryUsedPanel audit={[droppedEntry]} />);
    fireEvent.click(screen.getByTestId("memory-used-panel-toggle"));

    const canonToggle = screen.getByTestId(
      "memory-dropped-titles-toggle-canon",
    );
    expect(canonToggle.textContent).toMatch(/SHOW TRIMMED TITLES \(2\)/);
    expect(canonToggle).toHaveAttribute("aria-expanded", "false");

    const continuityToggle = screen.getByTestId(
      "memory-dropped-titles-toggle-continuity",
    );
    expect(continuityToggle.textContent).toMatch(/SHOW TRIMMED TITLES \(1\)/);
    expect(continuityToggle).toHaveAttribute("aria-expanded", "false");

    // Layers with zero dropped don't appear in the notice at all,
    // so their disclosures must also be absent.
    expect(
      screen.queryByTestId("memory-dropped-titles-toggle-patches"),
    ).toBeNull();
    expect(
      screen.queryByTestId("memory-dropped-titles-toggle-scratchpad"),
    ).toBeNull();

    // Lists themselves are hidden until the user clicks the toggle.
    expect(
      screen.queryByTestId("memory-dropped-titles-list-canon"),
    ).toBeNull();
    expect(
      screen.queryByTestId("memory-dropped-titles-list-continuity"),
    ).toBeNull();
  });

  it("expands a per-layer trimmed-titles list independently of other layers", () => {
    const droppedEntry = {
      ...memoryInjectedEntry,
      metadata: {
        ...memoryInjectedEntry.metadata,
        canon_dropped: 2,
        continuity_dropped: 1,
        canon_dropped_titles: ["Niche policy clause", "Edge-case rubric"],
        continuity_dropped_titles: ["Last week's field log"],
      },
    };
    renderWithClient(<MemoryUsedPanel audit={[droppedEntry]} />);
    fireEvent.click(screen.getByTestId("memory-used-panel-toggle"));

    fireEvent.click(screen.getByTestId("memory-dropped-titles-toggle-canon"));

    const canonList = screen.getByTestId("memory-dropped-titles-list-canon");
    expect(canonList.textContent).toContain("Niche policy clause");
    expect(canonList.textContent).toContain("Edge-case rubric");
    expect(
      screen.getByTestId("memory-dropped-titles-toggle-canon"),
    ).toHaveAttribute("aria-expanded", "true");

    // Continuity stays collapsed — the four disclosures don't share state.
    expect(
      screen.queryByTestId("memory-dropped-titles-list-continuity"),
    ).toBeNull();
    expect(
      screen.getByTestId("memory-dropped-titles-toggle-continuity"),
    ).toHaveAttribute("aria-expanded", "false");

    // Toggle canon back to collapsed.
    fireEvent.click(screen.getByTestId("memory-dropped-titles-toggle-canon"));
    expect(
      screen.queryByTestId("memory-dropped-titles-list-canon"),
    ).toBeNull();
  });

  it("links each trimmed title to /memory#item-<id> when dropped_items carries the matching (layer, title)", () => {
    const droppedEntry = {
      ...memoryInjectedEntry,
      metadata: {
        ...memoryInjectedEntry.metadata,
        canon_dropped: 2,
        canon_dropped_titles: ["Niche policy clause", "Edge-case rubric"],
        // Only the first title has a matching id in dropped_items;
        // the second must fall back to plain text per the task spec.
        dropped_items: [
          { id: "mem-canon-2", layer: "canon", title: "Niche policy clause" },
        ],
      },
    };
    renderWithClient(<MemoryUsedPanel audit={[droppedEntry]} />);
    fireEvent.click(screen.getByTestId("memory-used-panel-toggle"));
    fireEvent.click(screen.getByTestId("memory-dropped-titles-toggle-canon"));

    // Matched title → Memory Manager deep-link.
    const link = screen.getByTestId("memory-dropped-title-link-canon-0");
    expect(link.getAttribute("href")).toBe("/memory#item-mem-canon-2");
    expect(link.textContent).toContain("Niche policy clause");

    // Unmatched title → plain text, no anchor.
    expect(
      screen.queryByTestId("memory-dropped-title-link-canon-1"),
    ).toBeNull();
    const text = screen.getByTestId("memory-dropped-title-text-canon-1");
    expect(text.textContent).toContain("Edge-case rubric");
  });

  it("keys the (layer, title) lookup so two layers with the same title don't cross-link", () => {
    // Two dropped notes share the same title across canon and scratchpad.
    // The lookup must NOT resolve a scratchpad title to a canon id.
    const droppedEntry = {
      ...memoryInjectedEntry,
      metadata: {
        ...memoryInjectedEntry.metadata,
        canon_dropped: 1,
        scratchpad_dropped: 1,
        canon_dropped_titles: ["Style rule"],
        scratchpad_dropped_titles: ["Style rule"],
        dropped_items: [
          { id: "mem-canon-99", layer: "canon", title: "Style rule" },
          // No scratchpad row → its title must render as plain text.
        ],
      },
    };
    renderWithClient(<MemoryUsedPanel audit={[droppedEntry]} />);
    fireEvent.click(screen.getByTestId("memory-used-panel-toggle"));
    fireEvent.click(screen.getByTestId("memory-dropped-titles-toggle-canon"));
    fireEvent.click(
      screen.getByTestId("memory-dropped-titles-toggle-scratchpad"),
    );

    // Canon resolves to its id.
    const canonLink = screen.getByTestId("memory-dropped-title-link-canon-0");
    expect(canonLink.getAttribute("href")).toBe("/memory#item-mem-canon-99");

    // Scratchpad has no matching dropped_items entry → plain text only.
    expect(
      screen.queryByTestId("memory-dropped-title-link-scratchpad-0"),
    ).toBeNull();
    expect(
      screen.getByTestId("memory-dropped-title-text-scratchpad-0").textContent,
    ).toContain("Style rule");
  });

  it("shows '…and N more' when the dropped count exceeds the recorded titles array (capped at DROPPED_TITLES_CAP)", () => {
    // The orchestrator caps *_dropped_titles at DROPPED_TITLES_CAP=20 server
    // side. When more notes were dropped than the array carries, the UI
    // must surface the overflow explicitly so users don't read "I dropped
    // 25, only 20 named" as missing data.
    const titles = Array.from({ length: 20 }, (_, i) => `note-${i + 1}`);
    const droppedEntry = {
      ...memoryInjectedEntry,
      metadata: {
        ...memoryInjectedEntry.metadata,
        canon_dropped: 25,
        canon_dropped_titles: titles,
      },
    };
    renderWithClient(<MemoryUsedPanel audit={[droppedEntry]} />);
    fireEvent.click(screen.getByTestId("memory-used-panel-toggle"));

    // Toggle copy includes the "X of Y" form when overflow > 0.
    const toggle = screen.getByTestId("memory-dropped-titles-toggle-canon");
    expect(toggle.textContent).toMatch(/SHOW TRIMMED TITLES \(20 of 25\)/);

    // Overflow notice only appears inside the expanded list.
    expect(
      screen.queryByTestId("memory-dropped-titles-overflow-canon"),
    ).toBeNull();
    fireEvent.click(toggle);
    const overflow = screen.getByTestId("memory-dropped-titles-overflow-canon");
    expect(overflow.textContent).toMatch(/…and 5 more/);
    expect(overflow.textContent).toMatch(/caps per-layer trimmed titles at 20/);
  });

  it("uses the simple '(n)' toggle form and hides the overflow notice when titles array carries every dropped note", () => {
    const droppedEntry = {
      ...memoryInjectedEntry,
      metadata: {
        ...memoryInjectedEntry.metadata,
        canon_dropped: 2,
        canon_dropped_titles: ["First", "Second"],
      },
    };
    renderWithClient(<MemoryUsedPanel audit={[droppedEntry]} />);
    fireEvent.click(screen.getByTestId("memory-used-panel-toggle"));

    expect(
      screen.getByTestId("memory-dropped-titles-toggle-canon").textContent,
    ).toMatch(/SHOW TRIMMED TITLES \(2\)/);
    fireEvent.click(screen.getByTestId("memory-dropped-titles-toggle-canon"));
    expect(
      screen.queryByTestId("memory-dropped-titles-overflow-canon"),
    ).toBeNull();
  });

  it("ignores malformed *_dropped_titles entries instead of crashing", () => {
    // Defensive parser must drop non-string entries silently — the panel
    // never trusts audit metadata to be well-formed.
    const droppedEntry = {
      ...memoryInjectedEntry,
      metadata: {
        ...memoryInjectedEntry.metadata,
        canon_dropped: 3,
        // Mix of valid strings, a number, null, and an object. Only the
        // two strings should make it through to the rendered list.
        canon_dropped_titles: [
          "Real title A",
          42,
          null,
          { not: "a string" },
          "Real title B",
        ],
      },
    };
    renderWithClient(<MemoryUsedPanel audit={[droppedEntry]} />);
    fireEvent.click(screen.getByTestId("memory-used-panel-toggle"));

    const toggle = screen.getByTestId("memory-dropped-titles-toggle-canon");
    // dropped: 3, valid recorded: 2 → toggle shows "(2 of 3)"
    expect(toggle.textContent).toMatch(/SHOW TRIMMED TITLES \(2 of 3\)/);
    fireEvent.click(toggle);
    const list = screen.getByTestId("memory-dropped-titles-list-canon");
    expect(list.textContent).toContain("Real title A");
    expect(list.textContent).toContain("Real title B");
    expect(list.textContent).not.toContain("42");
    expect(list.textContent).not.toContain("a string");
  });
});
