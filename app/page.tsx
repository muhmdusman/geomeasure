import AreaCalculatorApp from '@/components/AreaCalculatorApp';

/**
 * app/page.tsx — the entry point (server component).
 *
 * Renders the client wrapper `AreaCalculatorApp`, which itself dynamically
 * imports the Leaflet Map with `{ ssr: false }`. This keeps the page renderable
 * on the server while ensuring Leaflet's browser-only code never runs during
 * SSR. The full-viewport wrapper gives Leaflet a real height to render into.
 */
export default function Home() {
  return (
    <div className="h-screen w-screen overflow-hidden">
      <AreaCalculatorApp />
    </div>
  );
}
