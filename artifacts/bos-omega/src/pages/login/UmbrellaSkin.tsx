import { useEffect, useMemo, useRef } from "react";
import {
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
} from "framer-motion";
import type { LoginSkinProps } from "./types";
import { RedQueenHologram } from "./RedQueenHologram";

export function UmbrellaSkin(props: LoginSkinProps) {
  const {
    mode,
    onModeChange,
    email,
    onEmailChange,
    password,
    onPasswordChange,
    confirm,
    onConfirmChange,
    error,
    isPending,
    glitch,
    onSubmit,
    onSwitchSkin,
  } = props;

  const cardRef = useRef<HTMLDivElement | null>(null);
  // Honor the OS-level "reduce motion" preference. When true, all
  // cursor-driven transforms (card tilt + biohazard parallax) stay at
  // their neutral 0 values so the page is visually static.
  const prefersReducedMotion = useReducedMotion();

  // Mouse-tracked 3D tilt. Mouse position is normalised to [-0.5, 0.5] over
  // the card's bounding rect; spring smoothing avoids jittery tracking.
  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  const sx = useSpring(mx, { stiffness: 120, damping: 18, mass: 0.5 });
  const sy = useSpring(my, { stiffness: 120, damping: 18, mass: 0.5 });
  const rotateY = useTransform(sx, (v) => v * 16);
  const rotateX = useTransform(sy, (v) => v * -16);
  const logoZ = useTransform(sx, (v) => v * 14);
  const logoZ2 = useTransform(sy, (v) => v * -10);
  const glareX = useTransform(sx, (v) => `${50 + v * 80}%`);
  const glareY = useTransform(sy, (v) => `${50 + v * 80}%`);

  // Viewport-normalised mouse position [-0.5, 0.5] for the background
  // biohazard parallax. Kept separate from the card-tilt values above so
  // neither effect distorts the other. The biohazard drifts COUNTER to
  // the cursor (typical depth-parallax: distant things move opposite to
  // the camera) and counter-rotates a few degrees for extra "watching
  // you" feel.
  const bx = useMotionValue(0);
  const by = useMotionValue(0);
  const bsx = useSpring(bx, { stiffness: 40, damping: 22, mass: 1.2 });
  const bsy = useSpring(by, { stiffness: 40, damping: 22, mass: 1.2 });
  const bioTranslateX = useTransform(bsx, (v) => v * -60);
  const bioTranslateY = useTransform(bsy, (v) => v * -60);
  const bioRotate = useTransform(bsx, (v) => v * -8);
  const bioScale = useTransform(bsy, (v) => 1 + Math.abs(v) * 0.04);

  // Random terminal id displayed in the chrome — stable per mount, looks like
  // an Umbrella sector code.
  const terminalId = useMemo(() => {
    const hex = (n: number) =>
      Array.from({ length: n }, () =>
        Math.floor(Math.random() * 16).toString(16).toUpperCase(),
      ).join("");
    return `${hex(4)}-${hex(4)}-${hex(2)}`;
  }, []);

  useEffect(() => {
    // Reduced-motion users: leave all cursor-driven motion values at
    // their neutral 0 baseline (already initialised that way) and skip
    // attaching the listener entirely.
    if (prefersReducedMotion) return;
    const onMove = (e: MouseEvent) => {
      const rect = cardRef.current?.getBoundingClientRect();
      if (rect) {
        mx.set((e.clientX - rect.left) / rect.width - 0.5);
        my.set((e.clientY - rect.top) / rect.height - 0.5);
      }
      // Viewport-normalised position for the biohazard parallax layer.
      const vw = window.innerWidth || 1;
      const vh = window.innerHeight || 1;
      bx.set(e.clientX / vw - 0.5);
      by.set(e.clientY / vh - 0.5);
    };
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, [mx, my, bx, by, prefersReducedMotion]);

  const clearError = () => {
    /* errors auto-clear on input change in the container */
  };

  return (
    <div className="min-h-screen w-full overflow-hidden relative font-mono text-[#e8e6e1] bg-black">
      {/* keyframes + theme isolation. Scoped to this page so global theme
          tokens cannot bleed in and break the look. */}
      <style>{`
        @keyframes umbrella-spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
        @keyframes umbrella-scan {
          0%   { transform: translateY(-100%); opacity: 0.0; }
          10%  { opacity: 0.55; }
          50%  { opacity: 0.8; }
          90%  { opacity: 0.55; }
          100% { transform: translateY(120vh); opacity: 0.0; }
        }
        @keyframes umbrella-flicker {
          0%, 19.9%, 22%, 62.9%, 64%, 64.9%, 70%, 100% { opacity: 1; }
          20%, 21.9%, 63%, 63.9%, 65%, 69.9% { opacity: 0.45; }
        }
        @keyframes umbrella-blink {
          0%, 49% { opacity: 1; }
          50%, 100% { opacity: 0.15; }
        }
        @keyframes umbrella-pulse {
          0%, 100% { box-shadow: 0 0 28px rgba(220,30,40,0.55), 0 0 80px rgba(220,30,40,0.25); }
          50%      { box-shadow: 0 0 44px rgba(220,30,40,0.9),  0 0 120px rgba(220,30,40,0.45); }
        }
        @keyframes umbrella-noise {
          0%, 100% { transform: translate(0,0); }
          10%      { transform: translate(-1px, 1px); }
          20%      { transform: translate(1px, -1px); }
          30%      { transform: translate(-1px, -1px); }
          40%      { transform: translate(1px, 1px); }
          50%      { transform: translate(-2px, 1px); }
          60%      { transform: translate(2px, -2px); }
          70%      { transform: translate(-1px, 2px); }
          80%      { transform: translate(1px, -1px); }
          90%      { transform: translate(-2px, -1px); }
        }
        .umbrella-text-glow {
          text-shadow: 0 0 8px rgba(220,30,40,0.65), 0 0 24px rgba(220,30,40,0.35);
        }
        .umbrella-input::placeholder { color: rgba(232,230,225,0.30); letter-spacing: 0.08em; }
        .umbrella-input:focus { outline: none; border-color: #dc1e28; box-shadow: 0 0 0 1px #dc1e28, 0 0 18px rgba(220,30,40,0.45); }
        .umbrella-input { caret-color: #dc1e28; }
        .umbrella-glitch { animation: umbrella-noise 0.12s steps(2,end) 5; }
        @media (prefers-reduced-motion: reduce) {
          .umbrella-glitch,
          [style*="umbrella-spin"],
          [style*="umbrella-scan"],
          [style*="umbrella-flicker"],
          [style*="umbrella-blink"],
          [style*="umbrella-pulse"],
          [style*="umbrella-noise"] { animation: none !important; }
        }
      `}</style>

      {/* Layer 1: deep base — radial vignette + hex pattern */}
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background: `
            radial-gradient(ellipse at 50% 30%, rgba(60,8,12,0.55) 0%, rgba(0,0,0,0.95) 60%, #000 100%),
            url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='40' height='46' viewBox='0 0 40 46'><polygon points='20,1 39,12 39,34 20,45 1,34 1,12' fill='none' stroke='%23260306' stroke-width='1'/></svg>")
          `,
          backgroundSize: "auto, 40px 46px",
          backgroundRepeat: "no-repeat, repeat",
        }}
      />
      {/* Layer 2: faint biohazard watermark, very large, behind everything.
          Parallax-drifts opposite the cursor to feel like a distant object
          behind the UI. Uses spring-smoothed motion values so the drift
          reads as inertia, not 1:1 tracking. */}
      <motion.div
        aria-hidden
        className="absolute inset-0 flex items-center justify-center pointer-events-none"
        style={{
          opacity: 0.04,
          x: bioTranslateX,
          y: bioTranslateY,
          rotate: bioRotate,
          scale: bioScale,
          willChange: "transform",
        }}
      >
        <BiohazardSVG className="w-[110vmin] h-[110vmin] text-[#dc1e28]" />
      </motion.div>
      {/* Layer 3: animated red scanline */}
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 h-[140px] pointer-events-none"
        style={{
          background:
            "linear-gradient(to bottom, transparent 0%, rgba(220,30,40,0.0) 30%, rgba(220,30,40,0.18) 50%, rgba(220,30,40,0.0) 70%, transparent 100%)",
          animation: "umbrella-scan 7s linear infinite",
          mixBlendMode: "screen",
        }}
      />
      {/* Layer 4: CRT scanlines */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage:
            "repeating-linear-gradient(0deg, rgba(0,0,0,0.18) 0px, rgba(0,0,0,0.18) 1px, transparent 1px, transparent 3px)",
          mixBlendMode: "multiply",
        }}
      />

      {/* Top status bar */}
      <div className="relative z-10 flex items-center justify-between px-6 py-3 text-[10px] tracking-[0.25em] text-[#7a6e6c] border-b border-[#1a0608]">
        <div className="flex items-center gap-3">
          <span
            className="inline-block w-2 h-2 rounded-full bg-[#dc1e28]"
            style={{ animation: "umbrella-blink 1.4s steps(2,end) infinite" }}
          />
          <span>SECURE LINK · TLS 1.3 · AES-256-GCM</span>
        </div>
        <div className="flex items-center gap-6">
          <span>TERMINAL · {terminalId}</span>
          <span style={{ animation: "umbrella-flicker 5s infinite" }}>
            RED QUEEN ONLINE
          </span>
        </div>
      </div>

      {/* Red Queen AI core — abstract holographic silhouette in the
          upper-right. Hidden on narrow viewports so it never overlaps
          the centered login card. */}
      <div className="hidden lg:block absolute top-12 right-6 z-10">
        <RedQueenHologram />
      </div>

      {/* Centered card stage with perspective so child rotateX/Y reads as 3D */}
      <div
        className="relative z-10 flex items-center justify-center px-4"
        style={{ perspective: "1500px", minHeight: "calc(100vh - 88px)" }}
      >
        <motion.div
          ref={cardRef}
          className={`relative w-full max-w-md ${glitch ? "umbrella-glitch" : ""}`}
          style={{
            rotateX,
            rotateY,
            transformStyle: "preserve-3d",
          }}
        >
          {/* Outer rim glow — pulses */}
          <div
            aria-hidden
            className="absolute -inset-px rounded-sm pointer-events-none"
            style={{
              animation: "umbrella-pulse 4s ease-in-out infinite",
              transform: "translateZ(-30px)",
            }}
          />

          {/* The card itself — brushed metal feel */}
          <div
            className="relative rounded-sm border border-[#3a1116] overflow-hidden"
            style={{
              background:
                "linear-gradient(135deg, #1a0608 0%, #0c0304 40%, #14060a 100%)",
              boxShadow:
                "inset 0 1px 0 rgba(255,255,255,0.04), inset 0 0 80px rgba(0,0,0,0.6), 0 30px 80px rgba(0,0,0,0.7)",
              transformStyle: "preserve-3d",
            }}
          >
            {/* Mouse-following glare highlight */}
            <motion.div
              aria-hidden
              className="absolute inset-0 pointer-events-none"
              style={{
                background: useTransform(
                  [glareX, glareY] as never,
                  ([x, y]: [string, string]) =>
                    `radial-gradient(circle at ${x} ${y}, rgba(255,200,200,0.07) 0%, transparent 40%)`,
                ),
              }}
            />

            {/* Card top: corporate header strip */}
            <div className="flex items-center justify-between px-5 py-2 border-b border-[#3a1116] text-[9px] tracking-[0.3em] text-[#7a6e6c]">
              <span>// UMBRELLA INTRANET</span>
              <span>v 11.6 · BWG-DIV</span>
            </div>

            {/* Logo + heading — translates on Z for parallax depth */}
            <motion.div
              className="flex flex-col items-center pt-7 pb-5 px-6"
              style={{ z: logoZ, x: logoZ, y: logoZ2 }}
            >
              <div className="relative mb-4">
                <div
                  aria-hidden
                  className="absolute inset-0 rounded-full blur-xl"
                  style={{
                    background:
                      "radial-gradient(circle, rgba(220,30,40,0.45) 0%, transparent 65%)",
                  }}
                />
                <div style={{ animation: "umbrella-spin 36s linear infinite" }}>
                  <UmbrellaLogo size={92} />
                </div>
              </div>

              <h1
                className="text-[22px] font-bold tracking-[0.35em] text-[#f1ecea] umbrella-text-glow"
                style={{ animation: "umbrella-flicker 7s infinite" }}
              >
                UMBRELLA
              </h1>
              <p className="text-[10px] tracking-[0.45em] text-[#dc1e28] mt-1">
                CORPORATION
              </p>
              <p className="text-[10px] tracking-[0.25em] text-[#7a6e6c] mt-3">
                RED QUEEN TERMINAL · BIOWEAPONS DIVISION
              </p>
            </motion.div>

            {/* Mode toggle */}
            <div className="px-6">
              <div
                role="tablist"
                className="grid grid-cols-2 border border-[#3a1116] text-[10px] tracking-[0.25em]"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === "signin"}
                  data-testid="tab-signin"
                  onClick={() => onModeChange("signin")}
                  className={
                    "py-2 transition-colors " +
                    (mode === "signin"
                      ? "bg-[#dc1e28] text-black font-semibold"
                      : "text-[#7a6e6c] hover:text-[#e8e6e1]")
                  }
                >
                  AUTHENTICATE
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === "signup"}
                  data-testid="tab-signup"
                  onClick={() => onModeChange("signup")}
                  className={
                    "py-2 transition-colors border-l border-[#3a1116] " +
                    (mode === "signup"
                      ? "bg-[#dc1e28] text-black font-semibold"
                      : "text-[#7a6e6c] hover:text-[#e8e6e1]")
                  }
                >
                  REQUEST CLEARANCE
                </button>
              </div>
            </div>

            {/* Form */}
            <form onSubmit={onSubmit} className="px-6 pt-5 pb-6 space-y-4">
              <UmbrellaField
                id="email"
                label="OPERATIVE ID"
                placeholder="surname@umbrella.corp"
                type="email"
                value={email}
                onChange={onEmailChange}
                disabled={isPending}
                clearError={clearError}
                autoFocus
                autoComplete="username"
                testid="input-email"
              />
              <UmbrellaField
                id="password"
                label="CLEARANCE CODE"
                placeholder={
                  mode === "signup" ? "MIN 8 CHARS" : "ENTER CLEARANCE"
                }
                type="password"
                value={password}
                onChange={onPasswordChange}
                disabled={isPending}
                clearError={clearError}
                autoComplete={
                  mode === "signup" ? "new-password" : "current-password"
                }
                testid="input-password"
              />
              {mode === "signup" && (
                <UmbrellaField
                  id="confirm"
                  label="CONFIRM CLEARANCE"
                  placeholder="RE-ENTER CODE"
                  type="password"
                  value={confirm}
                  onChange={onConfirmChange}
                  disabled={isPending}
                  clearError={clearError}
                  autoComplete="new-password"
                  testid="input-confirm"
                />
              )}

              {error && (
                <div
                  role="alert"
                  data-testid="text-login-error"
                  className="text-[11px] tracking-[0.15em] text-[#ff5961] border border-[#dc1e28] bg-[#1a0608] px-3 py-2 flex items-center gap-2"
                  style={{ animation: "umbrella-flicker 1.6s infinite" }}
                >
                  <span className="inline-block w-1.5 h-1.5 bg-[#dc1e28]" />
                  <span>// {error.toUpperCase()}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={
                  isPending ||
                  !email ||
                  !password ||
                  (mode === "signup" && !confirm)
                }
                data-testid={mode === "signin" ? "button-login" : "button-signup"}
                className="relative w-full py-3 text-[11px] tracking-[0.4em] font-semibold text-black bg-[#dc1e28] hover:bg-[#ff2a35] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                style={{
                  boxShadow: "0 0 0 1px #5a0a10, 0 0 20px rgba(220,30,40,0.45)",
                }}
              >
                {isPending
                  ? mode === "signin"
                    ? "AUTHENTICATING ▮"
                    : "PROVISIONING ▮"
                  : mode === "signin"
                    ? "AUTHENTICATE"
                    : "REQUEST CLEARANCE"}
              </button>

              <p className="text-[9px] tracking-[0.2em] text-[#7a6e6c] text-center pt-1">
                {mode === "signin"
                  ? "ALL ACCESS LOGGED · UNAUTHORISED USE PROSECUTED §13.7"
                  : "NEW PERSONNEL ARE GRANTED BASE CLEARANCE PENDING REVIEW"}
              </p>
            </form>

            {/* Bottom corner brackets — military terminal vibe */}
            <Bracket pos="tl" />
            <Bracket pos="tr" />
            <Bracket pos="bl" />
            <Bracket pos="br" />
          </div>
        </motion.div>
      </div>

      {/* Bottom legal strip + skin switch */}
      <div className="relative z-10 px-6 py-2 text-[9px] tracking-[0.3em] text-[#5a4e4c] border-t border-[#1a0608] flex justify-between items-center">
        <span>© UMBRELLA CORP · ALL RIGHTS RESERVED</span>
        <div className="flex items-center gap-6">
          <span>SECTOR-7 · CONTAINMENT TIER III</span>
          <button
            type="button"
            onClick={onSwitchSkin}
            data-testid="button-switch-skin"
            aria-label="Switch login appearance"
            className="text-[#7a6e6c] hover:text-[#dc1e28] tracking-[0.3em] transition-colors"
          >
            // STANDARD MODE
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Inputs ---------------------------------------------------------------

function UmbrellaField(props: {
  id: string;
  label: string;
  placeholder: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  clearError: () => void;
  autoFocus?: boolean;
  autoComplete?: string;
  testid: string;
}) {
  return (
    <div>
      <label
        htmlFor={props.id}
        className="block text-[9px] tracking-[0.3em] text-[#7a6e6c] mb-1"
      >
        {props.label}
      </label>
      <input
        id={props.id}
        type={props.type}
        value={props.value}
        onChange={(e) => {
          props.onChange(e.target.value);
          props.clearError();
        }}
        disabled={props.disabled}
        placeholder={props.placeholder}
        autoFocus={props.autoFocus}
        autoComplete={props.autoComplete}
        data-testid={props.testid}
        className="umbrella-input w-full bg-black/70 border border-[#3a1116] text-[13px] tracking-[0.1em] text-[#f1ecea] px-3 py-2 font-mono"
      />
    </div>
  );
}

// --- Decorative SVGs ------------------------------------------------------

function UmbrellaLogo({ size = 80 }: { size?: number }) {
  // Octagonal Umbrella mark: 8 alternating red/white wedges around a centre
  // dot, ringed by a thin border. Built from polygon paths so it scales
  // crisply at any 3D z-depth.
  const cx = 50;
  const cy = 50;
  const wedges = Array.from({ length: 8 }).map((_, i) => {
    const a0 = (i / 8) * Math.PI * 2 - Math.PI / 2;
    const a1 = ((i + 1) / 8) * Math.PI * 2 - Math.PI / 2;
    const r = 44;
    const p1 = `${cx + r * Math.cos(a0)},${cy + r * Math.sin(a0)}`;
    const p2 = `${cx + r * Math.cos(a1)},${cy + r * Math.sin(a1)}`;
    const fill = i % 2 === 0 ? "#dc1e28" : "#f5f0ec";
    return <polygon key={i} points={`${cx},${cy} ${p1} ${p2}`} fill={fill} />;
  });
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      style={{ filter: "drop-shadow(0 0 12px rgba(220,30,40,0.55))" }}
    >
      <circle
        cx={cx}
        cy={cy}
        r={45}
        fill="#0c0304"
        stroke="#3a1116"
        strokeWidth="1.5"
      />
      <g>{wedges}</g>
      <circle
        cx={cx}
        cy={cy}
        r={6}
        fill="#0c0304"
        stroke="#3a1116"
        strokeWidth="1"
      />
    </svg>
  );
}

function BiohazardSVG({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 100" className={className} fill="currentColor" aria-hidden>
      <g>
        <circle cx="50" cy="50" r="8" />
        <path d="M50 14 a16 16 0 0 1 13.86 24 L50 36 z" />
        <path
          d="M81 70 a16 16 0 0 1 -27.72 0 L60 58 z"
          transform="rotate(120 50 50)"
        />
        <path
          d="M81 70 a16 16 0 0 1 -27.72 0 L60 58 z"
          transform="rotate(240 50 50)"
        />
      </g>
    </svg>
  );
}

function Bracket({ pos }: { pos: "tl" | "tr" | "bl" | "br" }) {
  const base = "absolute w-3 h-3 border-[#dc1e28]";
  const cls = {
    tl: "top-1 left-1 border-t border-l",
    tr: "top-1 right-1 border-t border-r",
    bl: "bottom-1 left-1 border-b border-l",
    br: "bottom-1 right-1 border-b border-r",
  }[pos];
  return <div aria-hidden className={`${base} ${cls}`} />;
}
