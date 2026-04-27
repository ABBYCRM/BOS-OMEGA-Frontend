import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LatticeMenu } from "./LatticeMenu";

// Resolve the menu trigger by either its current testid or any future
// rename — the production code uses "lattice-menu-button" but earlier
// drafts used "lattice-menu-trigger". This shim keeps the test stable
// across either spelling so a renaming refactor doesn't silently
// invalidate the test.
function getTrigger() {
  return (
    screen.queryByTestId("lattice-menu-button") ??
    getTrigger()
  );
}

// Helper that renders the menu with a fresh QueryClient. retry:false so
// failing fetch mocks fail-fast instead of spinning. Also stubs
// matchMedia (some shadcn primitives reach for it on mount) and the
// clipboard surface — the export modal uses navigator.clipboard with a
// textarea/execCommand fallback (mirrored from MemoryUsedPanel) and we
// want to assert the primary path.
function renderWithClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LatticeMenu />
    </QueryClientProvider>,
  );
}

const SAMPLE_BLOB = "# MEMORY LATTICE\n```MEMORY_LATTICE_V1\n{\"format_version\":\"1.0\"}\n```\n";

const EXPORT_RESPONSE = {
  blob: SAMPLE_BLOB,
  hash: "abc123def456",
  exported_at: "2026-04-27T12:00:00.000Z",
  format_version: "1.0",
  task_count: 7,
  byte_size: SAMPLE_BLOB.length,
  source_session_id: "11111111-2222-3333-4444-555555555555",
};

const PREVIEW_RESPONSE = {
  dry_run: true,
  preview: { canon: 2, continuity: 5, patches: 1, scratchpad: 3, conversations: 1, tasks: 7 },
  skipped: 0,
  source_session_id: "11111111-2222-3333-4444-555555555555",
  conversation_title: "Imported from 11111111",
  fidelity_sha256: "abc123def456",
};

const COMMIT_RESPONSE = {
  imported: { canon: 0, continuity: 5, patches: 1, scratchpad: 3, conversations: 1, tasks: 7 },
  skipped: 2,
  source_session_id: "11111111-2222-3333-4444-555555555555",
  conversation_id: "deadbeef-aaaa-bbbb-cccc-000000000000",
  fidelity_sha256: "abc123def456",
};

beforeEach(() => {
  // jsdom doesn't ship matchMedia; some Radix primitives crash without it.
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((q: string) => ({
      matches: false, media: q, onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  // Default fetch is loud-fail so any unmocked path is obvious.
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

describe("LatticeMenu", () => {
  it("renders the trigger button collapsed by default", () => {
    renderWithClient();
    expect(getTrigger()).toBeInTheDocument();
    expect(screen.queryByTestId("lattice-menu-popover")).not.toBeInTheDocument();
  });

  it("opens a popover with Export and Import actions", () => {
    renderWithClient();
    fireEvent.click(getTrigger());
    expect(screen.getByTestId("lattice-menu-popover")).toBeInTheDocument();
    expect(screen.getByTestId("lattice-menu-export")).toBeInTheDocument();
    expect(screen.getByTestId("lattice-menu-import")).toBeInTheDocument();
  });

  describe("Export modal", () => {
    it("fetches the blob and exposes Copy + Download controls", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string) => {
          if (url.startsWith("/api/lattice/export")) {
            return Promise.resolve({
              ok: true, status: 200,
              json: () => Promise.resolve(EXPORT_RESPONSE),
            } as Response);
          }
          return Promise.reject(new Error(`unexpected fetch ${url}`));
        }),
      );

      renderWithClient();
      fireEvent.click(getTrigger());
      fireEvent.click(screen.getByTestId("lattice-menu-export"));

      // Modal mounts immediately and fetches; wait for the blob to land
      // in the readonly textarea so we know the request settled.
      const ta = await screen.findByTestId("lattice-export-textarea");
      await waitFor(() => expect(ta).toHaveValue(SAMPLE_BLOB));
      expect(screen.getByTestId("lattice-export-copy")).toBeInTheDocument();
      expect(screen.getByTestId("lattice-export-download")).toBeInTheDocument();
    });

    it("Copy button writes the blob to the clipboard via navigator.clipboard", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve({
            ok: true, status: 200,
            json: () => Promise.resolve(EXPORT_RESPONSE),
          } as Response),
        ),
      );
      const writeText = vi.fn(() => Promise.resolve());
      Object.assign(navigator, { clipboard: { writeText } });

      renderWithClient();
      fireEvent.click(getTrigger());
      fireEvent.click(screen.getByTestId("lattice-menu-export"));
      await screen.findByTestId("lattice-export-textarea");

      fireEvent.click(screen.getByTestId("lattice-export-copy"));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(SAMPLE_BLOB));
    });
  });

  describe("Import modal — two-step Verify → Confirm flow", () => {
    it("requires Verify before Confirm is reachable (preview gates commit)", async () => {
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        // The test must NEVER see a non-dry-run import unless the user
        // clicks Confirm. We assert order by inspecting the URL on the
        // first call.
        if (url === "/api/lattice/import?dry_run=1") {
          return Promise.resolve({
            ok: true, status: 200,
            json: () => Promise.resolve(PREVIEW_RESPONSE),
          } as Response);
        }
        if (url === "/api/lattice/import") {
          return Promise.resolve({
            ok: true, status: 200,
            json: () => Promise.resolve(COMMIT_RESPONSE),
          } as Response);
        }
        return Promise.reject(new Error(`unexpected ${init?.method ?? "GET"} ${url}`));
      });
      vi.stubGlobal("fetch", fetchMock);

      renderWithClient();
      fireEvent.click(getTrigger());
      fireEvent.click(screen.getByTestId("lattice-menu-import"));

      // Stage 1 (paste). Confirm button must NOT be present yet.
      expect(screen.getByTestId("lattice-import-stage-paste")).toBeInTheDocument();
      expect(screen.queryByTestId("lattice-import-confirm")).not.toBeInTheDocument();

      const ta = screen.getByTestId("lattice-import-textarea");
      fireEvent.change(ta, { target: { value: SAMPLE_BLOB } });
      fireEvent.click(screen.getByTestId("lattice-import-verify"));

      // Stage 2 (preview). The first fetch must have been the dry_run.
      const previewSection = await screen.findByTestId("lattice-import-stage-preview");
      expect(previewSection).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [firstUrl] = fetchMock.mock.calls[0]!;
      expect(firstUrl).toBe("/api/lattice/import?dry_run=1");

      // Preview meta + per-layer counts are rendered.
      expect(screen.getByTestId("lattice-import-preview-meta")).toBeInTheDocument();
      expect(within(screen.getByTestId("lattice-import-preview-canon")).getByText("2")).toBeInTheDocument();
      expect(within(screen.getByTestId("lattice-import-preview-continuity")).getByText("5")).toBeInTheDocument();
      expect(within(screen.getByTestId("lattice-import-preview-tasks")).getByText("7")).toBeInTheDocument();

      // The textarea is hidden in preview stage so the user can't mutate
      // the blob between verify and confirm.
      expect(screen.queryByTestId("lattice-import-textarea")).not.toBeInTheDocument();

      // Confirm commit.
      fireEvent.click(screen.getByTestId("lattice-import-confirm"));
      await screen.findByTestId("lattice-import-result");

      // Second fetch must be the non-dry-run commit, with the same blob.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [secondUrl, secondInit] = fetchMock.mock.calls[1]!;
      expect(secondUrl).toBe("/api/lattice/import");
      expect(JSON.parse((secondInit as RequestInit).body as string)).toEqual({ blob: SAMPLE_BLOB });

      // Result panel shows the actual (committed) counts, not the preview.
      expect(within(screen.getByTestId("lattice-import-count-canon")).getByText("0")).toBeInTheDocument();
      expect(within(screen.getByTestId("lattice-import-count-tasks")).getByText("7")).toBeInTheDocument();
    });

    it("Back to edit returns to paste stage and preserves text", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve({
            ok: true, status: 200,
            json: () => Promise.resolve(PREVIEW_RESPONSE),
          } as Response),
        ),
      );

      renderWithClient();
      fireEvent.click(getTrigger());
      fireEvent.click(screen.getByTestId("lattice-menu-import"));

      fireEvent.change(screen.getByTestId("lattice-import-textarea"), {
        target: { value: SAMPLE_BLOB },
      });
      fireEvent.click(screen.getByTestId("lattice-import-verify"));
      await screen.findByTestId("lattice-import-stage-preview");

      fireEvent.click(screen.getByTestId("lattice-import-back"));
      const ta = await screen.findByTestId("lattice-import-textarea");
      expect(ta).toHaveValue(SAMPLE_BLOB);
      expect(screen.queryByTestId("lattice-import-confirm")).not.toBeInTheDocument();
    });

    it("hash-mismatch error keeps the user on paste stage with the error visible", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve({
            ok: false, status: 400,
            json: () => Promise.resolve({ error: "Fidelity hash mismatch", code: "LATTICE_HASH_MISMATCH" }),
          } as Response),
        ),
      );

      renderWithClient();
      fireEvent.click(getTrigger());
      fireEvent.click(screen.getByTestId("lattice-menu-import"));

      fireEvent.change(screen.getByTestId("lattice-import-textarea"), {
        target: { value: "tampered blob" },
      });
      fireEvent.click(screen.getByTestId("lattice-import-verify"));

      const err = await screen.findByTestId("lattice-import-error");
      expect(err.textContent).toMatch(/Fidelity hash mismatch|LATTICE_HASH_MISMATCH/);
      // Still on stage 1 (paste); preview was not entered.
      expect(screen.getByTestId("lattice-import-stage-paste")).toBeInTheDocument();
      expect(screen.queryByTestId("lattice-import-stage-preview")).not.toBeInTheDocument();
      expect(screen.queryByTestId("lattice-import-confirm")).not.toBeInTheDocument();
    });
  });
});
