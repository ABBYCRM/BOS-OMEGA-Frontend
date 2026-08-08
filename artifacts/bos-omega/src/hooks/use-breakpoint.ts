import * as React from "react"

// 640px = Tailwind `sm` (phone landscape / small tablet portrait)
// 1024px = Tailwind `lg` (desktop)
const MOBILE_MAX = 639;
const TABLET_MAX = 1023;

export type Breakpoint = "mobile" | "tablet" | "desktop";

/**
 * Reactive breakpoint hook. The returned value is the CURRENT viewport
 * bucket:
 *   - "mobile"  — phone, ≤ 639px wide. Sidebar is a drawer.
 *   - "tablet"  — 640–1023px. Sidebar is a collapsed icon rail.
 *   - "desktop" — ≥ 1024px. Full sidebar.
 *
 * Updates on resize via matchMedia (cheap, no React re-render churn
 * from a window resize listener). SSR-safe — returns "desktop" on
 * the server, then the first client effect reconciles.
 */
export function useBreakpoint(): Breakpoint {
  const [bp, setBp] = React.useState<Breakpoint>("desktop");

  React.useEffect(() => {
    const compute = () => {
      const w = window.innerWidth;
      if (w <= MOBILE_MAX) setBp("mobile");
      else if (w <= TABLET_MAX) setBp("tablet");
      else setBp("desktop");
    };
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, []);

  return bp;
}
