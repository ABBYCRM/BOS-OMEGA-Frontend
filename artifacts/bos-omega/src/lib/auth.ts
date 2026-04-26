const API_BASE = "/api";

export type AuthState = { authenticated: boolean };

export async function fetchAuthState(): Promise<AuthState> {
  const r = await fetch(`${API_BASE}/auth/me`, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!r.ok) return { authenticated: false };
  return r.json();
}

export async function login(password: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ password }),
  });
  if (r.ok) return { ok: true };
  if (r.status === 429) return { ok: false, error: "Too many attempts. Try again later." };
  if (r.status === 401) return { ok: false, error: "Invalid password." };
  return { ok: false, error: `Login failed (HTTP ${r.status}).` };
}

export async function logout(): Promise<void> {
  await fetch(`${API_BASE}/auth/logout`, {
    method: "POST",
    credentials: "same-origin",
  }).catch(() => {});
}
