/**
 * Theme provider for BOS-OMEGA.
 *
 * - "retro95" — Windows 95 inspired skin (default for new visitors)
 * - "modern"  — original enterprise warm-cream skin
 *
 * The active theme is persisted to localStorage and applied as a class
 * on <html> so all pages re-render under either theme without a refresh.
 */

import { useEffect, useState } from "react";

export type ThemeId = "retro95" | "modern";

const LS_KEY = "bos.theme.v1";
const DEFAULT_THEME: ThemeId = "retro95";

function readStoredTheme(): ThemeId {
  if (typeof window === "undefined") return DEFAULT_THEME;
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    if (raw === "modern" || raw === "retro95") return raw;
  } catch {
    // ignore
  }
  return DEFAULT_THEME;
}

function writeStoredTheme(theme: ThemeId): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LS_KEY, theme);
  } catch {
    // ignore
  }
}

export function applyTheme(theme: ThemeId): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.remove("theme-retro95", "theme-modern");
  root.classList.add(theme === "retro95" ? "theme-retro95" : "theme-modern");
  root.setAttribute("data-theme", theme);
}

export function initTheme(): ThemeId {
  const theme = readStoredTheme();
  applyTheme(theme);
  return theme;
}

export function useTheme(): [ThemeId, (next: ThemeId) => void] {
  const [theme, setThemeState] = useState<ThemeId>(() => readStoredTheme());

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Listen for cross-tab updates.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== LS_KEY) return;
      if (e.newValue === "modern" || e.newValue === "retro95") {
        setThemeState(e.newValue);
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  function setTheme(next: ThemeId) {
    writeStoredTheme(next);
    setThemeState(next);
  }
  return [theme, setTheme];
}
