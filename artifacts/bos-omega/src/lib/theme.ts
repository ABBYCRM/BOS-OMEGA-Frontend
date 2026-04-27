/**
 * Theme provider for BOS-OMEGA.
 *
 * Each theme is a named CSS class applied to <html>. The CSS overrides
 * for every theme live in `src/index.css` under `:root.theme-<id>`.
 * Adding a theme = (1) extend the ThemeId union here, (2) extend
 * THEME_IDS, (3) add a `:root.theme-<id> { ... }` block in index.css,
 * (4) add the option to the ThemeToggle grid in Settings.tsx.
 *
 * The active theme is persisted to localStorage and applied as a class
 * on <html> so all pages re-render under either theme without a refresh.
 */

import { useEffect, useState } from "react";

export type ThemeId =
  | "retro95"
  | "retro98"
  | "modern"
  | "cyberdine"
  | "umbrella"
  | "umbrella-corp"
  | "capybara"
  | "anime"
  | "steampunk"
  | "neonpunk"
  | "ultraclean";

export const THEME_IDS: readonly ThemeId[] = [
  "retro95",
  "retro98",
  "modern",
  "cyberdine",
  "umbrella",
  "umbrella-corp",
  "capybara",
  "anime",
  "steampunk",
  "neonpunk",
  "ultraclean",
] as const;

const THEME_CLASSES = THEME_IDS.map((id) => `theme-${id}`);

const LS_KEY = "bos.theme.v1";
const DEFAULT_THEME: ThemeId = "retro95";

function isValidTheme(value: unknown): value is ThemeId {
  return typeof value === "string" && (THEME_IDS as readonly string[]).includes(value);
}

function readStoredTheme(): ThemeId {
  if (typeof window === "undefined") return DEFAULT_THEME;
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    if (isValidTheme(raw)) return raw;
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
  // Strip every known theme class so switching is idempotent and we
  // never accumulate stale classes (e.g. switching from retro95 ->
  // capybara without first removing theme-retro95).
  for (const cls of THEME_CLASSES) root.classList.remove(cls);
  root.classList.add(`theme-${theme}`);
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
      if (isValidTheme(e.newValue)) {
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
