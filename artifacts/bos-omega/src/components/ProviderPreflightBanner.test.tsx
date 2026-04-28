import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { ProviderPreflightBanner } from "./ProviderPreflightBanner";

function renderWithProviders(initialPath = "/console") {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  const { hook } = memoryLocation({ path: initialPath });
  return render(
    <QueryClientProvider client={qc}>
      <Router hook={hook}>
        <ProviderPreflightBanner />
      </Router>
    </QueryClientProvider>,
  );
}

describe("ProviderPreflightBanner", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    cleanup();
  });

  function mockPreflight(body: unknown, status = 200) {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }

  it("renders the warning banner with deep-link CTA when preflight reports no provider", async () => {
    mockPreflight({
      ok: false,
      reachable: [],
      reason: "no_llm_provider_reachable",
      hint: "No LLM provider is reachable in this env.",
    });
    renderWithProviders("/console");
    const banner = await screen.findByTestId("banner-no-provider");
    expect(banner).toBeInTheDocument();
    const cta = screen.getByTestId("link-add-openai-key");
    expect(cta).toHaveAttribute("href", "/settings#provider-prov_openai");
  });

  it("renders nothing when preflight reports ok=true", async () => {
    mockPreflight({
      ok: true,
      reachable: [{ name: "OpenAI", source: "db" }],
    });
    renderWithProviders("/console");
    // Wait long enough for the query to settle.
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(screen.queryByTestId("banner-no-provider")).not.toBeInTheDocument();
  });

  it("hides itself on the /settings route even if preflight reports failure", async () => {
    mockPreflight({
      ok: false,
      reachable: [],
      reason: "no_llm_provider_reachable",
      hint: "x",
    });
    renderWithProviders("/settings");
    // Give the query a beat in case it would otherwise render.
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId("banner-no-provider")).not.toBeInTheDocument();
  });

  it("treats a 401 from preflight as 'no banner' so the login page stays clean", async () => {
    fetchSpy.mockResolvedValue(new Response("", { status: 401 }));
    renderWithProviders("/console");
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(screen.queryByTestId("banner-no-provider")).not.toBeInTheDocument();
  });
});
