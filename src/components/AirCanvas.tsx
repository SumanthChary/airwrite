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

type Pt = { x: number; y: number };
type Stroke = {
  points: Pt[];
  color: string;
  size: number;
  tool: "pen" | "eraser";
};

// White / black + 1 primary accent (electric coral) + supporting hues
const PRIMARY = "#FF4D2E";
const PALETTE = [
  "#111111", // ink
  PRIMARY,   // electric coral
  "#ffffff", // white
  "#9ca3af", // gray
  "#F5C518", // amber
  "#22C55E", // green
  "#3B82F6", // blue
  "#8B5CF6", // violet
  "#EC4899", // pink
];

export default function AirCanvas() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const dwellRingRef = useRef<HTMLDivElement>(null);

  const strokesRef = useRef<Stroke[]>([]);
  const redoRef = useRef<Stroke[]>([]);
  const currentStrokeRef = useRef<Stroke | null>(null);
  const smoothBufRef = useRef<Pt[]>([]);
  const lastEmitRef = useRef<Pt | null>(null);

  const colorRef = useRef<string>(PRIMARY);
  const sizeRef = useRef(6);
  const toolRef = useRef<"pen" | "eraser">("pen");
  const drawingEnabledRef = useRef(true);

  // Hand-click state (refs to avoid re-renders inside the tracking loop)
  const pinchPrevRef = useRef(false);
  const hoverTargetRef = useRef<HTMLElement | null>(null);
  const dwellStartRef = useRef<number>(0);
  const lastClickAtRef = useRef<number>(0);

  const [color, setColor] = useState<string>(PRIMARY);
  const [size, setSize] = useState(6);
  const [tool, setTool] = useState<"pen" | "eraser">("pen");
  const [status, setStatus] = useState("Loading hand tracking…");
  const [ready, setReady] = useState(false);
  const [fingerState, setFingerState] = useState<"idle" | "drawing" | "hover">("idle");
  const [camOpacity, setCamOpacity] = useState(1);
  const [drawingEnabled, setDrawingEnabled] = useState(true);
  const [panelOpen, setPanelOpen] = useState(true);
  const [recording, setRecording] = useState(false);
  const [started, setStarted] = useState(false);
  const [camError, setCamError] = useState<string | null>(null);
  const startingRef = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordChunksRef = useRef<Blob[]>([]);

  useEffect(() => { colorRef.current = color; }, [color]);
  useEffect(() => { sizeRef.current = size; }, [size]);
  useEffect(() => { toolRef.current = tool; }, [tool]);
  useEffect(() => { drawingEnabledRef.current = drawingEnabled; }, [drawingEnabled]);

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
      if (s.points.length < 1) continue;
      ctx.globalCompositeOperation = s.tool === "eraser" ? "destination-out" : "source-over";
      ctx.strokeStyle = s.color;
      ctx.fillStyle = s.color;
      ctx.lineWidth = s.size;
      if (s.tool === "pen") {
        ctx.shadowColor = s.color;
        ctx.shadowBlur = 8;
      } else {
        ctx.shadowBlur = 0;
      }

      if (s.points.length === 1) {
        const p = s.points[0];
        ctx.beginPath();
        ctx.arc(p.x, p.y, s.size / 2, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }

      ctx.beginPath();
      ctx.moveTo(s.points[0].x, s.points[0].y);
      const pts = s.points;
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i - 1] || pts[i];
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const p3 = pts[i + 2] || p2;
        const cp1x = p1.x + (p2.x - p0.x) / 6;
        const cp1y = p1.y + (p2.y - p0.y) / 6;
        const cp2x = p2.x - (p3.x - p1.x) / 6;
        const cp2y = p2.y - (p3.y - p1.y) / 6;
        ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
      }
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.shadowBlur = 0;
  }, []);

  const commitStroke = useCallback(() => {
    if (currentStrokeRef.current && currentStrokeRef.current.points.length > 0) {
      strokesRef.current.push(currentStrokeRef.current);
      redoRef.current = [];
    }
    currentStrokeRef.current = null;
    smoothBufRef.current = [];
    lastEmitRef.current = null;
  }, []);

  const clearAll = useCallback(() => {
    strokesRef.current = [];
    redoRef.current = [];
    currentStrokeRef.current = null;
    redraw();
  }, [redraw]);

  const undo = useCallback(() => {
    const s = strokesRef.current.pop();
    if (s) redoRef.current.push(s);
    redraw();
  }, [redraw]);

  const redo = useCallback(() => {
    const s = redoRef.current.pop();
    if (s) strokesRef.current.push(s);
    redraw();
  }, [redraw]);

  const save = useCallback(() => {
    const c = drawRef.current;
    if (!c) return;
    const out = document.createElement("canvas");
    out.width = c.width;
    out.height = c.height;
    const ctx = out.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(c, 0, 0);
    const a = document.createElement("a");
    a.href = out.toDataURL("image/png");
    a.download = `airwrite-${Date.now()}.png`;
    a.click();
  }, []);

  const toggleRecord = useCallback(async () => {
    if (recording) { recorderRef.current?.stop(); return; }
    try {
      const stream = await (navigator.mediaDevices as any).getDisplayMedia({
        video: { frameRate: 30 }, audio: false,
      });
      const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
        ? "video/webm;codecs=vp9" : "video/webm";
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
      recordChunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size > 0) recordChunksRef.current.push(e.data); };
      rec.onstop = () => {
        stream.getTracks().forEach((t: MediaStreamTrack) => t.stop());
        const blob = new Blob(recordChunksRef.current, { type: "video/webm" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `airwrite-${Date.now()}.webm`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        setRecording(false);
      };
      stream.getVideoTracks()[0].addEventListener("ended", () => rec.state !== "inactive" && rec.stop());
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
    } catch (e) { console.error(e); setRecording(false); }
  }, [recording]);

  // Stable callbacks the camera loop will use
  const onResultsRef = useRef<(r: any) => void>(() => {});
  const resizeRef = useRef<() => void>(() => {});

  // Mount: preload MediaPipe scripts + handle resize. No camera permission yet.
  useEffect(() => {
    let rafResize: number;

    const resize = () => {
      const cont = containerRef.current;
      if (!cont || !drawRef.current || !overlayRef.current) return;
      const w = cont.clientWidth;
      const h = cont.clientHeight;
      const old = document.createElement("canvas");
      old.width = drawRef.current.width;
      old.height = drawRef.current.height;
      if (old.width && old.height) old.getContext("2d")!.drawImage(drawRef.current, 0, 0);
      drawRef.current.width = w; drawRef.current.height = h;
      overlayRef.current.width = w; overlayRef.current.height = h;
      if (old.width && old.height) drawRef.current.getContext("2d")!.drawImage(old, 0, 0, w, h);
      redraw();
    };
    resizeRef.current = resize;
    const onResize = () => { cancelAnimationFrame(rafResize); rafResize = requestAnimationFrame(resize); };

    const findHandTarget = (x: number, y: number): HTMLElement | null => {
      const els = document.elementsFromPoint(x, y);
      for (const el of els) {
        const t = (el as HTMLElement).closest?.("[data-hand-target]") as HTMLElement | null;
        if (t) return t;
      }
      return null;
    };

    onResultsRef.current = (results: any) => {
      const overlay = overlayRef.current;
      const cont = containerRef.current;
      if (!overlay || !cont) return;
      const octx = overlay.getContext("2d")!;
      octx.clearRect(0, 0, overlay.width, overlay.height);

      const cursor = cursorRef.current;
      const dwellRing = dwellRingRef.current;

      if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
        setFingerState("idle");
        if (currentStrokeRef.current) { commitStroke(); redraw(); }
        if (cursor) cursor.style.opacity = "0";
        if (dwellRing) dwellRing.style.opacity = "0";
        hoverTargetRef.current?.removeAttribute("data-hand-hover");
        hoverTargetRef.current = null;
        dwellStartRef.current = 0;
        pinchPrevRef.current = false;
        return;
      }

      const lm = results.multiHandLandmarks[0];
      const W = overlay.width;
      const H = overlay.height;
      const toPx = (p: any) => ({ x: (1 - p.x) * W, y: p.y * H });

      const tip = toPx(lm[8]);
      const pip = lm[6];
      const indexExtended = lm[8].y < pip.y - 0.02;
      const thumbTip = toPx(lm[4]);
      const pinchDist = Math.hypot(thumbTip.x - tip.x, thumbTip.y - tip.y);
      const refDist = Math.hypot(toPx(lm[0]).x - toPx(lm[5]).x, toPx(lm[0]).y - toPx(lm[5]).y);
      const pinching = pinchDist < refDist * 0.45;

      const buf = smoothBufRef.current;
      buf.push(tip);
      if (buf.length > 5) buf.shift();
      const sx = buf.reduce((a, b) => a + b.x, 0) / buf.length;
      const sy = buf.reduce((a, b) => a + b.y, 0) / buf.length;
      const smoothed: Pt = { x: sx, y: sy };

      const rect = cont.getBoundingClientRect();
      const vx = smoothed.x + rect.left;
      const vy = smoothed.y + rect.top;

      const target = findHandTarget(vx, vy);
      const prev = hoverTargetRef.current;
      if (target !== prev) {
        prev?.removeAttribute("data-hand-hover");
        target?.setAttribute("data-hand-hover", "true");
        hoverTargetRef.current = target;
        dwellStartRef.current = target ? performance.now() : 0;
      }

      const now = performance.now();
      const DWELL_MS = 600;

      if (target) {
        const elapsed = now - dwellStartRef.current;
        if (dwellRing) {
          dwellRing.style.opacity = "1";
          const pct = Math.min(1, elapsed / DWELL_MS);
          dwellRing.style.background = `conic-gradient(${PRIMARY} ${pct * 360}deg, rgba(0,0,0,0.15) 0deg)`;
        }
        if (elapsed >= DWELL_MS && now - lastClickAtRef.current > 800) {
          target.click();
          lastClickAtRef.current = now;
          dwellStartRef.current = now + 400;
        }
        if (pinching && !pinchPrevRef.current && now - lastClickAtRef.current > 400) {
          target.click();
          lastClickAtRef.current = now;
        }
      } else {
        if (dwellRing) dwellRing.style.opacity = "0";
      }

      const isDrawing = !target && drawingEnabledRef.current && indexExtended && pinching;

      if (isDrawing) {
        setFingerState("drawing");
        if (!currentStrokeRef.current) {
          currentStrokeRef.current = {
            points: [smoothed],
            color: colorRef.current,
            size: toolRef.current === "eraser" ? sizeRef.current * 3 : sizeRef.current,
            tool: toolRef.current,
          };
          lastEmitRef.current = smoothed;
        } else {
          const last = lastEmitRef.current!;
          if (Math.hypot(last.x - smoothed.x, last.y - smoothed.y) > 1.5) {
            currentStrokeRef.current.points.push(smoothed);
            lastEmitRef.current = smoothed;
          }
        }
        redraw();
      } else {
        setFingerState(target ? "hover" : indexExtended ? "hover" : "idle");
        if (currentStrokeRef.current) { commitStroke(); redraw(); }
      }

      pinchPrevRef.current = pinching;

      if (cursor) {
        cursor.style.opacity = "1";
        cursor.style.transform = `translate(${vx}px, ${vy}px) translate(-50%, -50%)`;
        const isEraser = toolRef.current === "eraser";
        const baseColor = target ? PRIMARY : isEraser ? "#111111" : isDrawing ? colorRef.current : "#111111";
        cursor.style.background = pinching ? baseColor : "transparent";
        cursor.style.borderColor = baseColor;
      }
      if (dwellRing) {
        dwellRing.style.transform = `translate(${vx}px, ${vy}px) translate(-50%, -50%)`;
      }

      if (pinching && !target) {
        octx.save();
        octx.strokeStyle = "rgba(17,17,17,0.45)";
        octx.lineWidth = 1;
        octx.beginPath();
        octx.moveTo(thumbTip.x, thumbTip.y);
        octx.lineTo(tip.x, tip.y);
        octx.stroke();
        octx.restore();
      }
    };

    resize();
    window.addEventListener("resize", onResize);

    // Preload MediaPipe in the background (no camera prompt yet).
    (async () => {
      try {
        for (const src of CDN_SCRIPTS) await loadScript(src);
        setStatus("Click “Enable Camera” to begin");
      } catch (e: any) {
        setStatus("Failed to load hand-tracking scripts");
        console.error(e);
      }
    })();

    return () => {
      window.removeEventListener("resize", onResize);
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, [redraw, commitStroke]);

  // Triggered by an explicit user click — required for camera permission.
  const startCamera = useCallback(async () => {
    if (startingRef.current || started) return;
    startingRef.current = true;
    setCamError(null);
    setStatus("Requesting camera…");
    try {
      if (!window.Hands || !window.Camera) {
        for (const src of CDN_SCRIPTS) await loadScript(src);
      }

      // Prime the permission prompt directly from the user gesture.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
        audio: false,
      });
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play().catch(() => {});

      const hands = new window.Hands({
        locateFile: (file: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
      });
      hands.setOptions({
        maxNumHands: 1,
        modelComplexity: 0,
        minDetectionConfidence: 0.6,
        minTrackingConfidence: 0.6,
      });
      hands.onResults((r: any) => onResultsRef.current(r));

      // Drive frames ourselves so we keep using the gesture-granted stream.
      let stopped = false;
      const loop = async () => {
        if (stopped) return;
        if (video.readyState >= 2) {
          try { await hands.send({ image: video }); } catch {}
        }
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);

      cleanupRef.current = () => {
        stopped = true;
        try { stream.getTracks().forEach((t) => t.stop()); } catch {}
        try { hands.close?.(); } catch {}
      };

      setStarted(true);
      setReady(true);
      setStatus("Pinch to draw · hover a button to click");
      // Ensure canvas matches container now that video is live.
      requestAnimationFrame(() => resizeRef.current());
    } catch (e: any) {
      console.error(e);
      const name = e?.name || "";
      const msg =
        name === "NotAllowedError"
          ? "Camera permission was blocked. Allow it in your browser, then click Retry."
          : name === "NotFoundError"
          ? "No camera found on this device."
          : name === "NotReadableError"
          ? "Camera is in use by another app."
          : e?.message || "Could not start the camera.";
      setCamError(msg);
      setStatus(msg);
    } finally {
      startingRef.current = false;
    }
  }, [started]);

  // Reusable button class (white surface, black text, primary accent on hover/active)
  const btn = "rounded-lg border border-black/10 bg-white px-2.5 sm:px-3 py-1.5 font-mono text-[10px] sm:text-xs uppercase tracking-wider text-black transition hover:border-[var(--aw-primary)] hover:text-[var(--aw-primary)] data-[hand-hover=true]:bg-[var(--aw-primary)] data-[hand-hover=true]:text-white data-[hand-hover=true]:border-[var(--aw-primary)]";

  return (
    <div
      className="relative h-[100dvh] w-screen overflow-hidden bg-white text-black select-none"
      style={{ ["--aw-primary" as any]: PRIMARY }}
    >
      {/* Subtle paper noise */}
      <div className="pointer-events-none absolute inset-0 opacity-[0.04]"
        style={{ backgroundImage: "radial-gradient(#000 1px, transparent 1px)", backgroundSize: "3px 3px" }} />

      <div ref={containerRef} className="absolute inset-0">
        <video
          ref={videoRef}
          playsInline
          muted
          className="absolute inset-0 h-full w-full object-cover"
          style={{ transform: "scaleX(-1)", opacity: camOpacity, transition: "opacity 300ms" }}
        />
        <canvas ref={drawRef} className="absolute inset-0 h-full w-full" />
        <canvas ref={overlayRef} className="absolute inset-0 h-full w-full pointer-events-none" />
      </div>

      {/* Top bar */}
      <div className="absolute left-1/2 top-3 z-10 -translate-x-1/2 px-2 w-[min(96vw,640px)]">
        <div className="flex items-center justify-center gap-2 sm:gap-3 rounded-full border border-black/10 bg-white/85 px-3 sm:px-5 py-2 backdrop-blur-xl shadow-sm">
          <div
            className={`h-2 w-2 shrink-0 rounded-full ${ready ? "" : "animate-pulse"}`}
            style={{ background: ready ? PRIMARY : "#000", boxShadow: ready ? `0 0 10px ${PRIMARY}` : "none" }}
          />
          <span className="truncate text-[10px] sm:text-xs font-mono tracking-wide text-black/80">{status}</span>
          <span className="hidden sm:block h-3 w-px bg-black/15" />
          <span className={`hidden sm:inline text-xs font-mono shrink-0 ${fingerState === "drawing" ? "" : fingerState === "hover" ? "text-black/70" : "text-black/40"}`}
            style={fingerState === "drawing" ? { color: PRIMARY } : undefined}>
            {fingerState === "drawing" ? "● DRAWING" : fingerState === "hover" ? "○ HOVER" : "— IDLE"}
          </span>
        </div>
      </div>

      {/* Brand */}
      <div className="absolute left-4 top-16 sm:left-6 sm:top-6 z-10">
        <div className="font-mono text-[9px] sm:text-[10px] uppercase tracking-[0.35em] text-black/40">a hand-tracked canvas</div>
        <div className="mt-1 text-2xl sm:text-4xl font-black tracking-tight text-black">
          air<span style={{ color: PRIMARY }}>write</span>
          <span className="ml-1 inline-block h-2 w-2 align-baseline rounded-full" style={{ background: PRIMARY }} />
        </div>
      </div>

      {/* Record indicator */}
      {recording && (
        <div className="absolute right-4 top-16 sm:top-6 z-10 flex items-center gap-2 rounded-full border border-black/10 bg-white/85 px-3 py-1.5 backdrop-blur-xl">
          <span className="h-2 w-2 rounded-full animate-pulse" style={{ background: PRIMARY }} />
          <span className="font-mono text-[10px] uppercase tracking-wider" style={{ color: PRIMARY }}>REC</span>
        </div>
      )}

      {/* Panel toggle (mobile) */}
      <button
        data-hand-target
        onClick={() => setPanelOpen((v) => !v)}
        className={`${btn} absolute bottom-3 right-3 z-20 sm:hidden`}
      >
        {panelOpen ? "Hide" : "Tools"}
      </button>

      {/* Bottom panel */}
      <div
        className={`absolute bottom-3 sm:bottom-6 left-1/2 z-10 -translate-x-1/2 w-[min(96vw,960px)] transition-all duration-300 ${
          panelOpen ? "opacity-100 translate-y-0" : "opacity-0 translate-y-6 pointer-events-none"
        }`}
      >
        <div className="rounded-2xl border border-black/10 bg-white/90 px-3 sm:px-5 py-3 sm:py-4 backdrop-blur-xl shadow-xl">
          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-3 sm:gap-x-4">
            {/* Tools */}
            <div className="flex items-center gap-1 rounded-xl bg-black/5 p-1">
              <button data-hand-target onClick={() => setTool("pen")}
                className={`rounded-lg px-3 py-1.5 font-mono text-[10px] sm:text-xs uppercase tracking-wider transition ${tool === "pen" ? "text-white" : "text-black/60 hover:text-black"} data-[hand-hover=true]:ring-2`}
                style={tool === "pen" ? { background: PRIMARY } : undefined}>
                Pen
              </button>
              <button data-hand-target onClick={() => setTool("eraser")}
                className={`rounded-lg px-3 py-1.5 font-mono text-[10px] sm:text-xs uppercase tracking-wider transition ${tool === "eraser" ? "bg-black text-white" : "text-black/60 hover:text-black"} data-[hand-hover=true]:ring-2`}>
                Eraser
              </button>
            </div>

            {/* Colors */}
            <div className="flex items-center gap-1.5 sm:gap-2">
              {PALETTE.map((c) => (
                <button
                  key={c}
                  data-hand-target
                  onClick={() => { setColor(c); setTool("pen"); }}
                  className="relative h-6 w-6 sm:h-7 sm:w-7 rounded-full border border-black/10 transition-transform hover:scale-110 data-[hand-hover=true]:scale-125"
                  style={{
                    background: c,
                    boxShadow: color === c && tool === "pen" ? `0 0 0 2px #fff, 0 0 0 4px ${PRIMARY}` : "none",
                  }}
                  aria-label={`Color ${c}`}
                />
              ))}
            </div>

            {/* Size */}
            <div className="flex items-center gap-2 sm:gap-3">
              <span className="font-mono text-[9px] sm:text-[10px] uppercase tracking-wider text-black/50">size</span>
              <input
                type="range" min={2} max={28} value={size}
                onChange={(e) => setSize(parseInt(e.target.value))}
                className="w-20 sm:w-28"
                style={{ accentColor: PRIMARY }}
              />
              <span className="w-5 font-mono text-[10px] sm:text-xs text-black/70">{size}</span>
            </div>

            {/* Cam */}
            <div className="flex items-center gap-2 sm:gap-3">
              <span className="font-mono text-[9px] sm:text-[10px] uppercase tracking-wider text-black/50">cam</span>
              <input
                type="range" min={0} max={100} value={Math.round(camOpacity * 100)}
                onChange={(e) => setCamOpacity(parseInt(e.target.value) / 100)}
                className="w-20 sm:w-24"
                style={{ accentColor: PRIMARY }}
              />
            </div>

            {/* Actions */}
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button data-hand-target onClick={() => setDrawingEnabled((v) => !v)} className={btn}>
                {drawingEnabled ? "Pause" : "Resume"}
              </button>
              <button data-hand-target onClick={undo} className={btn}>Undo</button>
              <button data-hand-target onClick={redo} className={btn}>Redo</button>
              <button data-hand-target onClick={clearAll} className={btn}>Clear</button>
              <button
                data-hand-target
                onClick={save}
                className="rounded-lg px-3 sm:px-4 py-1.5 font-mono text-[10px] sm:text-xs uppercase tracking-wider text-white transition hover:brightness-110 data-[hand-hover=true]:brightness-110"
                style={{ background: "#000" }}
              >
                Save PNG
              </button>
              <button
                data-hand-target
                onClick={toggleRecord}
                className="rounded-lg px-3 sm:px-4 py-1.5 font-mono text-[10px] sm:text-xs uppercase tracking-wider text-white transition hover:brightness-110 data-[hand-hover=true]:brightness-110"
                style={{ background: recording ? "#000" : PRIMARY }}
              >
                {recording ? "Stop Rec" : "Record"}
              </button>
            </div>
          </div>
        </div>

        <p className="mt-2 text-center font-mono text-[9px] sm:text-[10px] uppercase tracking-[0.3em] text-black/40">
          pinch to draw · hover a button to click · pinch on button = instant click
        </p>
      </div>

      {/* Hand cursor (DOM, above everything) */}
      <div ref={dwellRingRef}
        className="pointer-events-none fixed left-0 top-0 z-50 h-12 w-12 rounded-full opacity-0 transition-opacity duration-150"
        style={{ padding: 3, opacity: 0 }} />
      <div
        ref={cursorRef}
        className="pointer-events-none fixed left-0 top-0 z-50 h-5 w-5 rounded-full border-2 opacity-0 transition-[opacity,background-color] duration-150"
        style={{ borderColor: PRIMARY, background: "transparent", boxShadow: `0 0 0 3px rgba(255,255,255,0.7), 0 0 14px ${PRIMARY}80` }}
      />
    </div>
  );
}
