import { createFileRoute } from "@tanstack/react-router";
import AirCanvas from "@/components/AirCanvas";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "airwrite — draw in the air with your hands" },
      { name: "description", content: "airwrite turns your webcam into a canvas. Pinch your thumb and index finger to draw, hover a button to click — no mouse, no pen." },
      { property: "og:title", content: "airwrite" },
      { property: "og:description", content: "Draw and click in the air with hand tracking." },
    ],
  }),
  component: AirCanvas,
});
