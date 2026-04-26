const API_BASE = "/api";

export type AuthUser = {
  id: string;
  email: string;
  role: "user" | "admin" | "super_admin";
};

export type AuthState =
  | { authenticated: false; user?: undefined }
  | { authenticated: true; user: AuthUser };

export async function fetchAuthState(): Promise<AuthState> {
  const r = await fetch(`${API_BASE}/auth/me`, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!r.ok) return { authenticated: false };
  const data = (await r.json()) as { authenticated?: boolean; user?: AuthUser };
  if (data.authenticated && data.user) {
    return { authenticated: true, user: data.user };
  }
  return { authenticated: false };
}

export type LoginResult =
  | { ok: true; user: AuthUser }
  | { ok: false; error: string };

export async function login(email: string, password: string): Promise<LoginResult> {
  const r = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (r.ok) {
    const data = (await r.json()) as { user: AuthUser };
    return { ok: true, user: data.user };
  }
  if (r.status === 429) return { ok: false, error: "Too many attempts. Try again later." };
  if (r.status === 401) return { ok: false, error: "Invalid email or password." };
  return { ok: false, error: `Login failed (HTTP ${r.status}).` };
}

export async function logout(): Promise<void> {
  await fetch(`${API_BASE}/auth/logout`, {
    method: "POST",
    credentials: "same-origin",
  }).catch(() => {});
}

export function roleLabel(role: AuthUser["role"]): string {
  switch (role) {
    case "super_admin":
      return "Super Admin";
    case "admin":
      return "Admin";
    default:
      return "User";
  }
}
