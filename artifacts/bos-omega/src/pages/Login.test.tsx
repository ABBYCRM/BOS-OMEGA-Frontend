/**
 * Login page — skin selection contract.
 *
 * The login page has two visual skins:
 *   - "umbrella": the Resident-Evil flavoured skin every fresh visitor
 *                 sees by default.
 *   - "clean":    an ultra-minimalist alternative anyone can opt into
 *                 via the in-page "switch theme" button.
 *
 * The container persists the choice in localStorage (`bos:loginSkin`) so:
 *   1. A fresh visitor with no stored preference lands on "umbrella".
 *   2. A stored "clean" preference is respected on subsequent loads.
 *   3. Clicking the in-page "switch theme" affordance flips the skin and
 *      persists the new value.
 *   4. Logging in does NOT change the skin — the user's manual choice
 *      always wins (regardless of role).
 *
 * These four behaviours lock down the "Umbrella as the default skin"
 * decision, so they're worth a real test.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Login } from "./Login";

// Mock the auth helpers so the test never actually hits the network.
vi.mock("@/lib/auth", () => ({
  login: vi.fn(),
  signup: vi.fn(),
}));

import { login as mockLogin } from "@/lib/auth";

function renderLogin() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <Login />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("Login skin selection", () => {
  it("defaults to the Umbrella skin when nothing is stored", () => {
    renderLogin();
    // Umbrella skin uses the UMBRELLA wordmark + "RED QUEEN ONLINE" status pill.
    expect(screen.getByText("UMBRELLA")).toBeTruthy();
    expect(screen.getByText("RED QUEEN ONLINE")).toBeTruthy();
    // Clean-skin chrome should not be present.
    expect(screen.queryByText("BOS · Omega")).toBeNull();
  });

  it("renders the Clean skin when localStorage opts in", () => {
    window.localStorage.setItem("bos:loginSkin", "clean");
    renderLogin();
    expect(screen.getByText("BOS · Omega")).toBeTruthy();
    expect(screen.getByTestId("button-login")).toBeTruthy();
    expect(screen.queryByText("UMBRELLA")).toBeNull();
  });

  it("flips skins when the switch-theme button is clicked, and persists", () => {
    renderLogin();
    expect(screen.getByText("UMBRELLA")).toBeTruthy();

    fireEvent.click(screen.getByTestId("button-switch-skin"));

    expect(screen.getByText("BOS · Omega")).toBeTruthy();
    expect(screen.queryByText("UMBRELLA")).toBeNull();
    expect(window.localStorage.getItem("bos:loginSkin")).toBe("clean");

    // Flip back
    fireEvent.click(screen.getByTestId("button-switch-skin"));
    expect(screen.getByText("UMBRELLA")).toBeTruthy();
    expect(window.localStorage.getItem("bos:loginSkin")).toBe("umbrella");
  });

  it("preserves the stored 'clean' preference even after a super_admin signs in", async () => {
    window.localStorage.setItem("bos:loginSkin", "clean");
    vi.mocked(mockLogin).mockResolvedValue({
      ok: true,
      user: {
        id: "u1",
        email: "boss@example.com",
        role: "super_admin",
      },
    });

    renderLogin();
    // Sanity: starts on Clean because storage said so.
    expect(screen.getByText("BOS · Omega")).toBeTruthy();

    fireEvent.change(screen.getByTestId("input-email"), {
      target: { value: "boss@example.com" },
    });
    fireEvent.change(screen.getByTestId("input-password"), {
      target: { value: "supersecret" },
    });
    fireEvent.click(screen.getByTestId("button-login"));

    // Wait for the mutation to resolve, then assert the skin choice is unchanged.
    await waitFor(() => {
      expect(mockLogin).toHaveBeenCalled();
    });
    expect(window.localStorage.getItem("bos:loginSkin")).toBe("clean");
  });

  it("preserves the default Umbrella skin after a regular user signs in", async () => {
    vi.mocked(mockLogin).mockResolvedValue({
      ok: true,
      user: {
        id: "u2",
        email: "alice@example.com",
        role: "user",
      },
    });

    renderLogin();
    // Sanity: starts on Umbrella (default).
    expect(screen.getByText("UMBRELLA")).toBeTruthy();

    fireEvent.change(screen.getByTestId("input-email"), {
      target: { value: "alice@example.com" },
    });
    fireEvent.change(screen.getByTestId("input-password"), {
      target: { value: "alicepass" },
    });
    fireEvent.click(screen.getByTestId("button-login"));

    await waitFor(() => {
      expect(mockLogin).toHaveBeenCalled();
    });
    expect(window.localStorage.getItem("bos:loginSkin")).toBe("umbrella");
  });
});
