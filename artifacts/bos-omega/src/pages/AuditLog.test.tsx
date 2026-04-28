import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuditLog } from "./AuditLog";

// Test plan covers Task #56 (per-row expansion) AND Task #72 (paginated
// audit list with "Load older entries" + total counter):
//  - MEMORY_INJECTED rows are expandable from the global Audit Log page
//  - Expanding renders the same per-item provenance UI as the Task Detail
//    "Memory used" panel (clickable layer-coloured chips, deep-links to
//    `/memory#item-<id>`, "no longer available" markers for deleted rows)
//  - Non-MEMORY_INJECTED rows with metadata are still expandable and show
//    the raw JSON metadata block (so this view doesn't regress for
//    USER_CREATED, OVERRIDE_APPLIED, etc.)
//  - Rows with null metadata are NOT expandable
//  - Header counter renders "showing X of N" using the envelope `total`
//  - "Load older entries" button appears iff total > entries.length and
//    growing the window refetches with a larger `limit`
//  - When entries.length === total the button is hidden and the status
//    line says "Showing all entries"

const memoryInjectedRow = {
  id: "audit-mi",
  task_id: "task-1",
  event_type: "MEMORY_INJECTED",
  message: "Memory context built (123 chars)",
  metadata: {
    canon_items: 1,
    continuity_items: 0,
    patches_items: 0,
    scratchpad_items: 1,
    memory_context_chars: 200,
    section_headers: ["=== CANON CONTEXT ==="],
    memory_context_preview: "=== CANON CONTEXT ===",
    injected_items: [
      { id: "mem-canon-1", layer: "canon", title: "BOS Safety Canon" },
      { id: "mem-deleted", layer: "scratchpad", title: "Old note" },
    ],
  },
  created_at: "2026-04-27T01:00:00.000Z",
};

const taskReceivedRow = {
  id: "audit-tr",
  task_id: "task-1",
  event_type: "TASK_RECEIVED",
  message: "task received",
  metadata: { source: "web" },
  created_at: "2026-04-27T00:59:59.000Z",
};

const noMetaRow = {
  id: "audit-nm",
  task_id: null,
  event_type: "TASK_COMPLETED",
  message: "completed",
  metadata: null,
  created_at: "2026-04-27T00:59:58.000Z",
};

// Task #72: tests now exercise the paginated envelope shape. We accept
// either a fixed total (so we can assert "Load older entries" behaviour)
// or default to entries.length when callers don't care about pagination.
function makeFetch(
  rows: unknown[],
  options: { memoryRows?: unknown[]; total?: number; rowsForLimit?: (limit: number) => unknown[] } = {},
) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/audit")) {
      const parsed = new URL(url, "http://test");
      const limit = Number(parsed.searchParams.get("limit") ?? "100");
      const entries = options.rowsForLimit ? options.rowsForLimit(limit) : rows;
      const total = options.total ?? entries.length;
      return Promise.resolve(
        new Response(
          JSON.stringify({ entries, total, limit, offset: 0 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (url.includes("/api/memory")) {
      return Promise.resolve(
        new Response(JSON.stringify(options.memoryRows ?? []), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("unmocked fetch"))),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AuditLog page", () => {
  it("renders rows and is fully collapsed by default", async () => {
    vi.stubGlobal("fetch", makeFetch([memoryInjectedRow, taskReceivedRow]));
    renderWithClient(<AuditLog />);
    await waitFor(() =>
      expect(screen.getByTestId("audit-row-audit-mi")).toBeInTheDocument(),
    );
    // No row body rendered.
    expect(screen.queryByTestId("audit-row-body-audit-mi")).toBeNull();
    // No injected items list rendered.
    expect(screen.queryByTestId("memory-injected-items")).toBeNull();
    // Toggles report collapsed state via aria-expanded.
    expect(
      screen.getByTestId("audit-row-toggle-audit-mi"),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("expands a MEMORY_INJECTED row to show the per-item provenance list with Memory Manager deep-links", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetch([memoryInjectedRow], {
        memoryRows: [
          {
            id: "mem-canon-1",
            layer: "canon",
            title: "BOS Safety Canon",
            content: "...",
            authority_level: 9,
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
          },
          // mem-deleted intentionally absent
        ],
      }),
    );
    renderWithClient(<AuditLog />);
    await waitFor(() =>
      expect(screen.getByTestId("audit-row-toggle-audit-mi")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("audit-row-toggle-audit-mi"));

    // Body and items list both render.
    expect(screen.getByTestId("audit-row-body-audit-mi")).toBeInTheDocument();
    expect(screen.getByTestId("memory-injected-items")).toBeInTheDocument();
    expect(screen.getByText(/ITEMS INJECTED \(2\)/)).toBeInTheDocument();

    // Live row has a deep-link into the Memory Manager.
    const link = screen.getByTestId("memory-injected-link-mem-canon-1");
    expect(link.getAttribute("href")).toBe("/memory#item-mem-canon-1");
    expect(link.textContent).toContain("BOS Safety Canon");

    // Deleted row resolves async and is rendered as "no longer available"
    // instead of a broken anchor.
    await waitFor(() =>
      expect(
        screen.getByTestId("memory-injected-missing-mem-deleted"),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("memory-injected-link-mem-deleted")).toBeNull();

    // Raw metadata block also renders so users can still see everything.
    expect(
      screen.getByTestId("audit-row-metadata-audit-mi"),
    ).toBeInTheDocument();
  });

  it("collapses again on second toggle click", async () => {
    vi.stubGlobal("fetch", makeFetch([memoryInjectedRow], { memoryRows: [] }));
    renderWithClient(<AuditLog />);
    await waitFor(() =>
      expect(screen.getByTestId("audit-row-toggle-audit-mi")).toBeInTheDocument(),
    );
    const toggle = screen.getByTestId("audit-row-toggle-audit-mi");
    fireEvent.click(toggle);
    expect(screen.getByTestId("audit-row-body-audit-mi")).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByTestId("audit-row-body-audit-mi")).toBeNull();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  // ----- Task #81: dropped-items list under MEMORY_INJECTED rows -----

  it("renders a collapsed-by-default DROPPED ITEMS toggle when dropped_items are present, alongside the existing INJECTED list", async () => {
    const droppedRow = {
      ...memoryInjectedRow,
      id: "audit-mi-dropped",
      metadata: {
        ...memoryInjectedRow.metadata,
        dropped_items: [
          { id: "mem-canon-2", layer: "canon", title: "Less-relevant canon" },
          { id: "mem-scratch-deleted", layer: "scratchpad", title: "Old scratch" },
        ],
      },
    };
    vi.stubGlobal(
      "fetch",
      makeFetch([droppedRow], {
        memoryRows: [
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
            id: "mem-canon-2",
            layer: "canon",
            title: "Less-relevant canon",
            content: "...",
            authority_level: 5,
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
          },
          // mem-scratch-deleted intentionally absent → "no longer available"
        ],
      }),
    );
    renderWithClient(<AuditLog />);
    await waitFor(() =>
      expect(
        screen.getByTestId("audit-row-toggle-audit-mi-dropped"),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("audit-row-toggle-audit-mi-dropped"));

    // Body opens; injected list still rendered as before.
    expect(
      screen.getByTestId("audit-row-body-audit-mi-dropped"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("memory-injected-items")).toBeInTheDocument();

    // Dropped section shows a toggle, but the list itself is collapsed by
    // default so the body is not in the DOM yet.
    const droppedToggle = screen.getByTestId(
      "audit-row-dropped-toggle-audit-mi-dropped",
    );
    expect(droppedToggle).toHaveAttribute("aria-expanded", "false");
    expect(droppedToggle.textContent).toMatch(/SHOW DROPPED ITEMS \(2\)/);
    expect(
      screen.queryByTestId("audit-row-dropped-body-audit-mi-dropped"),
    ).toBeNull();
    expect(screen.queryByTestId("memory-dropped-item-items")).toBeNull();
  });

  it("expands the DROPPED ITEMS list to show layer chips, deep-links, and 'no longer available' markers", async () => {
    const droppedRow = {
      ...memoryInjectedRow,
      id: "audit-mi-dropped-expand",
      metadata: {
        ...memoryInjectedRow.metadata,
        dropped_items: [
          { id: "mem-canon-2", layer: "canon", title: "Less-relevant canon" },
          { id: "mem-scratch-deleted", layer: "scratchpad", title: "Old scratch" },
        ],
      },
    };
    vi.stubGlobal(
      "fetch",
      makeFetch([droppedRow], {
        memoryRows: [
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
            id: "mem-canon-2",
            layer: "canon",
            title: "Less-relevant canon",
            content: "...",
            authority_level: 5,
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    renderWithClient(<AuditLog />);
    await waitFor(() =>
      expect(
        screen.getByTestId("audit-row-toggle-audit-mi-dropped-expand"),
      ).toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByTestId("audit-row-toggle-audit-mi-dropped-expand"),
    );
    fireEvent.click(
      screen.getByTestId("audit-row-dropped-toggle-audit-mi-dropped-expand"),
    );

    // Toggle flips; body and items list render.
    expect(
      screen.getByTestId("audit-row-dropped-toggle-audit-mi-dropped-expand"),
    ).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByTestId("audit-row-dropped-body-audit-mi-dropped-expand"),
    ).toBeInTheDocument();
    const droppedList = screen.getByTestId("memory-dropped-item-items");
    expect(droppedList).toBeInTheDocument();
    // Both the toggle button and the items-list header show "DROPPED ITEMS (2)";
    // assert via getAllByText so the duplicate is tolerated.
    expect(screen.getAllByText(/DROPPED ITEMS \(2\)/).length).toBeGreaterThanOrEqual(2);

    // Surviving canon row is rendered as a Memory Manager deep-link.
    const link = screen.getByTestId("memory-dropped-item-link-mem-canon-2");
    expect(link.getAttribute("href")).toBe("/memory#item-mem-canon-2");
    expect(link.textContent).toContain("Less-relevant canon");

    // Deleted scratchpad row resolves async to "no longer available".
    await waitFor(() =>
      expect(
        screen.getByTestId(
          "memory-dropped-item-missing-mem-scratch-deleted",
        ),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("memory-dropped-item-link-mem-scratch-deleted"),
    ).toBeNull();

    // Collapsing again removes the body so the audit feed stays compact.
    fireEvent.click(
      screen.getByTestId("audit-row-dropped-toggle-audit-mi-dropped-expand"),
    );
    expect(
      screen.queryByTestId("audit-row-dropped-body-audit-mi-dropped-expand"),
    ).toBeNull();
  });

  // ----- Task #96: dropped-items truncation hint -----

  it("Task #96: shows '(N of M)' on the toggle and an amber truncation hint when per-layer counters exceed dropped_items.length", async () => {
    // Per-layer counters say 25 items were dropped (20 canon + 5 scratchpad),
    // but the orchestrator only persisted 20 entries in dropped_items
    // (mirrors the DROPPED_TITLES_CAP=20 server-side cap). The toggle
    // should switch from "(20)" to "(20 of 25)" and the expanded body
    // should render the amber truncation hint with the same wording the
    // Task Detail "Memory used" panel uses.
    const truncatedRow = {
      ...memoryInjectedRow,
      id: "audit-mi-truncated",
      metadata: {
        ...memoryInjectedRow.metadata,
        canon_dropped: 20,
        continuity_dropped: 0,
        patches_dropped: 0,
        scratchpad_dropped: 5,
        dropped_items: Array.from({ length: 20 }, (_, i) => ({
          id: `mem-canon-d-${i}`,
          layer: "canon",
          title: `Less-relevant canon ${i}`,
        })),
      },
    };
    vi.stubGlobal(
      "fetch",
      makeFetch([truncatedRow], { memoryRows: [] }),
    );
    renderWithClient(<AuditLog />);
    await waitFor(() =>
      expect(
        screen.getByTestId("audit-row-toggle-audit-mi-truncated"),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("audit-row-toggle-audit-mi-truncated"));

    // Toggle counter switches to "(20 of 25)".
    const droppedToggle = screen.getByTestId(
      "audit-row-dropped-toggle-audit-mi-truncated",
    );
    expect(droppedToggle.textContent).toMatch(
      /SHOW DROPPED ITEMS \(20 of 25\)/,
    );

    // Truncation hint not rendered until the body is expanded.
    expect(
      screen.queryByTestId("audit-row-dropped-truncated-audit-mi-truncated"),
    ).toBeNull();

    fireEvent.click(droppedToggle);

    const hint = screen.getByTestId(
      "audit-row-dropped-truncated-audit-mi-truncated",
    );
    expect(hint.textContent).toMatch(
      /Showing first 20 of 25 dropped notes \(audit row caps per-layer dropped lists for cost reasons\)\./,
    );
  });

  it("Task #96: shows plain '(N)' on the toggle (no truncation hint) when per-layer counters match dropped_items.length", async () => {
    // Counters and array agree → no truncation, label stays "(2)" and the
    // amber hint is not rendered.
    const exactRow = {
      ...memoryInjectedRow,
      id: "audit-mi-exact",
      metadata: {
        ...memoryInjectedRow.metadata,
        canon_dropped: 1,
        continuity_dropped: 0,
        patches_dropped: 0,
        scratchpad_dropped: 1,
        dropped_items: [
          { id: "mem-canon-2", layer: "canon", title: "Less-relevant canon" },
          { id: "mem-scratch-1", layer: "scratchpad", title: "Old scratch" },
        ],
      },
    };
    vi.stubGlobal("fetch", makeFetch([exactRow], { memoryRows: [] }));
    renderWithClient(<AuditLog />);
    await waitFor(() =>
      expect(
        screen.getByTestId("audit-row-toggle-audit-mi-exact"),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("audit-row-toggle-audit-mi-exact"));

    const droppedToggle = screen.getByTestId(
      "audit-row-dropped-toggle-audit-mi-exact",
    );
    // Plain "(2)" — never "(2 of 2)".
    expect(droppedToggle.textContent).toMatch(/SHOW DROPPED ITEMS \(2\)/);
    expect(droppedToggle.textContent).not.toMatch(/of/);

    fireEvent.click(droppedToggle);

    expect(
      screen.queryByTestId("audit-row-dropped-truncated-audit-mi-exact"),
    ).toBeNull();
  });

  it("Task #96: defaults to plain '(N)' when per-layer counter fields are missing on a row that still has dropped_items (cannot infer truncation)", async () => {
    // Pre-#48 rows can carry dropped_items (e.g. via a backfill) without
    // the *_dropped numeric counters. We cannot infer truncation in that
    // case, so the toggle stays "(N)" and the amber hint is not shown.
    const noCountersRow = {
      ...memoryInjectedRow,
      id: "audit-mi-no-counters",
      metadata: {
        canon_items: 1,
        memory_context_chars: 100,
        injected_items: [
          { id: "mem-canon-1", layer: "canon", title: "BOS Safety Canon" },
        ],
        dropped_items: [
          { id: "mem-canon-2", layer: "canon", title: "Less-relevant canon" },
        ],
        // No canon_dropped / continuity_dropped / patches_dropped /
        // scratchpad_dropped fields.
      },
    };
    vi.stubGlobal("fetch", makeFetch([noCountersRow], { memoryRows: [] }));
    renderWithClient(<AuditLog />);
    await waitFor(() =>
      expect(
        screen.getByTestId("audit-row-toggle-audit-mi-no-counters"),
      ).toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByTestId("audit-row-toggle-audit-mi-no-counters"),
    );
    const droppedToggle = screen.getByTestId(
      "audit-row-dropped-toggle-audit-mi-no-counters",
    );
    expect(droppedToggle.textContent).toMatch(/SHOW DROPPED ITEMS \(1\)/);
    expect(droppedToggle.textContent).not.toMatch(/of/);

    fireEvent.click(droppedToggle);
    expect(
      screen.queryByTestId(
        "audit-row-dropped-truncated-audit-mi-no-counters",
      ),
    ).toBeNull();
  });

  it("does not render a DROPPED ITEMS section on legacy MEMORY_INJECTED rows recorded before Task #58 (no dropped_items field)", async () => {
    const legacyDropped = {
      ...memoryInjectedRow,
      id: "audit-mi-legacy-dropped",
      metadata: {
        canon_items: 1,
        canon_dropped: 3,
        memory_context_chars: 100,
        injected_items: [
          { id: "mem-canon-1", layer: "canon", title: "BOS Safety Canon" },
        ],
        // No dropped_items field → legacy row.
      },
    };
    vi.stubGlobal("fetch", makeFetch([legacyDropped], { memoryRows: [] }));
    renderWithClient(<AuditLog />);
    await waitFor(() =>
      expect(
        screen.getByTestId("audit-row-toggle-audit-mi-legacy-dropped"),
      ).toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByTestId("audit-row-toggle-audit-mi-legacy-dropped"),
    );

    expect(
      screen.getByTestId("audit-row-body-audit-mi-legacy-dropped"),
    ).toBeInTheDocument();
    // Existing injected items still render — no regression for #56.
    expect(screen.getByTestId("memory-injected-items")).toBeInTheDocument();
    // No dropped section / toggle / body.
    expect(
      screen.queryByTestId(
        "audit-row-dropped-section-audit-mi-legacy-dropped",
      ),
    ).toBeNull();
    expect(
      screen.queryByTestId(
        "audit-row-dropped-toggle-audit-mi-legacy-dropped",
      ),
    ).toBeNull();
    expect(
      screen.queryByTestId("audit-row-dropped-body-audit-mi-legacy-dropped"),
    ).toBeNull();
    // Raw metadata block still there so users see the dropped counts.
    expect(
      screen.getByTestId("audit-row-metadata-audit-mi-legacy-dropped"),
    ).toBeInTheDocument();
  });

  it("hides the items section on legacy MEMORY_INJECTED rows with no injected_items, but still shows raw metadata", async () => {
    const legacy = {
      ...memoryInjectedRow,
      id: "audit-legacy",
      metadata: {
        canon_items: 0,
        memory_context_chars: 0,
        // No injected_items field — simulates a row recorded before Task #50.
      },
    };
    vi.stubGlobal("fetch", makeFetch([legacy]));
    renderWithClient(<AuditLog />);
    await waitFor(() =>
      expect(
        screen.getByTestId("audit-row-toggle-audit-legacy"),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("audit-row-toggle-audit-legacy"));

    expect(
      screen.getByTestId("audit-row-body-audit-legacy"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("memory-injected-items")).toBeNull();
    expect(screen.queryByText(/ITEMS INJECTED/)).toBeNull();
    expect(
      screen.getByTestId("audit-row-metadata-audit-legacy"),
    ).toBeInTheDocument();
  });

  it("expands non-MEMORY_INJECTED rows to show their raw metadata only (no items list)", async () => {
    vi.stubGlobal("fetch", makeFetch([taskReceivedRow]));
    renderWithClient(<AuditLog />);
    await waitFor(() =>
      expect(
        screen.getByTestId("audit-row-toggle-audit-tr"),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("audit-row-toggle-audit-tr"));
    expect(screen.getByTestId("audit-row-body-audit-tr")).toBeInTheDocument();
    expect(
      screen.getByTestId("audit-row-metadata-audit-tr").textContent,
    ).toContain('"source": "web"');
    expect(screen.queryByTestId("memory-injected-items")).toBeNull();
  });

  it("does NOT make a /api/memory request when only non-MEMORY_INJECTED rows are expanded", async () => {
    const fetchSpy = makeFetch([taskReceivedRow]);
    vi.stubGlobal("fetch", fetchSpy);
    renderWithClient(<AuditLog />);
    await waitFor(() =>
      expect(
        screen.getByTestId("audit-row-toggle-audit-tr"),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("audit-row-toggle-audit-tr"));
    // Wait a tick so any react-query side effects have a chance to fire.
    await waitFor(() =>
      expect(screen.getByTestId("audit-row-body-audit-tr")).toBeInTheDocument(),
    );
    const memoryCalls = fetchSpy.mock.calls.filter((c) => {
      const url = typeof c[0] === "string" ? c[0] : (c[0] as URL).toString();
      return url.includes("/api/memory");
    });
    expect(memoryCalls.length).toBe(0);
  });

  it("renders rows with null metadata as non-expandable", async () => {
    vi.stubGlobal("fetch", makeFetch([noMetaRow]));
    renderWithClient(<AuditLog />);
    await waitFor(() =>
      expect(screen.getByTestId("audit-row-audit-nm")).toBeInTheDocument(),
    );
    // No toggle button, no body even after attempting interaction.
    expect(screen.queryByTestId("audit-row-toggle-audit-nm")).toBeNull();
    expect(screen.queryByTestId("audit-row-body-audit-nm")).toBeNull();
  });

  // ----- Task #72: pagination behaviour -----

  it("shows 'Load older entries' button with remaining count when more rows exist beyond the loaded window", async () => {
    // 200 rows in the loaded window, 350 total → 150 older still
    // available. We synthesise rows on the fly so the loaded count
    // tracks the requested limit.
    const synthRows = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `audit-${i}`,
        task_id: null,
        event_type: "TASK_COMPLETED",
        message: `row ${i}`,
        metadata: null,
        created_at: "2026-04-27T00:59:58.000Z",
      }));
    vi.stubGlobal(
      "fetch",
      makeFetch([], {
        total: 350,
        rowsForLimit: (limit) => synthRows(Math.min(limit, 350)),
      }),
    );
    renderWithClient(<AuditLog />);
    await waitFor(() =>
      expect(screen.getByTestId("audit-count").textContent).toContain(
        "showing 200 of 350",
      ),
    );
    expect(screen.getByTestId("audit-pagination-status").textContent).toContain(
      "150 older entries available",
    );
    const loadMore = screen.getByTestId("audit-load-more");
    expect(loadMore.textContent).toContain("Load 150 older entries");
  });

  it("grows the window when 'Load older entries' is clicked, refetching with a larger limit", async () => {
    const synthRows = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `audit-${i}`,
        task_id: null,
        event_type: "TASK_COMPLETED",
        message: `row ${i}`,
        metadata: null,
        created_at: "2026-04-27T00:59:58.000Z",
      }));
    const fetchSpy = makeFetch([], {
      total: 500,
      rowsForLimit: (limit) => synthRows(Math.min(limit, 500)),
    });
    vi.stubGlobal("fetch", fetchSpy);
    renderWithClient(<AuditLog />);
    await waitFor(() =>
      expect(screen.getByTestId("audit-count").textContent).toContain(
        "showing 200 of 500",
      ),
    );

    fireEvent.click(screen.getByTestId("audit-load-more"));

    await waitFor(() =>
      expect(screen.getByTestId("audit-count").textContent).toContain(
        "showing 400 of 500",
      ),
    );

    // The second request asked for limit=400 (200 + page size of 200).
    const limits = fetchSpy.mock.calls
      .map((c) => (typeof c[0] === "string" ? c[0] : (c[0] as URL).toString()))
      .filter((u) => u.includes("/api/audit"))
      .map((u) => new URL(u, "http://test").searchParams.get("limit"));
    expect(limits).toContain("200");
    expect(limits).toContain("400");
  });

  it("hides the 'Load older entries' button and reports 'Showing all entries' once the full log is loaded", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetch([taskReceivedRow, noMetaRow], { total: 2 }),
    );
    renderWithClient(<AuditLog />);
    await waitFor(() =>
      expect(screen.getByTestId("audit-count").textContent).toContain(
        "showing 2 of 2",
      ),
    );
    expect(screen.getByTestId("audit-pagination-status").textContent).toBe(
      "Showing all entries",
    );
    expect(screen.queryByTestId("audit-load-more")).toBeNull();
  });

  it("hides the pagination footer entirely when the log is empty", async () => {
    vi.stubGlobal("fetch", makeFetch([], { total: 0 }));
    renderWithClient(<AuditLog />);
    await waitFor(() =>
      expect(screen.getByText(/No audit entries yet/)).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("audit-pagination-status")).toBeNull();
    expect(screen.queryByTestId("audit-load-more")).toBeNull();
  });

  // ----- Task #107: host-command (PowerShell) rendering + filter chip -----
  //
  // Server side: POST /api/powershell writes POWERSHELL_EXECUTED on
  // success and POWERSHELL_FAILED on rejection (see
  // artifacts/api-server/src/routes/powershell.ts). The audit row carries
  //   - actor_user_id / actor_email / role / ip
  //   - command_preview (≤ 120 chars)
  //   - command_sha256
  //   - command_bytes (and output_bytes on success)
  //   - outcome ("ok" | "error") and `error` for failures
  // The audit-viewer must surface that summary inline (no expand click)
  // and let operators narrow the feed to PS rows only via a filter chip.

  const powerShellExecutedRow = {
    id: "audit-ps-ok",
    task_id: null,
    event_type: "POWERSHELL_EXECUTED",
    message: "super_admin ran PowerShell command",
    metadata: {
      actor_user_id: "user-1",
      actor_email: "ops@example.com",
      role: "super_admin",
      ip: "10.0.0.4",
      command_preview: "Get-Process | Select-Object -First 5",
      command_sha256:
        "deadbeefcafebabe0011223344556677deadbeefcafebabe0011223344556677",
      command_bytes: 38,
      output_bytes: 1024,
      outcome: "ok",
    },
    created_at: "2026-04-27T01:02:00.000Z",
  };

  const powerShellFailedRow = {
    id: "audit-ps-fail",
    task_id: null,
    event_type: "POWERSHELL_FAILED",
    message: "PowerShell command rejected",
    metadata: {
      actor_user_id: "user-1",
      actor_email: "ops@example.com",
      role: "super_admin",
      ip: "10.0.0.4",
      command_preview: "Stop-Computer -Force",
      command_sha256:
        "0011223344556677deadbeefcafebabe0011223344556677deadbeefcafebabe",
      command_bytes: 20,
      outcome: "error",
      error: "PowerShell exit code 1: not allowed",
    },
    created_at: "2026-04-27T01:01:00.000Z",
  };

  it("renders PowerShell rows with their distinct event-type colour and an inline summary visible without expanding the metadata blob", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetch([powerShellExecutedRow, powerShellFailedRow]),
    );
    renderWithClient(<AuditLog />);

    await waitFor(() =>
      expect(screen.getByTestId("audit-row-audit-ps-ok")).toBeInTheDocument(),
    );

    // Inline summary strips render for both rows without any user
    // interaction — the metadata blob stays collapsed by default.
    const okSummary = screen.getByTestId("powershell-summary-audit-ps-ok");
    const failSummary = screen.getByTestId("powershell-summary-audit-ps-fail");
    expect(okSummary).toBeInTheDocument();
    expect(failSummary).toBeInTheDocument();
    expect(screen.queryByTestId("audit-row-body-audit-ps-ok")).toBeNull();
    expect(screen.queryByTestId("audit-row-body-audit-ps-fail")).toBeNull();

    // Outcome badges call out OK vs FAILED in their respective colours.
    expect(
      screen.getByTestId("powershell-outcome-audit-ps-ok").textContent,
    ).toBe("OK");
    expect(
      screen.getByTestId("powershell-outcome-audit-ps-fail").textContent,
    ).toBe("FAILED");

    // Command preview, sha256, byte counts, and (success-only) stdout
    // bytes are visible in the summary strip without expanding metadata.
    expect(
      screen.getByTestId("powershell-preview-audit-ps-ok").textContent,
    ).toContain("Get-Process | Select-Object -First 5");
    expect(
      screen.getByTestId("powershell-sha256-audit-ps-ok").textContent,
    ).toContain("deadbeefcafe");
    expect(
      screen.getByTestId("powershell-cmd-bytes-audit-ps-ok").textContent,
    ).toContain("38 B");
    expect(
      screen.getByTestId("powershell-output-bytes-audit-ps-ok").textContent,
    ).toContain("1.0 KB");

    // FAILED row carries the redacted error message inline (no
    // output_bytes, since none was produced) and surfaces the command
    // preview so operators can see what was attempted.
    expect(
      screen.getByTestId("powershell-error-audit-ps-fail").textContent,
    ).toContain("PowerShell exit code 1: not allowed");
    expect(
      screen.getByTestId("powershell-preview-audit-ps-fail").textContent,
    ).toContain("Stop-Computer -Force");
    expect(
      screen.queryByTestId("powershell-output-bytes-audit-ps-fail"),
    ).toBeNull();

    // Row's event-type column gets the dedicated PowerShell colour
    // class so it stands out against TASK_RECEIVED / TASK_COMPLETED rows.
    const okToggle = screen.getByTestId("audit-row-toggle-audit-ps-ok");
    expect(okToggle.querySelector(".text-green-700")).not.toBeNull();
    const failToggle = screen.getByTestId("audit-row-toggle-audit-ps-fail");
    expect(failToggle.querySelector(".text-red-700")).not.toBeNull();

    // Terminal icon is rendered next to the event-type label so the
    // row type is recognisable at a glance — the leading-column
    // chevron is preserved for the open/closed expansion signal.
    expect(
      screen.getByTestId("powershell-icon-audit-ps-ok"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("powershell-icon-audit-ps-fail"),
    ).toBeInTheDocument();
  });

  it("filter chip narrows the visible rows to PowerShell events and the empty state explains why a non-empty log is showing zero rows", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetch([powerShellExecutedRow, taskReceivedRow, noMetaRow]),
    );
    renderWithClient(<AuditLog />);

    // All three rows render by default.
    await waitFor(() =>
      expect(screen.getByTestId("audit-row-audit-ps-ok")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("audit-row-audit-tr")).toBeInTheDocument();
    expect(screen.getByTestId("audit-row-audit-nm")).toBeInTheDocument();

    // Toggle on: only the PowerShell row remains visible.
    const chip = screen.getByTestId("audit-filter-powershell");
    expect(chip).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-pressed", "true");

    expect(screen.getByTestId("audit-row-audit-ps-ok")).toBeInTheDocument();
    expect(screen.queryByTestId("audit-row-audit-tr")).toBeNull();
    expect(screen.queryByTestId("audit-row-audit-nm")).toBeNull();

    // Header counter reflects the narrowed view but still mentions the
    // unfiltered loaded/total counts so the operator sees the full
    // audit volume.
    expect(screen.getByTestId("audit-count").textContent).toContain(
      "showing 1 PowerShell of 3 loaded",
    );

    // Toggle off: every row visible again.
    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("audit-row-audit-tr")).toBeInTheDocument();
    expect(screen.getByTestId("audit-row-audit-nm")).toBeInTheDocument();
  });

  it("filter-on with no PowerShell rows in the loaded window shows the filter-aware empty state, not the generic 'No audit entries yet'", async () => {
    vi.stubGlobal("fetch", makeFetch([taskReceivedRow, noMetaRow]));
    renderWithClient(<AuditLog />);

    await waitFor(() =>
      expect(screen.getByTestId("audit-row-audit-tr")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("audit-filter-powershell"));

    const empty = screen.getByTestId("audit-empty");
    expect(empty.textContent).toContain(
      "No PowerShell events in the loaded window.",
    );
    expect(empty.textContent).not.toContain("No audit entries yet");
  });

  it("PowerShell summary strip degrades gracefully when optional metadata fields are missing (e.g. legacy or trimmed rows)", async () => {
    // Bare-minimum POWERSHELL_EXECUTED row — only event_type + message.
    // Outcome should still default to OK (event-type implies success),
    // and missing fields should simply not render their respective slot
    // rather than crash the page.
    const sparseRow = {
      id: "audit-ps-sparse",
      task_id: null,
      event_type: "POWERSHELL_EXECUTED",
      message: "super_admin ran PowerShell command",
      metadata: {},
      created_at: "2026-04-27T01:03:00.000Z",
    };
    vi.stubGlobal("fetch", makeFetch([sparseRow]));
    renderWithClient(<AuditLog />);

    await waitFor(() =>
      expect(
        screen.getByTestId("powershell-summary-audit-ps-sparse"),
      ).toBeInTheDocument(),
    );

    expect(
      screen.getByTestId("powershell-outcome-audit-ps-sparse").textContent,
    ).toBe("OK");
    expect(screen.queryByTestId("powershell-preview-audit-ps-sparse")).toBeNull();
    expect(screen.queryByTestId("powershell-sha256-audit-ps-sparse")).toBeNull();
    expect(
      screen.queryByTestId("powershell-cmd-bytes-audit-ps-sparse"),
    ).toBeNull();
    expect(
      screen.queryByTestId("powershell-output-bytes-audit-ps-sparse"),
    ).toBeNull();
  });
});
