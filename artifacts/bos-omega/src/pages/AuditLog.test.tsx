import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuditLog } from "./AuditLog";

// Test plan covers Task #56:
//  - MEMORY_INJECTED rows are expandable from the global Audit Log page
//  - Expanding renders the same per-item provenance UI as the Task Detail
//    "Memory used" panel (clickable layer-coloured chips, deep-links to
//    `/memory#item-<id>`, "no longer available" markers for deleted rows)
//  - Non-MEMORY_INJECTED rows with metadata are still expandable and show
//    the raw JSON metadata block (so this view doesn't regress for
//    USER_CREATED, OVERRIDE_APPLIED, etc.)
//  - Rows with null metadata are NOT expandable

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

function makeFetch(rows: unknown[], memoryRows?: unknown[]) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/audit")) {
      return Promise.resolve(
        new Response(JSON.stringify(rows), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (url.includes("/api/memory")) {
      return Promise.resolve(
        new Response(JSON.stringify(memoryRows ?? []), {
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
      makeFetch(
        [memoryInjectedRow],
        [
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
      ),
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
    vi.stubGlobal("fetch", makeFetch([memoryInjectedRow], []));
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
});
