import { useEffect, useRef } from "react";

const GLYPHS =
  "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン" +
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ!@#$%^&*[]<>|/\\=+~";

const FONT_SIZE = 13;
const TRAIL = 14;
const INTERVAL_MS = 70;

export function MatrixRain() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReduced) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animId = 0;
    let lastTime = 0;

    type Column = { y: number; chars: string[] };
    let cols: Column[] = [];

    const init = () => {
      const count = Math.floor(canvas.width / FONT_SIZE);
      cols = Array.from({ length: count }, () => ({
        y: Math.floor(Math.random() * -(canvas.height / FONT_SIZE)),
        chars: Array.from({ length: TRAIL }, () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)]),
      }));
    };

    const resize = () => {
      canvas.width = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
      init();
    };

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    ctx.font = `${FONT_SIZE}px "Courier New", monospace`;

    const draw = (now: number) => {
      animId = requestAnimationFrame(draw);
      if (now - lastTime < INTERVAL_MS) return;
      lastTime = now;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      for (let i = 0; i < cols.length; i++) {
        const col = cols[i];
        const x = i * FONT_SIZE + 1;

        for (let t = 0; t < TRAIL; t++) {
          const yPx = (col.y - t) * FONT_SIZE;
          if (yPx < -FONT_SIZE || yPx > canvas.height) continue;

          const brightness = t === 0 ? 1 : (1 - t / TRAIL) * 0.7;
          ctx.fillStyle =
            t === 0
              ? `rgba(255, 60, 60, ${brightness})`
              : `rgba(160, 0, 0, ${brightness})`;
          ctx.fillText(col.chars[t], x, yPx);
        }

        col.y += 1;
        if (col.y * FONT_SIZE > canvas.height + TRAIL * FONT_SIZE) {
          col.y = Math.floor(Math.random() * -20);
          col.chars = Array.from({ length: TRAIL }, () =>
            GLYPHS[Math.floor(Math.random() * GLYPHS.length)],
          );
        }

        if (Math.random() < 0.04) {
          col.chars[0] = GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
        }
      }
    };

    animId = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(animId);
      ro.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="absolute inset-0 w-full h-full pointer-events-none"
      style={{ opacity: 0.18, zIndex: 0 }}
    />
  );
}
