import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  MemoryInjectedItemsList,
  parseInjectedItems,
} from "./MemoryInjectedItemsList";

// Each test gets a fresh QueryClient so cached responses from one case
// can't leak into another. retry: false stops failure cases from spinning.
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
    vi.fn(() => Promise.reject(new Error("unmocked fetch call"))),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseInjectedItems", () => {
  it("returns [] for non-array input", () => {
    expect(parseInjectedItems(null)).toEqual([]);
    expect(parseInjectedItems(undefined)).toEqual([]);
    expect(parseInjectedItems("nope")).toEqual([]);
    expect(parseInjectedItems({ id: "x", layer: "canon", title: "t" })).toEqual([]);
  });

  it("filters out malformed entries", () => {
    const out = parseInjectedItems([
      { id: "a", layer: "canon", title: "ok" },
      { id: "b", layer: "canon" }, // missing title
      { id: 123, layer: "canon", title: "bad id" }, // wrong id type
      null,
      { id: "c", layer: "scratchpad", title: "ok2" },
    ]);
    expect(out).toEqual([
      { id: "a", layer: "canon", title: "ok" },
      { id: "c", layer: "scratchpad", title: "ok2" },
    ]);
  });
});

describe("MemoryInjectedItemsList", () => {
  it("renders nothing when items is empty", () => {
    const { container } = renderWithClient(
      <MemoryInjectedItemsList items={[]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders one row per item with deep-links and marks deleted rows as unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/memory")) {
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
              ]),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
          );
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      }),
    );

    renderWithClient(
      <MemoryInjectedItemsList
        items={[
          { id: "mem-canon-1", layer: "canon", title: "BOS Safety Canon" },
          { id: "mem-deleted", layer: "scratchpad", title: "Old note" },
        ]}
      />,
    );

    expect(screen.getByText(/ITEMS INJECTED \(2\)/)).toBeInTheDocument();
    const link = screen.getByTestId("memory-injected-link-mem-canon-1");
    expect(link.getAttribute("href")).toBe("/memory#item-mem-canon-1");
    expect(link.textContent).toContain("BOS Safety Canon");

    await waitFor(() => {
      expect(
        screen.getByTestId("memory-injected-missing-mem-deleted"),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByTestId("memory-injected-link-mem-deleted"),
    ).toBeNull();
  });

  it("does NOT fetch when enabled=false", () => {
    const fetchSpy = vi.fn(() =>
      Promise.reject(new Error("should not be called")),
    );
    vi.stubGlobal("fetch", fetchSpy);

    renderWithClient(
      <MemoryInjectedItemsList
        items={[{ id: "mem-1", layer: "canon", title: "x" }]}
        enabled={false}
      />,
    );

    // List still renders synchronously off the items prop.
    expect(screen.getByText(/ITEMS INJECTED \(1\)/)).toBeInTheDocument();
    // But no /api/memory request was made.
    expect(fetchSpy).not.toHaveBeenCalled();
    // With no live data and no error, item renders as an optimistic link.
    expect(screen.getByTestId("memory-injected-link-mem-1")).toBeInTheDocument();
  });

  it("shows the 'couldn't verify items' notice when the live lookup errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network down"))),
    );

    renderWithClient(
      <MemoryInjectedItemsList
        items={[{ id: "mem-canon-1", layer: "canon", title: "BOS Safety Canon" }]}
      />,
    );

    // Item still renders optimistically.
    expect(
      screen.getByTestId("memory-injected-link-mem-canon-1"),
    ).toBeInTheDocument();
    // Notice surfaces once the query errors.
    await waitFor(() => {
      expect(
        screen.getByTestId("memory-injected-lookup-failed"),
      ).toBeInTheDocument();
    });
  });
});
