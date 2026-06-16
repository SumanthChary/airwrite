import { createFileRoute } from "@tanstack/react-router";
import AirCanvas from "@/components/AirCanvas";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "AirCanvas — Draw with your hands" },
      { name: "description", content: "Air-draw in real time using your webcam and hand tracking. Pinch your thumb and index finger to paint glowing strokes in space." },
      { property: "og:title", content: "AirCanvas — Draw with your hands" },
      { property: "og:description", content: "Air-draw in real time using your webcam and hand tracking." },
    ],
  }),
  component: AirCanvas,
});
