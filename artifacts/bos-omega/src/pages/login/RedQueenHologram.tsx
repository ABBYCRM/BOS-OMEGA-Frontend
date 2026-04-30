import { useEffect, useId } from "react";
import {
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
} from "framer-motion";

/**
 * RedQueenHologram
 *
 * A small "AI core" widget for the upper-right corner of the Umbrella
 * login skin. The visual is intentionally abstract: a wireframe head /
 * shoulders silhouette (geometric polygons only — no face, eyes, mouth,
 * hair, or any identifying features) overlaid with CRT scanlines, a
 * chromatic-aberration split, and a soft pulsing red halo. It reacts to
 * the cursor with a subtle head-turn and parallax.
 *
 * Placement is responsibility of the parent — this component renders an
 * inline-block panel and assumes the caller positions it.
 */
export function RedQueenHologram({ className }: { className?: string }) {
  const prefersReducedMotion = useReducedMotion();

  // Viewport-normalised cursor position [-0.5, 0.5]. Springs are slow
  // and heavy so the head turn reads as deliberate, not twitchy.
  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  const sx = useSpring(mx, { stiffness: 50, damping: 20, mass: 1 });
  const sy = useSpring(my, { stiffness: 50, damping: 20, mass: 1 });

  // Subtle head-turn — a few degrees of yaw + pitch toward the cursor.
  const rotateY = useTransform(sx, (v) => v * 18);
  const rotateX = useTransform(sy, (v) => v * -10);
  // Tiny lateral parallax so the silhouette isn't perfectly locked.
  const translateX = useTransform(sx, (v) => v * 6);
  const translateY = useTransform(sy, (v) => v * 4);

  useEffect(() => {
    if (prefersReducedMotion) return;
    const onMove = (e: MouseEvent) => {
      const vw = window.innerWidth || 1;
      const vh = window.innerHeight || 1;
      mx.set(e.clientX / vw - 0.5);
      my.set(e.clientY / vh - 0.5);
    };
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, [mx, my, prefersReducedMotion]);

  // useId ensures the SVG defs (clip path, gradients) are unique even if
  // multiple instances of the widget mount on the same page.
  const uid = useId().replace(/:/g, "");
  const scanClipId = `rq-scan-${uid}`;
  const meshGradId = `rq-mesh-${uid}`;

  return (
    <div
      aria-hidden
      className={`pointer-events-none select-none ${className ?? ""}`}
      data-testid="red-queen-hologram"
      style={{ perspective: "1200px" }}
    >
      {/* Bezel / frame around the hologram */}
      <div
        className="relative rounded-sm border border-[#3a1116] overflow-hidden"
        style={{
          width: 184,
          background:
            "linear-gradient(180deg, rgba(20,4,6,0.85) 0%, rgba(8,2,3,0.92) 100%)",
          boxShadow:
            "inset 0 1px 0 rgba(255,255,255,0.04), 0 12px 40px rgba(0,0,0,0.55), 0 0 30px rgba(220,30,40,0.18)",
        }}
      >
        {/* Header strip */}
        <div className="flex items-center justify-between px-2.5 py-1 border-b border-[#3a1116] text-[8px] tracking-[0.28em] text-[#7a6e6c]">
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block w-1.5 h-1.5 rounded-full bg-[#dc1e28]"
              style={{ animation: "umbrella-blink 1.4s steps(2,end) infinite" }}
            />
            RED QUEEN
          </span>
          <span>AI CORE</span>
        </div>

        {/* Hologram stage */}
        <div
          className="relative"
          style={{
            height: 210,
            background:
              "radial-gradient(ellipse at 50% 60%, rgba(220,30,40,0.18) 0%, rgba(0,0,0,0.0) 60%), #050102",
          }}
        >
          {/* Soft pulsing halo behind the silhouette */}
          <div
            className="absolute inset-0 flex items-center justify-center"
            style={{
              animation: prefersReducedMotion
                ? undefined
                : "umbrella-pulse 3.6s ease-in-out infinite",
            }}
          >
            <div
              className="rounded-full"
              style={{
                width: 130,
                height: 130,
                background: `radial-gradient(circle, rgba(220,30,40,0.55) 0%, rgba(220,30,40,0.0) 70%)`,
                filter: "blur(8px)",
              }}
            />
          </div>

          {/* The silhouette itself — wrapped so it can rotate/translate
              with the cursor independent of the halo and scanlines. */}
          <motion.svg
            viewBox="0 0 200 240"
            width="100%"
            height="100%"
            preserveAspectRatio="xMidYMid meet"
            className="absolute inset-0"
            style={{
              rotateY,
              rotateX,
              x: translateX,
              y: translateY,
              transformStyle: "preserve-3d",
              filter: "drop-shadow(0 0 6px rgba(220,30,40,0.8))",
            }}
          >
            <defs>
              {/* Faint gradient fill so the silhouette has volume without
                  reading as a solid shape. */}
              <radialGradient id={meshGradId} cx="50%" cy="35%" r="60%">
                <stop offset="0%" stopColor="rgba(255,80,90,0.22)" />
                <stop offset="60%" stopColor="rgba(220,30,40,0.10)" />
                <stop offset="100%" stopColor="rgba(220,30,40,0)" />
              </radialGradient>

              {/* Scanline mask — clip to silhouette so the lines only
                  appear *on* the figure, not the whole stage. */}
              <clipPath id={scanClipId}>
                <SilhouettePath />
              </clipPath>
            </defs>

            {/* Layer A: chromatic aberration ghosts (cyan + extra red) */}
            <g
              transform="translate(-1.5,0)"
              style={{ mixBlendMode: "screen", opacity: 0.55 }}
            >
              <SilhouettePath
                fill="none"
                stroke="rgba(80,220,255,0.9)"
                strokeWidth={1.2}
              />
            </g>
            <g
              transform="translate(1.5,0)"
              style={{ mixBlendMode: "screen", opacity: 0.55 }}
            >
              <SilhouettePath
                fill="none"
                stroke="rgba(255,40,55,0.9)"
                strokeWidth={1.2}
              />
            </g>

            {/* Layer B: faint volume fill */}
            <SilhouettePath fill={`url(#${meshGradId})`} stroke="none" />

            {/* Layer C: primary wireframe stroke */}
            <SilhouettePath
              fill="none"
              stroke="rgba(255,180,185,0.95)"
              strokeWidth={1.4}
            />

            {/* Layer D: internal contour lines suggesting 3D mesh (no
                facial features — just horizontal-ish curves across the
                head and shoulders). */}
            <g
              clipPath={`url(#${scanClipId})`}
              fill="none"
              stroke="rgba(255,120,130,0.45)"
              strokeWidth={0.7}
            >
              <path d="M 50 60 Q 100 70 150 60" />
              <path d="M 45 80 Q 100 92 155 80" />
              <path d="M 42 100 Q 100 112 158 100" />
              <path d="M 44 120 Q 100 132 156 120" />
              <path d="M 50 140 Q 100 150 150 140" />
              <path d="M 30 175 Q 100 185 170 175" />
              <path d="M 20 195 Q 100 205 180 195" />
              <path d="M 15 215 Q 100 225 185 215" />
            </g>

            {/* Layer E: scanline striping clipped to silhouette */}
            <g clipPath={`url(#${scanClipId})`}>
              <rect
                x="0"
                y="0"
                width="200"
                height="240"
                fill={`url(#scanlines-${uid})`}
                opacity="0.55"
              />
            </g>

            <defs>
              <pattern
                id={`scanlines-${uid}`}
                width="1"
                height="3"
                patternUnits="userSpaceOnUse"
              >
                <rect width="1" height="1" fill="rgba(0,0,0,0.6)" />
                <rect y="1" width="1" height="2" fill="rgba(0,0,0,0)" />
              </pattern>
            </defs>
          </motion.svg>

          {/* Drifting horizontal scanline sweep across the whole stage */}
          <div
            className="absolute inset-x-0 top-0 h-12 pointer-events-none"
            style={{
              background:
                "linear-gradient(to bottom, transparent 0%, rgba(255,80,90,0.18) 50%, transparent 100%)",
              animation: prefersReducedMotion
                ? undefined
                : "umbrella-scan 4.5s linear infinite",
              mixBlendMode: "screen",
            }}
          />

          {/* Static CRT scanlines over the whole stage for that
              monitor-on-the-other-side feel. */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              backgroundImage:
                "repeating-linear-gradient(to bottom, rgba(0,0,0,0.35) 0px, rgba(0,0,0,0.35) 1px, transparent 1px, transparent 3px)",
              mixBlendMode: "multiply",
              opacity: 0.6,
            }}
          />

          {/* Subtle vignette */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background:
                "radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.7) 100%)",
            }}
          />
        </div>

        {/* Footer strip — rotating diagnostic readouts */}
        <div className="flex items-center justify-between px-2.5 py-1 border-t border-[#3a1116] text-[8px] tracking-[0.28em] text-[#7a6e6c]">
          <span>UPLINK · STABLE</span>
          <span style={{ animation: "umbrella-flicker 5s infinite" }}>
            ◉ LIVE
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Abstract head / shoulders silhouette built from polygon primitives.
 * Intentionally featureless — no eyes, mouth, nose, hair, or anything
 * that could read as a specific person or character.
 */
function SilhouettePath(
  props: React.SVGProps<SVGPathElement> = {},
) {
  const d = [
    "M 100 18",
    "L 128 26",
    "L 148 44",
    "L 156 70",
    "L 158 98",
    "L 152 124",
    "L 138 144",
    "L 122 154",
    "L 118 168",
    "L 138 178",
    "L 168 192",
    "L 184 215",
    "L 190 240",
    "L 10 240",
    "L 16 215",
    "L 32 192",
    "L 62 178",
    "L 82 168",
    "L 78 154",
    "L 62 144",
    "L 48 124",
    "L 42 98",
    "L 44 70",
    "L 52 44",
    "L 72 26",
    "Z",
  ].join(" ");
  return <path d={d} {...props} />;
}
