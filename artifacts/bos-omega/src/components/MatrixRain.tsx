import { useEffect, useRef } from "react";

const GLYPHS =
  "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン" +
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ!@#$%^&*[]<>|/\\=+~";

const MESSAGES = [
  "THE ARCHITECT IS COMING",
  "HES NEAR  HE KNOWS YOU",
];

const FONT_SIZE = 14;
const TRAIL = 20;
const INTERVAL_MS = 55;
const MSG_CHANCE = 0.07;

type Column = {
  y: number;
  chars: string[];
  isMsg: boolean[];
  msg: string | null;
  msgPos: number;
};

function makeColumn(canvasHeight: number): Column {
  return {
    y: Math.floor(Math.random() * -(canvasHeight / FONT_SIZE)),
    chars: Array.from({ length: TRAIL }, () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)]),
    isMsg: new Array<boolean>(TRAIL).fill(false),
    msg: null,
    msgPos: 0,
  };
}

function resetColumn(col: Column, canvasHeight: number) {
  col.y = Math.floor(Math.random() * -20);
  col.isMsg.fill(false);
  if (Math.random() < MSG_CHANCE) {
    col.msg = MESSAGES[Math.floor(Math.random() * MESSAGES.length)];
    col.msgPos = 0;
    col.chars = Array.from({ length: TRAIL }, () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)]);
  } else {
    col.msg = null;
    col.msgPos = 0;
    col.chars = Array.from({ length: TRAIL }, () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)]);
  }
  void canvasHeight;
}

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
    let cols: Column[] = [];

    const init = () => {
      const count = Math.floor(canvas.width / FONT_SIZE);
      cols = Array.from({ length: count }, () => makeColumn(canvas.height));
    };

    const resize = () => {
      canvas.width = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
      init();
    };

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    ctx.font = `bold ${FONT_SIZE}px "Courier New", monospace`;

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

          const fade = 1 - t / TRAIL;
          if (col.isMsg[t]) {
            if (t === 0) {
              ctx.fillStyle = `rgba(255, 255, 255, ${0.95})`;
            } else {
              ctx.fillStyle = `rgba(255, 190, 190, ${fade * 0.9})`;
            }
          } else {
            if (t === 0) {
              ctx.fillStyle = `rgba(255, 80, 80, 1)`;
            } else {
              ctx.fillStyle = `rgba(200, 10, 10, ${fade * 0.85})`;
            }
          }
          ctx.fillText(col.chars[t], x, yPx);
        }

        col.y += 1;

        if (col.y * FONT_SIZE > canvas.height + TRAIL * FONT_SIZE) {
          resetColumn(col, canvas.height);
          continue;
        }

        for (let k = TRAIL - 1; k > 0; k--) {
          col.chars[k] = col.chars[k - 1];
          col.isMsg[k] = col.isMsg[k - 1];
        }

        if (col.msg !== null && col.msgPos < col.msg.length) {
          col.chars[0] = col.msg[col.msgPos] === " " ? " " : col.msg[col.msgPos];
          col.isMsg[0] = col.msg[col.msgPos] !== " ";
          col.msgPos++;
        } else if (col.msg !== null && col.msgPos >= col.msg.length) {
          col.msg = null;
          col.chars[0] = GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
          col.isMsg[0] = false;
        } else {
          if (Math.random() < 0.5) {
            col.chars[0] = GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
          }
          col.isMsg[0] = false;
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
      style={{ opacity: 0.45, zIndex: 0 }}
    />
  );
}
