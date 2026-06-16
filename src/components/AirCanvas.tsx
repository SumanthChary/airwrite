import { useEffect, useRef, useState, useCallback } from "react";

declare global {
  interface Window {
    Hands: any;
    Camera: any;
  }
}

const CDN_SCRIPTS = [
  "https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js",
  "https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js",
];

function loadScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.crossOrigin = "anonymous";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

type Stroke = {
  points: { x: number; y: number }[];
  color: string;
  size: number;
};

const PALETTE = ["#a78bfa", "#f0abfc", "#5eead4", "#fde047", "#fb923c", "#f87171", "#ffffff"];

export default function AirCanvas() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const strokesRef = useRef<Stroke[]>([]);
  const currentStrokeRef = useRef<Stroke | null>(null);
  const lastSmoothedRef = useRef<{ x: number; y: number } | null>(null);

  const colorRef = useRef("#a78bfa");
  const sizeRef = useRef(6);
  const drawingEnabledRef = useRef(true);
  const showCameraRef = useRef(true);

  const [color, setColor] = useState("#a78bfa");
  const [size, setSize] = useState(6);
  const [status, setStatus] = useState("Loading hand tracking…");
  const [ready, setReady] = useState(false);
  const [fingerState, setFingerState] = useState<"idle" | "drawing" | "hover">("idle");
  const [showCamera, setShowCamera] = useState(true);
  const [drawingEnabled, setDrawingEnabled] = useState(true);

  useEffect(() => { colorRef.current = color; }, [color]);
  useEffect(() => { sizeRef.current = size; }, [size]);
  useEffect(() => { drawingEnabledRef.current = drawingEnabled; }, [drawingEnabled]);
  useEffect(() => { showCameraRef.current = showCamera; }, [showCamera]);

  const redraw = useCallback(() => {
    const c = drawRef.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const all = [...strokesRef.current];
    if (currentStrokeRef.current) all.push(currentStrokeRef.current);
    for (const s of all) {
      if (s.points.length < 2) continue;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.size;
      ctx.shadowColor = s.color;
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.moveTo(s.points[0].x, s.points[0].y);
      for (let i = 1; i < s.points.length; i++) {
        const p = s.points[i];
        const prev = s.points[i - 1];
        const mx = (prev.x + p.x) / 2;
        const my = (prev.y + p.y) / 2;
        ctx.quadraticCurveTo(prev.x, prev.y, mx, my);
      }
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
  }, []);

  const clearAll = useCallback(() => {
    strokesRef.current = [];
    currentStrokeRef.current = null;
    redraw();
  }, [redraw]);

  const undo = useCallback(() => {
    strokesRef.current.pop();
    redraw();
  }, [redraw]);

  const save = useCallback(() => {
    const c = drawRef.current;
    if (!c) return;
    const out = document.createElement("canvas");
    out.width = c.width;
    out.height = c.height;
    const ctx = out.getContext("2d")!;
    ctx.fillStyle = "#0a0a0f";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(c, 0, 0);
    const url = out.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = url;
    a.download = `aircanvas-${Date.now()}.png`;
    a.click();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let camera: any;
    let hands: any;
    let rafResize: number;

    const resize = () => {
      const cont = containerRef.current;
      if (!cont || !drawRef.current || !overlayRef.current) return;
      const w = cont.clientWidth;
      const h = cont.clientHeight;
      [drawRef.current, overlayRef.current].forEach((cv) => {
        if (cv.width !== w || cv.height !== h) {
          // Preserve drawing on resize
          if (cv === drawRef.current) {
            cv.width = w;
            cv.height = h;
          } else {
            cv.width = w;
            cv.height = h;
          }
        }
      });
      redraw();
    };

    const onResize = () => {
      cancelAnimationFrame(rafResize);
      rafResize = requestAnimationFrame(resize);
    };

    const onResults = (results: any) => {
      const overlay = overlayRef.current;
      const cont = containerRef.current;
      if (!overlay || !cont) return;
      const ctx = overlay.getContext("2d")!;
      ctx.clearRect(0, 0, overlay.width, overlay.height);

      if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
        setFingerState("idle");
        if (currentStrokeRef.current) {
          if (currentStrokeRef.current.points.length > 1) {
            strokesRef.current.push(currentStrokeRef.current);
          }
          currentStrokeRef.current = null;
          lastSmoothedRef.current = null;
          redraw();
        }
        return;
      }

      const lm = results.multiHandLandmarks[0];
      const W = overlay.width;
      const H = overlay.height;

      // Mirror X
      const toPx = (p: any) => ({ x: (1 - p.x) * W, y: p.y * H });

      const tip = toPx(lm[8]);
      const pip = lm[6];
      const indexExtended = lm[8].y < pip.y - 0.02;

      // Pinch detection: thumb tip (4) close to index tip (8)
      const thumbTip = toPx(lm[4]);
      const dx = thumbTip.x - tip.x;
      const dy = thumbTip.y - tip.y;
      const pinchDist = Math.hypot(dx, dy);
      const refDist = Math.hypot((toPx(lm[0]).x - toPx(lm[5]).x), (toPx(lm[0]).y - toPx(lm[5]).y));
      const pinching = pinchDist < refDist * 0.45;

      const isDrawing = drawingEnabledRef.current && indexExtended && pinching;

      // Smoothing
      const smoothed = lastSmoothedRef.current
        ? { x: lastSmoothedRef.current.x * 0.55 + tip.x * 0.45, y: lastSmoothedRef.current.y * 0.55 + tip.y * 0.45 }
        : tip;
      lastSmoothedRef.current = smoothed;

      if (isDrawing) {
        setFingerState("drawing");
        if (!currentStrokeRef.current) {
          currentStrokeRef.current = { points: [smoothed], color: colorRef.current, size: sizeRef.current };
        } else {
          const pts = currentStrokeRef.current.points;
          const last = pts[pts.length - 1];
          if (Math.hypot(last.x - smoothed.x, last.y - smoothed.y) > 1.2) {
            pts.push(smoothed);
          }
        }
        redraw();
      } else {
        setFingerState(indexExtended ? "hover" : "idle");
        if (currentStrokeRef.current) {
          if (currentStrokeRef.current.points.length > 1) {
            strokesRef.current.push(currentStrokeRef.current);
          }
          currentStrokeRef.current = null;
          lastSmoothedRef.current = null;
          redraw();
        }
      }

      // Draw cursor
      ctx.save();
      const cursorColor = isDrawing ? colorRef.current : "#ffffff";
      ctx.shadowColor = cursorColor;
      ctx.shadowBlur = 24;
      ctx.fillStyle = cursorColor;
      ctx.beginPath();
      ctx.arc(smoothed.x, smoothed.y, isDrawing ? sizeRef.current + 4 : 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(smoothed.x, smoothed.y, isDrawing ? sizeRef.current + 14 : 18, 0, Math.PI * 2);
      ctx.stroke();

      // Connect thumb-index line when pinching
      if (pinching) {
        ctx.strokeStyle = "rgba(255,255,255,0.4)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(thumbTip.x, thumbTip.y);
        ctx.lineTo(tip.x, tip.y);
        ctx.stroke();
      }
      ctx.restore();
    };

    (async () => {
      try {
        for (const src of CDN_SCRIPTS) await loadScript(src);
        if (cancelled) return;

        resize();
        window.addEventListener("resize", onResize);

        hands = new window.Hands({
          locateFile: (file: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
        });
        hands.setOptions({
          maxNumHands: 1,
          modelComplexity: 0,
          minDetectionConfidence: 0.6,
          minTrackingConfidence: 0.6,
        });
        hands.onResults(onResults);

        setStatus("Requesting camera…");
        camera = new window.Camera(videoRef.current!, {
          onFrame: async () => {
            if (videoRef.current) await hands.send({ image: videoRef.current });
          },
          width: 1280,
          height: 720,
        });
        await camera.start();
        if (cancelled) return;
        setReady(true);
        setStatus("Pinch thumb + index to draw");
      } catch (e: any) {
        console.error(e);
        setStatus(e?.message || "Camera/hand tracking failed");
      }
    })();

    return () => {
      cancelled = true;
      window.removeEventListener("resize", onResize);
      try { camera?.stop?.(); } catch {}
      try { hands?.close?.(); } catch {}
    };
  }, [redraw]);

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#08080c] text-white">
      {/* Ambient gradient */}
      <div className="pointer-events-none absolute inset-0 opacity-60"
        style={{ background: "radial-gradient(1200px 600px at 20% 10%, rgba(124,90,240,0.25), transparent), radial-gradient(900px 500px at 90% 90%, rgba(224,90,240,0.18), transparent)" }} />

      <div ref={containerRef} className="absolute inset-0">
        <video
          ref={videoRef}
          playsInline
          muted
          className="absolute inset-0 h-full w-full object-cover"
          style={{ transform: "scaleX(-1)", opacity: showCamera ? 0.55 : 0, transition: "opacity 300ms" }}
        />
        <canvas ref={drawRef} className="absolute inset-0 h-full w-full" />
        <canvas ref={overlayRef} className="absolute inset-0 h-full w-full pointer-events-none" />
      </div>

      {/* Top bar */}
      <div className="absolute left-1/2 top-5 z-10 -translate-x-1/2">
        <div className="flex items-center gap-3 rounded-full border border-white/10 bg-black/40 px-5 py-2.5 backdrop-blur-xl">
          <div className={`h-2 w-2 rounded-full ${ready ? "bg-emerald-400 shadow-[0_0_10px_rgba(74,240,168,0.8)]" : "bg-amber-400 animate-pulse"}`} />
          <span className="text-xs font-mono tracking-wide text-white/80">{status}</span>
          <span className="h-3 w-px bg-white/15" />
          <span className={`text-xs font-mono ${fingerState === "drawing" ? "text-fuchsia-300" : fingerState === "hover" ? "text-white/70" : "text-white/40"}`}>
            {fingerState === "drawing" ? "● DRAWING" : fingerState === "hover" ? "○ HOVER" : "— IDLE"}
          </span>
        </div>
      </div>

      {/* Title */}
      <div className="absolute left-6 top-6 z-10">
        <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-white/40">AirCanvas</div>
        <div className="mt-1 font-serif text-2xl italic text-white/90">draw the air.</div>
      </div>

      {/* Bottom panel */}
      <div className="absolute bottom-6 left-1/2 z-10 -translate-x-1/2">
        <div className="flex items-center gap-4 rounded-2xl border border-white/10 bg-black/50 px-5 py-4 backdrop-blur-xl shadow-2xl">
          {/* Colors */}
          <div className="flex items-center gap-2">
            {PALETTE.map((c) => (
              <button
                key={c}
                onClick={() => setColor(c)}
                className="relative h-7 w-7 rounded-full transition-transform hover:scale-110"
                style={{
                  background: c,
                  boxShadow: color === c ? `0 0 0 2px #0a0a0f, 0 0 0 4px ${c}, 0 0 20px ${c}` : `0 0 10px ${c}80`,
                }}
                aria-label={`Color ${c}`}
              />
            ))}
          </div>

          <span className="h-8 w-px bg-white/15" />

          {/* Size */}
          <div className="flex items-center gap-3">
            <span className="font-mono text-[10px] uppercase tracking-wider text-white/50">size</span>
            <input
              type="range" min={2} max={24} value={size}
              onChange={(e) => setSize(parseInt(e.target.value))}
              className="w-28 accent-fuchsia-400"
            />
            <span className="w-6 font-mono text-xs text-white/70">{size}</span>
          </div>

          <span className="h-8 w-px bg-white/15" />

          {/* Actions */}
          <button onClick={() => setDrawingEnabled((v) => !v)}
            className={`rounded-lg px-3 py-1.5 font-mono text-xs uppercase tracking-wider transition ${drawingEnabled ? "bg-white/10 text-white hover:bg-white/20" : "bg-amber-500/20 text-amber-200 hover:bg-amber-500/30"}`}>
            {drawingEnabled ? "Pause" : "Resume"}
          </button>
          <button onClick={undo} className="rounded-lg bg-white/10 px-3 py-1.5 font-mono text-xs uppercase tracking-wider text-white hover:bg-white/20">Undo</button>
          <button onClick={clearAll} className="rounded-lg bg-white/10 px-3 py-1.5 font-mono text-xs uppercase tracking-wider text-white hover:bg-white/20">Clear</button>
          <button onClick={save} className="rounded-lg bg-gradient-to-r from-violet-500 to-fuchsia-500 px-4 py-1.5 font-mono text-xs uppercase tracking-wider text-white shadow-lg shadow-fuchsia-500/30 hover:brightness-110">Save</button>
          <button onClick={() => setShowCamera((v) => !v)} className="rounded-lg bg-white/10 px-3 py-1.5 font-mono text-xs uppercase tracking-wider text-white hover:bg-white/20">
            {showCamera ? "Hide Cam" : "Show Cam"}
          </button>
        </div>
      </div>

      {/* Hint */}
      <div className="absolute bottom-28 left-1/2 z-10 -translate-x-1/2 text-center">
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-white/30">
          pinch thumb + index • move to draw • open hand to lift
        </p>
      </div>
    </div>
  );
}
