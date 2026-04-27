import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ActivePersonaPanel } from "./ActivePersonaPanel";

// Synthetic TASK_RECEIVED audit row matching the orchestrator-emitted
// metadata shape from artifacts/api-server/src/bos/pipeline.ts (Task #57:
// persona_slot + persona_title are recorded on this event).
const taskReceivedWithPersona = {
  id: "audit-0",
  event_type: "TASK_RECEIVED",
  message: "Task received by BOS-OMEGA",
  metadata: {
    mode: "single",
    input_length: 42,
    persona_slot: "A" as const,
    persona_title: "Legal Counsel",
  },
  created_at: "2026-04-27T01:00:00.000Z",
};

const taskReceivedNoPersona = {
  id: "audit-0",
  event_type: "TASK_RECEIVED",
  message: "Task received by BOS-OMEGA",
  metadata: {
    mode: "single",
    input_length: 42,
    persona_slot: null,
    persona_title: null,
  },
  created_at: "2026-04-27T01:00:00.000Z",
};

const noiseEntry = {
  id: "audit-noise",
  event_type: "MEMORY_INJECTED",
  message: "memory built",
  metadata: { canon_items: 0 },
  created_at: "2026-04-27T01:00:01.000Z",
};

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function stubPersonas(rows: Array<{ slot: "A"|"B"|"C"; id: string|null; title: string; content: string; updated_at?: string | null }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/personas")) {
        return Promise.resolve(
          new Response(JSON.stringify(rows), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }),
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

describe("ActivePersonaPanel", () => {
  it("renders nothing when audit has no TASK_RECEIVED entry", () => {
    const { container } = renderWithClient(<ActivePersonaPanel audit={[noiseEntry]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when TASK_RECEIVED has no persona slot", () => {
    const { container } = renderWithClient(
      <ActivePersonaPanel audit={[taskReceivedNoPersona, noiseEntry]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders the slot label and a link when the persona slot still matches", async () => {
    stubPersonas([
      // updated_at is BEFORE the task time so the slot wasn't touched
      // after the task ran.
      { slot: "A", id: "p-a", title: "Legal Counsel", content: "act as a lawyer...", updated_at: "2026-04-26T12:00:00.000Z" },
      { slot: "B", id: "p-b", title: "Persona B", content: "" },
      { slot: "C", id: "p-c", title: "Persona C", content: "" },
    ]);
    renderWithClient(<ActivePersonaPanel audit={[taskReceivedWithPersona]} />);

    expect(screen.getByTestId("active-persona-panel")).toBeInTheDocument();
    // Slot label is shown.
    expect(screen.getByTestId("active-persona-slot-label").textContent).toMatch(/SLOT:\s*A/);

    // While loading the personas list we render the link optimistically.
    const link = await screen.findByTestId("active-persona-link");
    expect(link).toBeInTheDocument();
    expect(link.getAttribute("href")).toBe("/console#persona-slot-A");
    expect(link.textContent).toContain("Legal Counsel");

    // No "no longer available" marker once we confirm the slot still matches.
    await waitFor(() => {
      expect(screen.queryByTestId("active-persona-missing")).toBeNull();
    });
  });

  it('shows "no longer available" when the live slot title was edited', async () => {
    stubPersonas([
      { slot: "A", id: "p-a", title: "Different Title Now", content: "still has content", updated_at: "2026-04-27T03:00:00.000Z" },
      { slot: "B", id: "p-b", title: "Persona B", content: "" },
      { slot: "C", id: "p-c", title: "Persona C", content: "" },
    ]);
    renderWithClient(<ActivePersonaPanel audit={[taskReceivedWithPersona]} />);

    // The "missing" marker only appears after the live persona list resolves
    // and we detect the title mismatch.
    const missing = await screen.findByTestId("active-persona-missing");
    expect(missing).toBeInTheDocument();
    expect(missing.textContent).toContain("Legal Counsel");
    expect(missing.textContent).toContain("no longer available");
    // Importantly, no broken link is rendered.
    expect(screen.queryByTestId("active-persona-link")).toBeNull();
  });

  // === Task #57 review fix: timestamp-based staleness ===
  it('shows "no longer available" when only the content was edited after the task ran (title unchanged)', async () => {
    // Title still matches, but updated_at is AFTER the task's created_at —
    // the persona overlay that ran for this task no longer matches the
    // current slot, so the link must NOT render.
    stubPersonas([
      {
        slot: "A",
        id: "p-a",
        title: "Legal Counsel", // same title as recorded
        content: "rewritten instruction",
        updated_at: "2026-04-27T05:00:00.000Z", // AFTER taskReceivedWithPersona at 01:00
      },
      { slot: "B", id: "p-b", title: "Persona B", content: "" },
      { slot: "C", id: "p-c", title: "Persona C", content: "" },
    ]);
    renderWithClient(<ActivePersonaPanel audit={[taskReceivedWithPersona]} />);

    const missing = await screen.findByTestId("active-persona-missing");
    expect(missing).toBeInTheDocument();
    expect(missing.textContent).toContain("Legal Counsel");
    expect(missing.textContent).toContain("no longer available");
    expect(screen.queryByTestId("active-persona-link")).toBeNull();
  });

  it('still renders a live link when the slot was edited BEFORE the task ran', async () => {
    // Sanity check on the timestamp gate: an update strictly before the
    // task time should not flip the panel to "no longer available".
    stubPersonas([
      {
        slot: "A",
        id: "p-a",
        title: "Legal Counsel",
        content: "act as a lawyer...",
        updated_at: "2026-04-25T00:00:00.000Z", // before the task
      },
    ]);
    renderWithClient(<ActivePersonaPanel audit={[taskReceivedWithPersona]} />);

    const link = await screen.findByTestId("active-persona-link");
    expect(link.getAttribute("href")).toBe("/console#persona-slot-A");
    expect(screen.queryByTestId("active-persona-missing")).toBeNull();
  });

  it('shows "no longer available" when the live slot was cleared (no row, empty content)', async () => {
    stubPersonas([
      // A row missing entirely → usePersonas returns the fallback view with id=null, content="".
      { slot: "B", id: "p-b", title: "Persona B", content: "" },
      { slot: "C", id: "p-c", title: "Persona C", content: "" },
    ]);
    renderWithClient(<ActivePersonaPanel audit={[taskReceivedWithPersona]} />);

    const missing = await screen.findByTestId("active-persona-missing");
    expect(missing).toBeInTheDocument();
    expect(screen.queryByTestId("active-persona-link")).toBeNull();
  });

  it("uses the most recent TASK_RECEIVED when there are multiple", async () => {
    stubPersonas([
      { slot: "B", id: "p-b", title: "Risk Officer", content: "be conservative", updated_at: "2026-04-27T00:00:00.000Z" },
    ]);
    const earlier = {
      ...taskReceivedWithPersona,
      id: "audit-early",
      created_at: "2026-04-27T00:00:00.000Z",
    };
    const later = {
      ...taskReceivedWithPersona,
      id: "audit-late",
      metadata: { persona_slot: "B" as const, persona_title: "Risk Officer" },
      created_at: "2026-04-27T02:00:00.000Z",
    };
    renderWithClient(<ActivePersonaPanel audit={[earlier, later]} />);
    expect(screen.getByTestId("active-persona-slot-label").textContent).toMatch(/SLOT:\s*B/);
    const link = await screen.findByTestId("active-persona-link");
    expect(link.getAttribute("href")).toBe("/console#persona-slot-B");
    expect(link.textContent).toContain("Risk Officer");
  });

  it("ignores malformed persona metadata (non-A/B/C slot)", () => {
    const garbled = {
      ...taskReceivedWithPersona,
      metadata: { persona_slot: "Z", persona_title: "garbage" },
    };
    const { container } = renderWithClient(<ActivePersonaPanel audit={[garbled]} />);
    expect(container.firstChild).toBeNull();
  });
});
