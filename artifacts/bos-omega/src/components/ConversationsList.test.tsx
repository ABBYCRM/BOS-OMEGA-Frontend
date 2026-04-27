/**
 * Task #68 — Component test for the production ConversationsList sidebar.
 *
 * Covers the UX contract called out in the task spec:
 *   - Renders the section header + a "New" link that goes to
 *     /console?new=1 (so the next submit on TaskConsole forces a fresh
 *     conversation, not a Jaccard auto-merge).
 *   - Renders a search input that, when typed into, drives a debounced
 *     refetch with the `q=` query param hitting GET /api/conversations.
 *   - Renders each conversation row with its title and a relative
 *     "last active" timestamp (data-testid `text-conversation-stamp-…`).
 *   - The Conversations section is collapsible — clicking the header
 *     hides the search and the rows.
 *   - The pure helper `formatRelativeTimestamp` returns the expected
 *     compact strings ("now", "5m", "3h", "2d", "1w", "4mo", "2y").
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";

import { ConversationsList, formatRelativeTimestamp } from "./ConversationsList";

const baseRow = {
  user_id: "u1",
  topic_keywords: ["alpha", "beta"],
  created_at: "2026-04-27T00:00:00.000Z",
  last_active_at: new Date(Date.now() - 5 * 60_000).toISOString(),
  archived: false,
};

function renderInProviders() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Router>
        <ConversationsList />
      </Router>
    </QueryClientProvider>,
  );
}

describe("formatRelativeTimestamp", () => {
  const NOW = new Date("2026-04-27T12:00:00.000Z");

  it.each([
    ["now",  new Date(NOW.getTime() - 30 * 1000).toISOString()],
    ["5m",   new Date(NOW.getTime() - 5 * 60_000).toISOString()],
    ["3h",   new Date(NOW.getTime() - 3 * 3600_000).toISOString()],
    ["2d",   new Date(NOW.getTime() - 2 * 86_400_000).toISOString()],
    ["1w",   new Date(NOW.getTime() - 8 * 86_400_000).toISOString()],
    ["4mo",  new Date(NOW.getTime() - 130 * 86_400_000).toISOString()],
    ["2y",   new Date(NOW.getTime() - 800 * 86_400_000).toISOString()],
  ])("returns %s for the matching interval", (expected, iso) => {
    expect(formatRelativeTimestamp(iso, NOW)).toBe(expected);
  });

  it("returns empty string for an unparseable timestamp", () => {
    expect(formatRelativeTimestamp("not-a-date")).toBe("");
  });
});

describe("ConversationsList (production sidebar component)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function mockConversations(rows: Array<{ id: string; title: string }>) {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        conversations: rows.map((r) => ({ ...baseRow, ...r })),
      }),
    });
  }

  it("renders section header, '+ New' link to /console?new=1, and the search input", async () => {
    mockConversations([{ id: "c1", title: "Alpha" }]);
    renderInProviders();

    const newBtn = screen.getByTestId("button-new-conversation");
    expect(newBtn.closest("a")?.getAttribute("href")).toBe("/console?new=1");

    expect(screen.getByTestId("input-conversation-search")).toBeTruthy();
    expect(screen.getByTestId("button-toggle-conversations")).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByTestId("nav-conversation-c1")).toBeTruthy();
    });
  });

  it("renders each conversation with its title and a relative last-active stamp", async () => {
    mockConversations([
      { id: "c1", title: "Alpha thread" },
      { id: "c2", title: "Beta thread" },
    ]);
    renderInProviders();

    await waitFor(() => {
      expect(screen.getByTestId("nav-conversation-c1")).toBeTruthy();
      expect(screen.getByTestId("nav-conversation-c2")).toBeTruthy();
    });
    expect(screen.getByText("Alpha thread")).toBeTruthy();
    expect(screen.getByText("Beta thread")).toBeTruthy();
    // The 5-min-old fixture renders as "5m".
    expect(screen.getByTestId("text-conversation-stamp-c1").textContent).toBe("5m");
  });

  it("debounces the search input and refetches with the q= param", async () => {
    mockConversations([{ id: "c1", title: "Alpha" }]);
    renderInProviders();

    await waitFor(() => {
      expect(screen.getByTestId("nav-conversation-c1")).toBeTruthy();
    });
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    const initialCalls = fetchMock.mock.calls.length;

    const input = screen.getByTestId("input-conversation-search") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "needle" } });

    // Before debounce fires, no extra fetch.
    expect(fetchMock.mock.calls.length).toBe(initialCalls);

    // Advance past the 200ms debounce.
    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(initialCalls);
    });
    const lastUrl = String(fetchMock.mock.calls.at(-1)![0]);
    expect(lastUrl).toContain("q=needle");
    expect(lastUrl).toContain("archived=false");
  });

  it("collapses the section when the header is clicked", async () => {
    mockConversations([{ id: "c1", title: "Alpha" }]);
    renderInProviders();

    await waitFor(() => {
      expect(screen.getByTestId("nav-conversation-c1")).toBeTruthy();
    });
    const toggle = screen.getByTestId("button-toggle-conversations");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("input-conversation-search")).toBeNull();
    expect(screen.queryByTestId("nav-conversation-c1")).toBeNull();
  });

  it("shows 'No matches.' when a search yields zero results", async () => {
    // First call (empty query) returns 1 row; second (q=zzz) returns 0.
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ conversations: [{ ...baseRow, id: "c1", title: "Alpha" }] }),
      })
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ conversations: [] }),
      });
    renderInProviders();

    await waitFor(() => {
      expect(screen.getByTestId("nav-conversation-c1")).toBeTruthy();
    });

    fireEvent.change(screen.getByTestId("input-conversation-search"), {
      target: { value: "zzz" },
    });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    await waitFor(() => {
      expect(screen.getByTestId("conversations-empty").textContent).toContain("No matches.");
    });
  });
});
