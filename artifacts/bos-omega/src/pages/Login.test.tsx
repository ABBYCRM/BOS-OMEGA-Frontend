/**
 * Login page — skin selection contract.
 *
 * The login page has two visual skins:
 *   - "clean":    the default ultra-minimalist look every visitor sees.
 *   - "umbrella": the Resident-Evil flavoured skin, surfaced for super_admin
 *                 accounts (and to anyone who manually enables it).
 *
 * The container persists the choice in localStorage (`bos:loginSkin`) so:
 *   1. A fresh visitor with no stored preference lands on "clean".
 *   2. A stored "umbrella" preference is respected on subsequent loads.
 *   3. Clicking the in-page "switch theme" affordance flips the skin and
 *      persists the new value.
 *   4. Logging in as a super_admin auto-sets the preference to "umbrella";
 *      logging in as a regular user resets it to "clean".
 *
 * These four behaviours are what the task ("clean by default, umbrella for
 * super_admin / personal account") actually asserts, so they're worth
 * locking down with a real test.
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
  it("defaults to the clean skin when nothing is stored", () => {
    renderLogin();
    // Clean skin uses sentence-case copy and the BOS · Omega wordmark
    expect(screen.getByText("BOS · Omega")).toBeTruthy();
    expect(screen.getByTestId("button-login")).toBeTruthy();
    // Umbrella-only chrome should not be present
    expect(screen.queryByText("UMBRELLA")).toBeNull();
    expect(screen.queryByText("RED QUEEN ONLINE")).toBeNull();
  });

  it("renders the Umbrella skin when localStorage opts in", () => {
    window.localStorage.setItem("bos:loginSkin", "umbrella");
    renderLogin();
    expect(screen.getByText("UMBRELLA")).toBeTruthy();
    expect(screen.getByText("RED QUEEN ONLINE")).toBeTruthy();
    expect(screen.queryByText("BOS · Omega")).toBeNull();
  });

  it("flips skins when the switch-theme button is clicked, and persists", () => {
    renderLogin();
    expect(screen.getByText("BOS · Omega")).toBeTruthy();

    fireEvent.click(screen.getByTestId("button-switch-skin"));

    expect(screen.getByText("UMBRELLA")).toBeTruthy();
    expect(screen.queryByText("BOS · Omega")).toBeNull();
    expect(window.localStorage.getItem("bos:loginSkin")).toBe("umbrella");

    // Flip back
    fireEvent.click(screen.getByTestId("button-switch-skin"));
    expect(screen.getByText("BOS · Omega")).toBeTruthy();
    expect(window.localStorage.getItem("bos:loginSkin")).toBe("clean");
  });

  it("auto-switches to Umbrella skin after a super_admin signs in", async () => {
    vi.mocked(mockLogin).mockResolvedValue({
      ok: true,
      user: {
        id: "u1",
        email: "boss@example.com",
        role: "super_admin",
      },
    });

    renderLogin();
    fireEvent.change(screen.getByTestId("input-email"), {
      target: { value: "boss@example.com" },
    });
    fireEvent.change(screen.getByTestId("input-password"), {
      target: { value: "supersecret" },
    });
    fireEvent.click(screen.getByTestId("button-login"));

    await waitFor(() => {
      expect(window.localStorage.getItem("bos:loginSkin")).toBe("umbrella");
    });
  });

  it("auto-switches back to Clean skin after a regular user signs in (even from Umbrella)", async () => {
    window.localStorage.setItem("bos:loginSkin", "umbrella");
    vi.mocked(mockLogin).mockResolvedValue({
      ok: true,
      user: {
        id: "u2",
        email: "alice@example.com",
        role: "user",
      },
    });

    renderLogin();
    // Sanity: starts on Umbrella because storage said so
    expect(screen.getByText("UMBRELLA")).toBeTruthy();

    fireEvent.change(screen.getByTestId("input-email"), {
      target: { value: "alice@example.com" },
    });
    fireEvent.change(screen.getByTestId("input-password"), {
      target: { value: "alicepass" },
    });
    fireEvent.click(screen.getByTestId("button-login"));

    await waitFor(() => {
      expect(window.localStorage.getItem("bos:loginSkin")).toBe("clean");
    });
  });
});
