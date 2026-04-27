import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * CorporateLogo
 *
 * Pure CSS/SVG octagonal "umbrella" mark used by the umbrella-corp theme.
 * Renders an inline SVG with alternating red/white triangular panels and a
 * thin black outline plus a soft metallic shadow. No external dependency,
 * no network fetch, no AI image generation.
 *
 * Optional override: if `public/branding/umbrella-logo.svg` exists, it is
 * loaded as an <img>. If the request fails (404, parse error, etc.) we
 * silently fall back to the inline SVG so the build never breaks.
 *
 * Variants:
 *   - mark   : just the octagonal mark
 *   - lockup : mark + two-line wordmark ("BOS-OMEGA / ORCHESTRATION PLATFORM")
 *
 * Sizes:
 *   - sm = 20px mark
 *   - md = 32px mark
 *   - lg = 56px mark
 *
 * The branding strings here are deliberately the safe defaults requested in
 * the task spec — no protected wording is hardcoded.
 */

type Size = "sm" | "md" | "lg";
type Variant = "mark" | "lockup";

type Props = {
  size?: Size;
  variant?: Variant;
  /** Convenience alias for `variant === "lockup"`. */
  label?: boolean;
  className?: string;
};

const PX: Record<Size, number> = { sm: 20, md: 32, lg: 56 };

/**
 * Try to fetch the user-supplied logo override. Returns the URL only if the
 * asset responds with a 2xx; otherwise returns null and the component falls
 * back to the inline SVG. We use HEAD because the actual <img> render does
 * the real load — this probe just gates which path we render.
 */
function useLogoOverride(): string | null {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const url = `${import.meta.env.BASE_URL}branding/umbrella-logo.svg`;
    fetch(url, { method: "HEAD" })
      .then((r) => {
        if (!cancelled && r.ok) setSrc(url);
      })
      .catch(() => {
        /* missing override is the normal case — ignore */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return src;
}

/**
 * Inline SVG umbrella mark — eight alternating red/white triangular panels
 * inside a black-outlined circle, with an inner shadow for the metallic
 * "machined" look.
 */
function InlineMark({ pixels }: { pixels: number }) {
  const r = 50; // viewBox radius
  // Eight wedge segments forming the umbrella octagon.
  const wedges = Array.from({ length: 8 }).map((_, i) => {
    const a0 = (Math.PI * 2 * i) / 8 - Math.PI / 2;
    const a1 = (Math.PI * 2 * (i + 1)) / 8 - Math.PI / 2;
    const x0 = 50 + r * Math.cos(a0);
    const y0 = 50 + r * Math.sin(a0);
    const x1 = 50 + r * Math.cos(a1);
    const y1 = 50 + r * Math.sin(a1);
    const fill = i % 2 === 0 ? "#d41414" : "#ffffff";
    return (
      <path
        key={i}
        d={`M50 50 L${x0.toFixed(3)} ${y0.toFixed(3)} A${r} ${r} 0 0 1 ${x1.toFixed(3)} ${y1.toFixed(3)} Z`}
        fill={fill}
      />
    );
  });
  return (
    <svg
      role="img"
      aria-label="BOS-OMEGA Corporation mark"
      width={pixels}
      height={pixels}
      viewBox="0 0 100 100"
      style={{ display: "block", filter: "drop-shadow(0 1px 1px rgba(0,0,0,0.6))" }}
    >
      <defs>
        <radialGradient id="bos-corp-gloss" cx="50%" cy="35%" r="65%">
          <stop offset="0%" stopColor="rgba(255,255,255,0.35)" />
          <stop offset="55%" stopColor="rgba(255,255,255,0)" />
        </radialGradient>
        <linearGradient id="bos-corp-rim" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#1a1a1a" />
          <stop offset="100%" stopColor="#000" />
        </linearGradient>
      </defs>
      {/* Outer black ring (the bezel) */}
      <circle cx="50" cy="50" r="49" fill="url(#bos-corp-rim)" />
      {/* Inner panel field */}
      <g transform="translate(50 50) scale(0.92) translate(-50 -50)">
        <circle cx="50" cy="50" r="50" fill="#0b0b0c" />
        {wedges}
        {/* Spoke lines between wedges */}
        {Array.from({ length: 8 }).map((_, i) => {
          const a = (Math.PI * 2 * i) / 8 - Math.PI / 2;
          const x = 50 + 50 * Math.cos(a);
          const y = 50 + 50 * Math.sin(a);
          return (
            <line
              key={`s${i}`}
              x1="50"
              y1="50"
              x2={x.toFixed(3)}
              y2={y.toFixed(3)}
              stroke="#000"
              strokeWidth="1.2"
            />
          );
        })}
        {/* Center hub — the dark eye */}
        <circle cx="50" cy="50" r="9" fill="#0b0b0c" stroke="#000" strokeWidth="1" />
        <circle cx="50" cy="50" r="4" fill="#d41414" />
      </g>
      {/* Specular highlight overlay */}
      <circle cx="50" cy="50" r="49" fill="url(#bos-corp-gloss)" />
    </svg>
  );
}

export function CorporateLogo({
  size = "md",
  variant,
  label,
  className,
}: Props) {
  const px = PX[size];
  const override = useLogoOverride();
  const [imgFailed, setImgFailed] = useState(false);
  const showLockup = variant === "lockup" || label === true;

  // If the HEAD probe succeeded but the actual image failed to load/parse
  // (corrupt SVG, MIME mismatch, etc.), `imgFailed` flips to true and we
  // re-render the inline SVG instead of leaving an empty/broken slot.
  const useImg = override !== null && !imgFailed;

  const mark = useImg ? (
    <img
      src={override as string}
      alt="BOS-OMEGA Corporation mark"
      width={px}
      height={px}
      style={{
        display: "block",
        width: px,
        height: px,
        filter: "drop-shadow(0 1px 1px rgba(0,0,0,0.6))",
      }}
      onError={() => setImgFailed(true)}
    />
  ) : (
    <InlineMark pixels={px} />
  );

  if (!showLockup) {
    return <span className={cn("inline-flex items-center", className)}>{mark}</span>;
  }

  // Lockup: mark + two-line wordmark. Sized so the wordmark scales with the
  // mark height. We keep the strings literal here (safe defaults from the
  // task spec) so they're searchable and easy to swap later.
  const titleSize = size === "lg" ? 22 : size === "md" ? 15 : 12;
  const subSize = size === "lg" ? 11 : size === "md" ? 9 : 8;

  return (
    <span
      className={cn("inline-flex items-center gap-3", className)}
      data-testid="corporate-logo-lockup"
    >
      {mark}
      <span className="flex flex-col leading-none">
        <span
          className="font-serif font-semibold tracking-[0.08em] text-white"
          style={{ fontSize: titleSize }}
        >
          BOS-OMEGA
        </span>
        <span
          className="uppercase tracking-[0.22em] text-[#d41414] font-semibold mt-1"
          style={{ fontSize: subSize }}
        >
          Orchestration Platform
        </span>
      </span>
    </span>
  );
}

export default CorporateLogo;
