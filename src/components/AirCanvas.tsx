import { useEffect, useRef, useState, useCallback } from "react";

// MediaPipe Tasks Vision (GPU-accelerated HandLandmarker) — successor to legacy @mediapipe/hands.
// Loaded dynamically from the official CDN for best performance & WASM/GPU delegate support.
const TASKS_VISION_VERSION = "0.10.14";
const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`;
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";


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
  const lastEmitRef = useRef<Pt | null>(null);

  // One Euro filter state (per axis)
  const oneEuroRef = useRef({
    xPrev: 0, yPrev: 0, dxPrev: 0, dyPrev: 0, tPrev: 0, init: false,
  });

  // Target = latest tracked pos. Display = interpolated pos driving cursor & ink.
  // Decouples camera FPS (~30) from monitor refresh (60-120Hz). This is the
  // single biggest perceived-smoothness win.
  const targetPosRef = useRef<Pt | null>(null);
  const displayPosRef = useRef<Pt | null>(null);
  const targetVelRef = useRef<Pt>({ x: 0, y: 0 });

  // Pointing state from latest detection (read by display loop)
  const pointingRef = useRef(false);
  const indexExtRef = useRef(false);
  const handPresentRef = useRef(false);

  const colorRef = useRef<string>(PRIMARY);
  const sizeRef = useRef(6);
  const toolRef = useRef<"pen" | "eraser">("pen");
  const drawingEnabledRef = useRef(true);
  const fingerStateRef = useRef<"idle" | "drawing" | "hover">("idle");

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

  const setFingerStateThrottled = useCallback((v: "idle" | "drawing" | "hover") => {
    if (fingerStateRef.current !== v) {
      fingerStateRef.current = v;
      setFingerState(v);
    }
  }, []);

  useEffect(() => { colorRef.current = color; }, [color]);
  useEffect(() => { sizeRef.current = size; }, [size]);
  useEffect(() => { toolRef.current = tool; }, [tool]);
  useEffect(() => { drawingEnabledRef.current = drawingEnabled; }, [drawingEnabled]);


  // Apply one stroke fully (used by full redraw on undo/clear/resize)
  const drawStroke = (ctx: CanvasRenderingContext2D, s: Stroke) => {
    if (s.points.length < 1) return;
    ctx.globalCompositeOperation = s.tool === "eraser" ? "destination-out" : "source-over";
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = s.size;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const pts = s.points;
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, s.size / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
  };

  // Full redraw (only when needed: undo / clear / resize)
  const redraw = useCallback(() => {
    const c = drawRef.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
    for (const s of strokesRef.current) drawStroke(ctx, s);
    if (currentStrokeRef.current) drawStroke(ctx, currentStrokeRef.current);
    ctx.globalCompositeOperation = "source-over";
  }, []);

  // Incrementally append the latest segment of the in-progress stroke.
  // Called per new sample while drawing — O(1), not O(N).
  const drawIncrement = () => {
    const s = currentStrokeRef.current;
    const c = drawRef.current;
    if (!s || !c) return;
    const ctx = c.getContext("2d")!;
    const pts = s.points;
    const n = pts.length;
    ctx.globalCompositeOperation = s.tool === "eraser" ? "destination-out" : "source-over";
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = s.size;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (n === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, s.size / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    if (n === 2) {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(pts[1].x, pts[1].y);
      ctx.stroke();
      return;
    }
    // Quadratic between previous midpoint and current midpoint, control = pts[n-2]
    const p0 = pts[n - 3];
    const p1 = pts[n - 2];
    const p2 = pts[n - 1];
    const m0x = (p0.x + p1.x) / 2, m0y = (p0.y + p1.y) / 2;
    const m1x = (p1.x + p2.x) / 2, m1y = (p1.y + p2.y) / 2;
    ctx.beginPath();
    ctx.moveTo(m0x, m0y);
    ctx.quadraticCurveTo(p1.x, p1.y, m1x, m1y);
    ctx.stroke();
  };

  const commitStroke = useCallback(() => {
    if (currentStrokeRef.current && currentStrokeRef.current.points.length > 0) {
      strokesRef.current.push(currentStrokeRef.current);
      redoRef.current = [];
    }
    currentStrokeRef.current = null;
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

      const cursor = cursorRef.current;
      const dwellRing = dwellRingRef.current;

      const landmarksList = results.landmarks || results.multiHandLandmarks;
      if (!landmarksList || landmarksList.length === 0) {
        setFingerStateThrottled("idle");
        if (currentStrokeRef.current) { commitStroke(); }
        if (cursor) cursor.style.opacity = "0";
        if (dwellRing) dwellRing.style.opacity = "0";
        hoverTargetRef.current?.removeAttribute("data-hand-hover");
        hoverTargetRef.current = null;
        dwellStartRef.current = 0;
        smoothPosRef.current = null;
        oneEuroRef.current.init = false;
        return;
      }

      const lm = landmarksList[0];

      const W = overlay.width;
      const H = overlay.height;
      const rawX = (1 - lm[8].x) * W;
      const rawY = lm[8].y * H;

      // ---- One Euro Filter ----
      const oe = oneEuroRef.current;
      const now = performance.now();
      let sx = rawX, sy = rawY;
      if (!oe.init) {
        oe.xPrev = rawX; oe.yPrev = rawY;
        oe.dxPrev = 0; oe.dyPrev = 0;
        oe.tPrev = now; oe.init = true;
      } else {
        const dt = Math.max(1, now - oe.tPrev) / 1000;
        const minCutoff = 1.2, beta = 0.05, dCutoff = 1.0;
        const alpha = (cutoff: number) => {
          const r = 2 * Math.PI * cutoff * dt;
          return r / (r + 1);
        };
        const dxRaw = (rawX - oe.xPrev) / dt;
        const dyRaw = (rawY - oe.yPrev) / dt;
        const ad = alpha(dCutoff);
        const dx = oe.dxPrev + ad * (dxRaw - oe.dxPrev);
        const dy = oe.dyPrev + ad * (dyRaw - oe.dyPrev);
        const cutoffX = minCutoff + beta * Math.abs(dx);
        const cutoffY = minCutoff + beta * Math.abs(dy);
        const ax = alpha(cutoffX), ay = alpha(cutoffY);
        sx = oe.xPrev + ax * (rawX - oe.xPrev);
        sy = oe.yPrev + ay * (rawY - oe.yPrev);
        oe.xPrev = sx; oe.yPrev = sy;
        oe.dxPrev = dx; oe.dyPrev = dy;
        oe.tPrev = now;
      }
      const smoothed: Pt = { x: sx, y: sy };
      smoothPosRef.current = smoothed;

      // Finger-extension test: tip is higher (smaller y) than the PIP joint.
      const isExtended = (tipIdx: number, pipIdx: number) =>
        lm[tipIdx].y < lm[pipIdx].y - 0.015;
      const indexExtended = isExtended(8, 6);
      const middleExtended = isExtended(12, 10);
      const ringExtended = isExtended(16, 14);
      const pinkyExtended = isExtended(20, 18);
      const pointing =
        indexExtended && !middleExtended && !ringExtended && !pinkyExtended;

      const rect = cont.getBoundingClientRect();
      const vx = smoothed.x + rect.left;
      const vy = smoothed.y + rect.top;

      const target = findHandTarget(vx, vy);
      const prev = hoverTargetRef.current;
      if (target !== prev) {
        prev?.removeAttribute("data-hand-hover");
        target?.setAttribute("data-hand-hover", "true");
        hoverTargetRef.current = target;
        dwellStartRef.current = target ? now : 0;
      }

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
      } else {
        if (dwellRing) dwellRing.style.opacity = "0";
      }

      const isDrawing = !target && drawingEnabledRef.current && pointing;

      if (isDrawing) {
        setFingerStateThrottled("drawing");
        if (!currentStrokeRef.current) {
          currentStrokeRef.current = {
            points: [smoothed],
            color: colorRef.current,
            size: toolRef.current === "eraser" ? sizeRef.current * 3 : sizeRef.current,
            tool: toolRef.current,
          };
          lastEmitRef.current = smoothed;
          drawIncrement();
        } else {
          const last = lastEmitRef.current!;
          if (Math.hypot(last.x - smoothed.x, last.y - smoothed.y) > 1.2) {
            currentStrokeRef.current.points.push(smoothed);
            lastEmitRef.current = smoothed;
            drawIncrement();
          }
        }
      } else {
        setFingerStateThrottled(target ? "hover" : indexExtended ? "hover" : "idle");
        if (currentStrokeRef.current) { commitStroke(); }
      }


      if (cursor) {
        cursor.style.opacity = "1";
        cursor.style.transform = `translate3d(${vx}px, ${vy}px, 0) translate(-50%, -50%)`;
        const mode = target ? "hand" : toolRef.current === "eraser" ? "eraser" : "pen";
        if (cursor.dataset.mode !== mode) cursor.dataset.mode = mode;
        const tint = target ? PRIMARY : toolRef.current === "eraser" ? "#111111" : colorRef.current;
        cursor.style.setProperty("--cursor-tint", tint);
        cursor.dataset.pinch = isDrawing ? "1" : "0";
        cursor.dataset.drawing = isDrawing ? "1" : "0";
      }
      if (dwellRing) {
        dwellRing.style.transform = `translate3d(${vx}px, ${vy}px, 0) translate(-50%, -50%)`;
      }
    };

    resize();
    window.addEventListener("resize", onResize);

    // Warm the model CDN connections in the background.
    try {
      const link = document.createElement("link");
      link.rel = "preconnect";
      link.href = "https://cdn.jsdelivr.net";
      link.crossOrigin = "anonymous";
      document.head.appendChild(link);
    } catch {}
    setStatus("Click “Enable Camera” to begin");


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
      // Prime the permission prompt directly from the user gesture.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
        audio: false,
      });
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play().catch(() => {});

      // Dynamic import of MediaPipe Tasks Vision (ESM via CDN) — GPU delegate for max smoothness.
      const vision: any = await import(
        /* @vite-ignore */ `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/vision_bundle.mjs`
      );
      const fileset = await vision.FilesetResolver.forVisionTasks(WASM_BASE);
      let landmarker: any;
      try {
        landmarker = await vision.HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
          runningMode: "VIDEO",
          numHands: 1,
          minHandDetectionConfidence: 0.5,
          minHandPresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
      } catch {
        // Fallback to CPU if GPU delegate unavailable (e.g. WebGL blocked)
        landmarker = await vision.HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
          runningMode: "VIDEO",
          numHands: 1,
        });
      }

      // Drive frames ourselves — detectForVideo is synchronous & fast.
      let stopped = false;
      let lastTs = -1;
      const loop = () => {
        if (stopped) return;
        if (video.readyState >= 2) {
          const ts = performance.now();
          if (ts !== lastTs) {
            lastTs = ts;
            try {
              const res = landmarker.detectForVideo(video, ts);
              onResultsRef.current(res);
            } catch {}
          }
        }
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);

      cleanupRef.current = () => {
        stopped = true;
        try { stream.getTracks().forEach((t) => t.stop()); } catch {}
        try { landmarker.close?.(); } catch {}
      };

      setStarted(true);
      setReady(true);
      setStatus("Point with your index finger to draw · hover a button to click");
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

      {/* Start / permission overlay */}
      {!started && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-white/70 backdrop-blur-md">
          <div className="mx-4 max-w-md rounded-3xl border border-black/10 bg-white p-6 sm:p-8 text-center shadow-2xl">
            <div className="font-mono text-[10px] uppercase tracking-[0.35em] text-black/40">airwrite</div>
            <h2 className="mt-2 text-2xl sm:text-3xl font-black tracking-tight">
              Write in the air with your <span style={{ color: PRIMARY }}>finger</span>
            </h2>
            <p className="mt-3 text-sm text-black/60">
              We need your camera to track your hand. Nothing is uploaded — everything runs in your browser.
            </p>
            {camError && (
              <p className="mt-3 rounded-lg bg-black/5 px-3 py-2 text-xs font-mono text-black/70">
                {camError}
              </p>
            )}
            <button
              onClick={startCamera}
              className="mt-5 w-full rounded-xl px-5 py-3 font-mono text-xs uppercase tracking-[0.2em] text-white transition hover:brightness-110"
              style={{ background: PRIMARY, boxShadow: `0 8px 24px ${PRIMARY}55` }}
            >
              {camError ? "Retry camera" : "Enable camera"}
            </button>
            <p className="mt-3 text-[10px] font-mono uppercase tracking-wider text-black/40">
              tip: point with your index finger to draw
            </p>
          </div>
        </div>
      )}


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
          point index finger to draw · open palm to move · hover a button to click
        </p>
      </div>

      {/* Dwell ring (fills when hovering a button) */}
      <div ref={dwellRingRef}
        className="pointer-events-none fixed left-0 top-0 z-[60] h-12 w-12 rounded-full opacity-0"
        style={{ padding: 3, opacity: 0, transition: "opacity 150ms ease, transform 60ms linear" }} />

      {/* Air cursor — morphs between pen and hand */}
      <div
        ref={cursorRef}
        data-mode="pen"
        data-pinch="0"
        data-drawing="0"
        className="air-cursor pointer-events-none fixed left-0 top-0 z-[60] opacity-0"
      >
        {/* Pen icon */}
        <svg className="air-cursor-pen" width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden>
          <defs>
            <filter id="aw-pen-shadow" x="-20%" y="-20%" width="140%" height="140%">
              <feDropShadow dx="0" dy="1.5" stdDeviation="1.5" floodColor="#000" floodOpacity="0.25"/>
            </filter>
          </defs>
          <g filter="url(#aw-pen-shadow)">
            {/* nib */}
            <circle cx="10" cy="30" r="2.6" fill="var(--cursor-tint)" />
            {/* body */}
            <path d="M12 28 L28 12 L33 17 L17 33 Z" fill="#fff" stroke="#111" strokeWidth="1.4" strokeLinejoin="round"/>
            {/* tip line */}
            <path d="M12 28 L17 33" stroke="var(--cursor-tint)" strokeWidth="2" strokeLinecap="round"/>
            {/* cap */}
            <rect x="27" y="9" width="8" height="6" rx="1.2" transform="rotate(45 31 12)" fill="var(--cursor-tint)" stroke="#111" strokeWidth="1.2"/>
          </g>
        </svg>
        {/* Hand (pointer) icon */}
        <svg className="air-cursor-hand" width="40" height="40" viewBox="0 0 24 24" fill="none" aria-hidden>
          <g filter="url(#aw-pen-shadow)">
            <path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V11" fill="#fff" stroke="#111" strokeWidth="1.2" strokeLinejoin="round"/>
            <path d="M12 11V4.5a1.5 1.5 0 0 1 3 0V11" fill="#fff" stroke="#111" strokeWidth="1.2" strokeLinejoin="round"/>
            <path d="M15 11V6a1.5 1.5 0 0 1 3 0v8c0 3.9-2.6 7-7 7-2.6 0-4.6-1.2-5.8-3.4L3 14c-.6-1.1.6-2.2 1.6-1.6L7 14V6a1.5 1.5 0 0 1 3 0v5" fill="#fff" stroke="#111" strokeWidth="1.2" strokeLinejoin="round"/>
          </g>
        </svg>
        {/* Pinch ring (dot when pinching) */}
        <span className="air-cursor-dot" />
      </div>

      <style>{`
        .air-cursor {
          width: 40px; height: 40px;
          --cursor-tint: ${PRIMARY};
          transition: opacity 150ms ease;
          will-change: transform;
        }
        .air-cursor svg {
          position: absolute; inset: 0;
          transition: opacity 180ms ease, transform 180ms cubic-bezier(.2,.8,.2,1);
          transform-origin: 50% 50%;
        }
        .air-cursor .air-cursor-pen { opacity: 1; transform: rotate(0deg) scale(1); }
        .air-cursor .air-cursor-hand { opacity: 0; transform: scale(.75); }
        .air-cursor[data-mode="hand"] .air-cursor-pen { opacity: 0; transform: scale(.75) rotate(-12deg); }
        .air-cursor[data-mode="hand"] .air-cursor-hand { opacity: 1; transform: scale(1); }
        .air-cursor[data-mode="eraser"] .air-cursor-pen { filter: grayscale(1) brightness(.7); }
        .air-cursor[data-pinch="1"] svg { transform: scale(.88); }
        .air-cursor[data-mode="hand"][data-pinch="1"] .air-cursor-hand { transform: scale(.82); }
        .air-cursor-dot {
          position: absolute; left: 50%; top: 50%;
          width: 10px; height: 10px; border-radius: 9999px;
          background: var(--cursor-tint);
          transform: translate(-50%,-50%) scale(0);
          opacity: 0;
          box-shadow: 0 0 0 3px rgba(255,255,255,.85), 0 0 14px var(--cursor-tint);
          transition: transform 160ms cubic-bezier(.2,.8,.2,1), opacity 160ms ease;
          pointer-events: none;
        }
        .air-cursor[data-drawing="1"] .air-cursor-dot { transform: translate(-50%,-50%) scale(1); opacity: 1; }
        [data-hand-target][data-hand-hover="true"] {
          transform: translateY(-1px) scale(1.04);
          transition: transform 180ms cubic-bezier(.2,.8,.2,1), box-shadow 180ms ease, background-color 180ms ease, color 180ms ease;
          box-shadow: 0 8px 24px ${PRIMARY}40;
        }
      `}</style>
    </div>
  );
}
