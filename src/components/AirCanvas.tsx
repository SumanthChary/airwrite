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

const PALETTE = ["#a78bfa", "#f0abfc", "#5eead4", "#fde047", "#fb923c", "#f87171", "#ffffff"];

export default function AirCanvas() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const strokesRef = useRef<Stroke[]>([]);
  const redoRef = useRef<Stroke[]>([]);
  const currentStrokeRef = useRef<Stroke | null>(null);
  const smoothBufRef = useRef<Pt[]>([]);
  const lastEmitRef = useRef<Pt | null>(null);

  const colorRef = useRef("#a78bfa");
  const sizeRef = useRef(6);
  const toolRef = useRef<"pen" | "eraser">("pen");
  const drawingEnabledRef = useRef(true);

  const [color, setColor] = useState("#a78bfa");
  const [size, setSize] = useState(6);
  const [tool, setTool] = useState<"pen" | "eraser">("pen");
  const [status, setStatus] = useState("Loading hand tracking…");
  const [ready, setReady] = useState(false);
  const [fingerState, setFingerState] = useState<"idle" | "drawing" | "hover">("idle");
  const [camOpacity, setCamOpacity] = useState(0.55);
  const [drawingEnabled, setDrawingEnabled] = useState(true);
  const [panelOpen, setPanelOpen] = useState(true);
  const [recording, setRecording] = useState(false);
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
        ctx.shadowBlur = 10;
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

      // Catmull-Rom -> Bezier for smooth curves
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
    ctx.fillStyle = "#0a0a0f";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(c, 0, 0);
    const a = document.createElement("a");
    a.href = out.toDataURL("image/png");
    a.download = `aircanvas-${Date.now()}.png`;
    a.click();
  }, []);

  const toggleRecord = useCallback(async () => {
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    try {
      const stream = await (navigator.mediaDevices as any).getDisplayMedia({
        video: { frameRate: 30 },
        audio: false,
      });
      const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
        ? "video/webm;codecs=vp9"
        : "video/webm";
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
      recordChunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size > 0) recordChunksRef.current.push(e.data); };
      rec.onstop = () => {
        stream.getTracks().forEach((t: MediaStreamTrack) => t.stop());
        const blob = new Blob(recordChunksRef.current, { type: "video/webm" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `aircanvas-${Date.now()}.webm`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        setRecording(false);
      };
      stream.getVideoTracks()[0].addEventListener("ended", () => rec.state !== "inactive" && rec.stop());
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
    } catch (e) {
      console.error(e);
      setRecording(false);
    }
  }, [recording]);

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
      // Save & restore drawing on resize
      const old = document.createElement("canvas");
      old.width = drawRef.current.width;
      old.height = drawRef.current.height;
      old.getContext("2d")!.drawImage(drawRef.current, 0, 0);

      drawRef.current.width = w; drawRef.current.height = h;
      overlayRef.current.width = w; overlayRef.current.height = h;
      if (old.width && old.height) {
        drawRef.current.getContext("2d")!.drawImage(old, 0, 0, w, h);
      }
      redraw();
    };

    const onResize = () => {
      cancelAnimationFrame(rafResize);
      rafResize = requestAnimationFrame(resize);
    };

    const onResults = (results: any) => {
      const overlay = overlayRef.current;
      if (!overlay) return;
      const octx = overlay.getContext("2d")!;
      octx.clearRect(0, 0, overlay.width, overlay.height);

      if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
        setFingerState("idle");
        if (currentStrokeRef.current) { commitStroke(); redraw(); }
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

      const isDrawing = drawingEnabledRef.current && indexExtended && pinching;

      // Rolling-average smoothing (last 5 points)
      const buf = smoothBufRef.current;
      buf.push(tip);
      if (buf.length > 5) buf.shift();
      const sx = buf.reduce((a, b) => a + b.x, 0) / buf.length;
      const sy = buf.reduce((a, b) => a + b.y, 0) / buf.length;
      const smoothed: Pt = { x: sx, y: sy };

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
          const d = Math.hypot(last.x - smoothed.x, last.y - smoothed.y);
          if (d > 1.5) {
            currentStrokeRef.current.points.push(smoothed);
            lastEmitRef.current = smoothed;
          }
        }
        redraw();
      } else {
        setFingerState(indexExtended ? "hover" : "idle");
        if (currentStrokeRef.current) { commitStroke(); redraw(); }
      }

      // Cursor overlay
      octx.save();
      const isEraser = toolRef.current === "eraser";
      const cursorColor = isEraser ? "#ffffff" : (isDrawing ? colorRef.current : "#ffffff");
      const r = isEraser ? sizeRef.current * 1.5 : (isDrawing ? sizeRef.current + 4 : 8);
      octx.shadowColor = cursorColor;
      octx.shadowBlur = isEraser ? 0 : 22;
      octx.fillStyle = isEraser ? "rgba(255,255,255,0.1)" : cursorColor;
      octx.beginPath();
      octx.arc(smoothed.x, smoothed.y, r, 0, Math.PI * 2);
      octx.fill();
      octx.shadowBlur = 0;
      octx.strokeStyle = "rgba(255,255,255,0.9)";
      octx.lineWidth = 1.5;
      octx.beginPath();
      octx.arc(smoothed.x, smoothed.y, r + 10, 0, Math.PI * 2);
      octx.stroke();

      if (pinching) {
        octx.strokeStyle = "rgba(255,255,255,0.5)";
        octx.lineWidth = 1;
        octx.beginPath();
        octx.moveTo(thumbTip.x, thumbTip.y);
        octx.lineTo(tip.x, tip.y);
        octx.stroke();
      }
      octx.restore();
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
  }, [redraw, commitStroke]);

  return (
    <div className="relative h-[100dvh] w-screen overflow-hidden bg-[#08080c] text-white select-none">
      {/* Ambient gradient */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(1200px 600px at 20% 10%, rgba(124,90,240,0.18), transparent), radial-gradient(900px 500px at 90% 90%, rgba(224,90,240,0.14), transparent)",
        }}
      />

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
        <div className="flex items-center justify-center gap-2 sm:gap-3 rounded-full border border-white/10 bg-black/40 px-3 sm:px-5 py-2 backdrop-blur-xl">
          <div className={`h-2 w-2 shrink-0 rounded-full ${ready ? "bg-emerald-400 shadow-[0_0_10px_rgba(74,240,168,0.8)]" : "bg-amber-400 animate-pulse"}`} />
          <span className="truncate text-[10px] sm:text-xs font-mono tracking-wide text-white/80">{status}</span>
          <span className="hidden sm:block h-3 w-px bg-white/15" />
          <span className={`hidden sm:inline text-xs font-mono shrink-0 ${fingerState === "drawing" ? "text-fuchsia-300" : fingerState === "hover" ? "text-white/70" : "text-white/40"}`}>
            {fingerState === "drawing" ? "● DRAWING" : fingerState === "hover" ? "○ HOVER" : "— IDLE"}
          </span>
        </div>
      </div>

      {/* Title */}
      <div className="absolute left-4 top-16 sm:left-6 sm:top-6 z-10">
        <div className="font-mono text-[9px] sm:text-[10px] uppercase tracking-[0.3em] text-white/40">AirCanvas</div>
        <div className="mt-1 font-serif text-lg sm:text-2xl italic text-white/90">draw the air.</div>
      </div>

      {/* Record indicator */}
      {recording && (
        <div className="absolute right-4 top-16 sm:top-6 z-10 flex items-center gap-2 rounded-full border border-red-500/40 bg-red-500/20 px-3 py-1.5 backdrop-blur-xl">
          <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
          <span className="font-mono text-[10px] uppercase tracking-wider text-red-200">REC</span>
        </div>
      )}

      {/* Panel toggle (mobile) */}
      <button
        onClick={() => setPanelOpen((v) => !v)}
        className="absolute bottom-3 right-3 z-20 sm:hidden rounded-full border border-white/15 bg-black/50 px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-white backdrop-blur-xl"
      >
        {panelOpen ? "Hide" : "Tools"}
      </button>

      {/* Bottom panel */}
      <div
        className={`absolute bottom-3 sm:bottom-6 left-1/2 z-10 -translate-x-1/2 w-[min(96vw,920px)] transition-all duration-300 ${
          panelOpen ? "opacity-100 translate-y-0" : "opacity-0 translate-y-6 pointer-events-none"
        }`}
      >
        <div className="rounded-2xl border border-white/10 bg-black/50 px-3 sm:px-5 py-3 sm:py-4 backdrop-blur-xl shadow-2xl">
          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-3 sm:gap-x-4">
            {/* Tools */}
            <div className="flex items-center gap-1 rounded-xl bg-white/5 p-1">
              <button
                onClick={() => setTool("pen")}
                className={`rounded-lg px-3 py-1.5 font-mono text-[10px] sm:text-xs uppercase tracking-wider transition ${tool === "pen" ? "bg-white/15 text-white" : "text-white/50 hover:text-white"}`}
              >
                Pen
              </button>
              <button
                onClick={() => setTool("eraser")}
                className={`rounded-lg px-3 py-1.5 font-mono text-[10px] sm:text-xs uppercase tracking-wider transition ${tool === "eraser" ? "bg-white/15 text-white" : "text-white/50 hover:text-white"}`}
              >
                Eraser
              </button>
            </div>

            {/* Colors */}
            <div className="flex items-center gap-1.5 sm:gap-2">
              {PALETTE.map((c) => (
                <button
                  key={c}
                  onClick={() => { setColor(c); setTool("pen"); }}
                  className="relative h-6 w-6 sm:h-7 sm:w-7 rounded-full transition-transform hover:scale-110"
                  style={{
                    background: c,
                    boxShadow: color === c && tool === "pen" ? `0 0 0 2px #0a0a0f, 0 0 0 4px ${c}, 0 0 18px ${c}` : `0 0 8px ${c}80`,
                  }}
                  aria-label={`Color ${c}`}
                />
              ))}
            </div>

            {/* Size */}
            <div className="flex items-center gap-2 sm:gap-3">
              <span className="font-mono text-[9px] sm:text-[10px] uppercase tracking-wider text-white/50">size</span>
              <input
                type="range" min={2} max={28} value={size}
                onChange={(e) => setSize(parseInt(e.target.value))}
                className="w-20 sm:w-28 accent-fuchsia-400"
              />
              <span className="w-5 font-mono text-[10px] sm:text-xs text-white/70">{size}</span>
            </div>

            {/* Camera opacity */}
            <div className="flex items-center gap-2 sm:gap-3">
              <span className="font-mono text-[9px] sm:text-[10px] uppercase tracking-wider text-white/50">cam</span>
              <input
                type="range" min={0} max={100} value={Math.round(camOpacity * 100)}
                onChange={(e) => setCamOpacity(parseInt(e.target.value) / 100)}
                className="w-20 sm:w-24 accent-violet-400"
              />
            </div>

            {/* Actions */}
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button onClick={() => setDrawingEnabled((v) => !v)}
                className={`rounded-lg px-2.5 sm:px-3 py-1.5 font-mono text-[10px] sm:text-xs uppercase tracking-wider transition ${drawingEnabled ? "bg-white/10 text-white hover:bg-white/20" : "bg-amber-500/20 text-amber-200 hover:bg-amber-500/30"}`}>
                {drawingEnabled ? "Pause" : "Resume"}
              </button>
              <button onClick={undo} className="rounded-lg bg-white/10 px-2.5 sm:px-3 py-1.5 font-mono text-[10px] sm:text-xs uppercase tracking-wider text-white hover:bg-white/20">Undo</button>
              <button onClick={redo} className="rounded-lg bg-white/10 px-2.5 sm:px-3 py-1.5 font-mono text-[10px] sm:text-xs uppercase tracking-wider text-white hover:bg-white/20">Redo</button>
              <button onClick={clearAll} className="rounded-lg bg-white/10 px-2.5 sm:px-3 py-1.5 font-mono text-[10px] sm:text-xs uppercase tracking-wider text-white hover:bg-white/20">Clear</button>
              <button onClick={save} className="rounded-lg bg-gradient-to-r from-violet-500 to-fuchsia-500 px-3 sm:px-4 py-1.5 font-mono text-[10px] sm:text-xs uppercase tracking-wider text-white shadow-lg shadow-fuchsia-500/30 hover:brightness-110">Save PNG</button>
              <button
                onClick={toggleRecord}
                className={`rounded-lg px-3 sm:px-4 py-1.5 font-mono text-[10px] sm:text-xs uppercase tracking-wider text-white shadow-lg transition ${recording ? "bg-red-500 hover:bg-red-600 shadow-red-500/40" : "bg-gradient-to-r from-emerald-500 to-teal-500 hover:brightness-110 shadow-emerald-500/30"}`}
              >
                {recording ? "Stop Rec" : "Record"}
              </button>
            </div>
          </div>
        </div>

        {/* Hint */}
        <p className="mt-2 text-center font-mono text-[9px] sm:text-[10px] uppercase tracking-[0.3em] text-white/30">
          pinch thumb + index • move to draw • open hand to lift
        </p>
      </div>
    </div>
  );
}
