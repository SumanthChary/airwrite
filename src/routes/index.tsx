import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "AirCanvas — Draw with your hands" },
      { name: "description", content: "Air-draw in real time using your webcam and hand tracking. Pinch your thumb and index finger to paint glowing strokes in space." },
      { property: "og:title", content: "AirCanvas — Draw with your hands" },
      { property: "og:description", content: "Air-draw in real time using your webcam and hand tracking." },
    ],
  }),
  component: Index,
});

function Index() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  if (!mounted) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[#08080c] text-white/60 font-mono text-sm">
        Booting AirCanvas…
      </div>
    );
  }
  // Dynamic import keeps MediaPipe out of SSR
  const AirCanvas = require("@/components/AirCanvas").default;
  return <AirCanvas />;
}
