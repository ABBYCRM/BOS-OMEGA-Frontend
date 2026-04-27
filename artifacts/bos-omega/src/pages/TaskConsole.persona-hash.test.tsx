import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { TaskConsole } from "./TaskConsole";

// Task #57 integration coverage:
//   - The Task Detail "Active persona" panel deep-links to
//     `/console#persona-slot-X`. TaskConsole must wait for the personas
//     query to resolve before opening the editor — otherwise the editor
//     would receive `usePersonas()`'s synthetic fallback row (id=null,
//     empty content) and a save would clobber a phantom record.
//   - After resolution, the editor opens against the canonical row
//     (real title + content from the API response).
//   - The hash is consumed exactly once so a manual close + refresh
//     doesn't reopen the dialog.

function makeFetch(opts: { personas?: unknown[]; personasDelayMs?: number; failPersonas?: boolean } = {}) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/personas")) {
      if (opts.failPersonas) {
        return Promise.resolve(
          new Response("server error", { status: 500 }),
        );
      }
      const body = JSON.stringify(opts.personas ?? []);
      const respond = () =>
        new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
      if (opts.personasDelayMs && opts.personasDelayMs > 0) {
        return new Promise((resolve) => {
          setTimeout(() => resolve(respond()), opts.personasDelayMs);
        });
      }
      return Promise.resolve(respond());
    }
    if (url.includes("/api/tasks/stats")) {
      return Promise.resolve(
        new Response(JSON.stringify({ total: 0, by_status: {}, by_type: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (url.includes("/api/conversations/")) {
      return Promise.resolve(
        new Response(JSON.stringify({ conversation: { id: "c-1", title: "x", archived: false }, tasks: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    // Anything else this page touches incidentally — fail loud so tests
    // don't silently pass against unstubbed network calls.
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

function renderConsole() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Router base="">
        <TaskConsole />
      </Router>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  // Default: fail loudly so tests that forget to stub fetches break.
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("unmocked fetch"))));
  // Reset hash between tests so leakage doesn't change behaviour.
  window.history.replaceState({}, "", "/console");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TaskConsole — persona deep-link (Task #57)", () => {
  it("opens the editor with the canonical slot row after personas load", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetch({
        personas: [
          { slot: "A", id: "p-a", title: "Legal Counsel", content: "act as a lawyer..." },
          { slot: "B", id: "p-b", title: "Persona B", content: "" },
          { slot: "C", id: "p-c", title: "Persona C", content: "" },
        ],
      }),
    );

    // Set the deep-link hash before mount so the initial effect run sees it.
    window.history.replaceState({}, "", "/console#persona-slot-A");

    renderConsole();

    // The editor must show the CANONICAL title that came back from the API
    // (not the "Persona A" fallback that usePersonas synthesises before
    // the network resolves).
    const titleInput = await screen.findByTestId("input-persona-title-A");
    await waitFor(() => {
      expect((titleInput as HTMLInputElement).value).toBe("Legal Counsel");
    });
    const contentInput = screen.getByTestId("input-persona-content-A") as HTMLTextAreaElement;
    expect(contentInput.value).toBe("act as a lawyer...");

    // The hash must be consumed so a refresh wouldn't re-open the dialog.
    expect(window.location.hash).toBe("");
  });

  it("does NOT open the editor with fallback data while personas are still loading", async () => {
    // 50ms delayed personas response — the effect's first run must NOT
    // open the editor against the synthetic fallback row.
    vi.stubGlobal(
      "fetch",
      makeFetch({
        personasDelayMs: 50,
        personas: [
          { slot: "A", id: "p-a", title: "Risk Officer", content: "be conservative" },
        ],
      }),
    );

    window.history.replaceState({}, "", "/console#persona-slot-A");

    renderConsole();

    // While the request is in flight the editor must NOT have rendered.
    expect(screen.queryByTestId("input-persona-title-A")).toBeNull();
    // The hash must still be present so the next effect run after data
    // arrives can act on it.
    expect(window.location.hash).toBe("#persona-slot-A");

    // Once the response lands, the editor opens against the live row.
    const titleInput = await screen.findByTestId("input-persona-title-A");
    await waitFor(() => {
      expect((titleInput as HTMLInputElement).value).toBe("Risk Officer");
    });
    expect(window.location.hash).toBe("");
  });

  it("ignores the deep-link when the matched slot has no live row (id=null)", async () => {
    // Empty list → usePersonas returns synthetic fallbacks for A/B/C with
    // id=null. The effect must bail rather than open against a phantom
    // row a save would later clobber.
    vi.stubGlobal("fetch", makeFetch({ personas: [] }));

    window.history.replaceState({}, "", "/console#persona-slot-A");
    renderConsole();

    // Wait for persona query to resolve.
    await waitFor(() => {
      // The persona quick-launch UI is rendered with the fallback titles,
      // confirming usePersonas resolved.
      expect(screen.getByTestId("button-persona-a")).toBeInTheDocument();
    });

    // Editor must NOT have been opened.
    expect(screen.queryByTestId("input-persona-title-A")).toBeNull();
    // The hash is preserved (no consumption on a no-op).
    expect(window.location.hash).toBe("#persona-slot-A");
  });

  it("ignores an unrelated hash and leaves it intact", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetch({
        personas: [
          { slot: "A", id: "p-a", title: "Legal Counsel", content: "..." },
        ],
      }),
    );
    window.history.replaceState({}, "", "/console#item-mem-abc");

    renderConsole();

    await waitFor(() => {
      expect(screen.getByTestId("button-persona-a")).toBeInTheDocument();
    });

    expect(screen.queryByTestId("input-persona-title-A")).toBeNull();
    expect(window.location.hash).toBe("#item-mem-abc");
  });

  it("re-opens the editor on hashchange when the link is clicked again", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetch({
        personas: [
          { slot: "A", id: "p-a", title: "Legal Counsel", content: "first content" },
          { slot: "B", id: "p-b", title: "Compliance Lead", content: "second content" },
        ],
      }),
    );

    window.history.replaceState({}, "", "/console#persona-slot-A");
    renderConsole();

    const titleInputA = await screen.findByTestId("input-persona-title-A");
    await waitFor(() => {
      expect((titleInputA as HTMLInputElement).value).toBe("Legal Counsel");
    });
    expect(window.location.hash).toBe("");

    // Simulate the user navigating back to the deep-link for slot B.
    act(() => {
      window.history.replaceState({}, "", "/console#persona-slot-B");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });

    const titleInputB = await screen.findByTestId("input-persona-title-B");
    await waitFor(() => {
      expect((titleInputB as HTMLInputElement).value).toBe("Compliance Lead");
    });
    expect(window.location.hash).toBe("");
  });
});
