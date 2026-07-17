'use client';

/**
 * components/AreaCalculatorApp.tsx — the client wrapper that owns shared state.
 *
 * `app/page.tsx` is a server component, so this client component owns the single
 * source of truth for the in-memory shape list and wires the Map and Sidebar to
 * it. The Map is loaded via `next/dynamic(..., { ssr: false })` so Leaflet's
 * browser-only code never runs during server rendering.
 *
 * Persistence: there is NO backend/database in this version. Everything lives in
 * memory for the current session. The Save/Delete actions flip an in-memory
 * `saved` flag so the flow is fully client-side. This is a deliberate seam:
 * later, `persistShape` / `removeShape` below can be backed by IndexedDB so
 * shapes survive a page refresh without any server.
 *
 * Data flow:
 *   - The Map drives create/edit/delete of in-memory shapes.
 *   - The Sidebar drives "Save" (mark saved) and "Delete" (remove) in memory.
 */

import { useCallback, useState } from 'react';
import dynamic from 'next/dynamic';
import type L from 'leaflet';

import Sidebar from './Sidebar';
import type { AreaResult, BuildingsSummary, PolygonFeature, ShapeState } from '@/types/geo';

// Leaflet touches `window` at import/runtime, so both Map and BuildingsLayer
// must never render on the server — each imports `leaflet` directly, so BOTH
// need `ssr: false`, not just Map. The `loading` option for Map is a
// lightweight skeleton (a plain pulsing div, not a heavy component) so the
// page shell paints instantly while the Leaflet chunk loads. BuildingsLayer
// renders nothing until `map` is ready anyway, so it needs no loading skeleton.
const Map = dynamic(() => import('./Map'), {
  ssr: false,
  loading: () => <div className="h-full w-full animate-pulse bg-zinc-100 dark:bg-zinc-900" />,
});
const BuildingsLayer = dynamic(() => import('./BuildingsLayer'), { ssr: false });
const SearchBar = dynamic(() => import('./SearchBar'), { ssr: false });

export default function AreaCalculatorApp() {
  const [shapes, setShapes] = useState<ShapeState[]>([]);
  // The Leaflet map instance, populated once Map.tsx finishes initializing
  // (via its onMapReady callback). BuildingsLayer adds its own FeatureGroup to
  // this SAME instance rather than creating a second map.
  const [map, setMap] = useState<L.Map | null>(null);
  const [buildingsSummary, setBuildingsSummary] = useState<BuildingsSummary | undefined>();

  // ---- Map-driven mutations ----------------------------------------------
  const handleShapeCreated = useCallback((shape: ShapeState) => {
    setShapes((prev) => [...prev, shape]);
  }, []);

  const handleShapeEdited = useCallback(
    (localId: string, feature: PolygonFeature, area: AreaResult) => {
      // Update the matching shape's geometry + area, preserving its saved flag.
      setShapes((prev) =>
        prev.map((s) => (s.localId === localId ? { ...s, feature, area } : s)),
      );
    },
    [],
  );

  const handleShapeDeleted = useCallback((localIds: string[]) => {
    // Map-driven delete (via the draw toolbar's delete tool) removes entries
    // from local state.
    const toRemove = new Set(localIds);
    setShapes((prev) => prev.filter((s) => !toRemove.has(s.localId)));
  }, []);

  // ---- Sidebar-driven actions (in-memory only) ---------------------------
  // "Save" marks a shape as saved for the current session. This is where an
  // IndexedDB write would go in a future iteration.
  const handleSave = useCallback((localId: string) => {
    setShapes((prev) =>
      prev.map((s) => (s.localId === localId ? { ...s, saved: true } : s)),
    );
  }, []);

  // "Delete" removes a saved shape from state. This is where an IndexedDB
  // delete would go in a future iteration.
  const handleDelete = useCallback((localId: string) => {
    setShapes((prev) => prev.filter((s) => s.localId !== localId));
  }, []);

  return (
    <div className="flex h-full w-full">
      {/* Sidebar renders as a left-hand panel on md+ screens and as a fixed
          bottom bar on phones (see components/Sidebar.tsx); either way it
          contributes no layout width on mobile, so the map stays full-screen. */}
      <Sidebar
        shapes={shapes}
        onSave={handleSave}
        onDelete={handleDelete}
        buildingsSummary={buildingsSummary}
      />
      <div className="relative h-full flex-1">
        <Map
          shapes={shapes}
          onShapeCreated={handleShapeCreated}
          onShapeEdited={handleShapeEdited}
          onShapeDeleted={handleShapeDeleted}
          onMapReady={setMap}
        />
        {/* SearchBar geocodes an address/place and flies the same map to it;
            like BuildingsLayer it operates on the shared map instance and never
            touches drawn shapes. */}
        <SearchBar map={map} />
        {/* BuildingsLayer adds its own FeatureGroup to the same map instance
            once it's ready; it is independent of the manual draw/edit/delete
            flow above. */}
        <BuildingsLayer map={map} onBuildingsChange={setBuildingsSummary} />
      </div>
    </div>
  );
}
