'use client';

/**
 * components/BuildingsLayer.tsx — fetches and renders real OSM building
 * footprints as a second, independent layer on the SAME Leaflet map instance
 * owned by components/Map.tsx.
 *
 * Isolation from manual drawing: this component creates its own
 * `L.FeatureGroup` (`buildingsFeatureGroup`) and adds/removes/clears layers on
 * it exclusively. It never touches `drawnItems` (owned by Map.tsx) and never
 * fires `L.Draw.Event.*` — so loading, clearing, or re-rendering buildings can
 * never disrupt manually drawn/edited/deleted shapes, and vice versa.
 *
 * Trigger model: the ONLY thing that fires a network request is the explicit
 * "Load Buildings Here" click (or its own cache-hit check). A debounced
 * `moveend` listener exists solely to keep the zoom-guard hint up to date —
 * it never calls `fetchBuildingsInBounds` itself.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import type { FeatureCollection, GeometryObject } from 'geojson';

import { fetchBuildingsInBounds, MIN_BUILDINGS_ZOOM, OverpassError } from '@/lib/overpass';
import {
  BUILDING_CATEGORY_COLORS,
  BUILDING_CATEGORY_LABELS,
  MAX_STYLED_FEATURES,
  buildingPopupHtml,
  categorizeBuildingTag,
  flatBuildingStyle,
  simplifyIfDense,
  styleForBuildingFeature,
} from '@/lib/buildings';
import type { BuildingCategory, BuildingFeature, BuildingProperties, BuildingsSummary } from '@/types/geo';

export interface BuildingsLayerProps {
  /** The single Leaflet map instance owned by Map.tsx; null until it is ready. */
  map: L.Map | null;
  /** Called whenever the rendered building set changes (count + category breakdown). */
  onBuildingsChange?: (summary: BuildingsSummary) => void;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'loaded'; count: number; fromCache: boolean }
  | { kind: 'empty' }
  | { kind: 'error'; message: string };

type BuildingsFeatureCollection = FeatureCollection<GeometryObject, BuildingProperties>;

interface CacheEntry {
  bounds: L.LatLngBounds;
  data: BuildingsFeatureCollection;
}

/** Debounce interval for the `moveend` zoom-guard UI update (never fires a fetch). */
const DEBOUNCE_MS = 300;

/**
 * Dedicated map pane for building footprints. It sits BELOW Leaflet's default
 * `overlayPane` (z-index 400, where `drawnItems` and the leaflet-draw editing
 * handles live) so manually drawn shapes always render on top, and — crucially
 * — so its pointer events can be switched off independently while the user is
 * drawing/editing (see `draw:drawstart`/`draw:editstart` handling below).
 */
const BUILDINGS_PANE = 'buildingsPane';
const BUILDINGS_PANE_Z_INDEX = '350';

/**
 * Leaflet-draw lifecycle events that begin/end an interaction where building
 * layers must NOT intercept clicks (otherwise a click meant to place/finish a
 * vertex lands on a building instead, and the polygon never completes).
 */
const DRAW_ACTIVE_EVENTS = ['draw:drawstart', 'draw:editstart', 'draw:deletestart'] as const;
const DRAW_INACTIVE_EVENTS = ['draw:drawstop', 'draw:editstop', 'draw:deletestop'] as const;

/** Display order for the legend and category-count breakdown. */
const CATEGORY_ORDER: BuildingCategory[] = ['residential', 'commercial', 'industrial', 'other'];

/** True when `err` is the platform's `AbortError` raised by an aborted fetch. */
function isAbortError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const candidate = err as { name?: unknown; code?: unknown };
  return candidate.name === 'AbortError' || candidate.code === 20;
}

/** Turn a caught error into a short, user-facing message distinct from the empty-result state. */
function describeError(err: unknown): string {
  if (err instanceof OverpassError) {
    switch (err.kind) {
      case 'network':
        return 'Could not reach the Overpass API. Check your connection and try again.';
      case 'http':
        return `Overpass API returned an error (HTTP ${err.status ?? 'unknown'}). Try again in a moment.`;
      case 'parse':
        return 'Overpass API returned an unexpected response. Try again.';
    }
  }
  return 'Something went wrong loading buildings. Try again.';
}

/** Summarize a fetched/cached FeatureCollection: total count + per-category breakdown. */
function summaryOf(fc: BuildingsFeatureCollection, fromCache: boolean): BuildingsSummary {
  const byCategory: Record<BuildingCategory, number> = {
    residential: 0,
    commercial: 0,
    industrial: 0,
    other: 0,
  };
  for (const feature of fc.features) {
    const category = categorizeBuildingTag(feature.properties?.building);
    byCategory[category] += 1;
  }
  return { totalCount: fc.features.length, byCategory, fromCache };
}

export default function BuildingsLayer({ map, onBuildingsChange }: BuildingsLayerProps) {
  const onBuildingsChangeRef = useRef(onBuildingsChange);
  onBuildingsChangeRef.current = onBuildingsChange;

  const featureGroupRef = useRef<L.FeatureGroup | null>(null);
  const cacheRef = useRef<CacheEntry | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [zoomTooLow, setZoomTooLow] = useState(false);

  // ---- FeatureGroup lifecycle: create when `map` is ready, remove on unmount
  // or when `map` changes away. Distinct from Map.tsx's `drawnItems` group. ---
  useEffect(() => {
    if (!map) return;

    // Render buildings into their own pane, positioned below the overlay pane
    // that holds the drawn shapes and draw handles, so buildings never sit on
    // top of (or steal clicks from) the manual-drawing workflow.
    let pane = map.getPane(BUILDINGS_PANE);
    if (!pane) {
      pane = map.createPane(BUILDINGS_PANE);
      pane.style.zIndex = BUILDINGS_PANE_Z_INDEX;
    }

    const fg = new L.FeatureGroup();
    fg.addTo(map);
    featureGroupRef.current = fg;

    return () => {
      map.removeLayer(fg);
      featureGroupRef.current = null;
    };
  }, [map]);

  // ---- Drawing/editing isolation: while a leaflet-draw interaction is active,
  // disable pointer events on the buildings pane so clicks reach the draw tool
  // (letting the user place/finish vertices) instead of landing on a building
  // and opening its popup. Restored the moment the interaction ends. ----------
  useEffect(() => {
    if (!map) return;

    const setBuildingsInteractive = (interactive: boolean) => {
      const pane = map.getPane(BUILDINGS_PANE);
      if (pane) {
        pane.style.pointerEvents = interactive ? '' : 'none';
      }
    };

    const disable = () => setBuildingsInteractive(false);
    const enable = () => setBuildingsInteractive(true);

    for (const evt of DRAW_ACTIVE_EVENTS) map.on(evt, disable);
    for (const evt of DRAW_INACTIVE_EVENTS) map.on(evt, enable);

    return () => {
      for (const evt of DRAW_ACTIVE_EVENTS) map.off(evt, disable);
      for (const evt of DRAW_INACTIVE_EVENTS) map.off(evt, enable);
    };
  }, [map]);

  // ---- Zoom-guard UI state: set immediately, then kept fresh by a debounced
  // `moveend` listener. NEVER triggers a fetch from here (Requirements 5.1, 5.2). --
  useEffect(() => {
    if (!map) return;

    const updateZoomGuard = () => {
      setZoomTooLow(map.getZoom() < MIN_BUILDINGS_ZOOM);
    };
    updateZoomGuard();

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const onMoveEnd = () => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(updateZoomGuard, DEBOUNCE_MS);
    };
    map.on('moveend', onMoveEnd);

    return () => {
      if (timeoutId) clearTimeout(timeoutId);
      map.off('moveend', onMoveEnd);
    };
  }, [map]);

  // ---- Batched rendering + lazy per-feature click handler ------------------
  const renderBuildings = useCallback((fc: BuildingsFeatureCollection, fromCache: boolean) => {
    const fg = featureGroupRef.current;
    if (!fg) return;

    fg.clearLayers();

    if (fc.features.length === 0) {
      setStatus({ kind: 'empty' });
      onBuildingsChangeRef.current?.(summaryOf(fc, fromCache));
      return;
    }

    const useFlatStyle = fc.features.length > MAX_STYLED_FEATURES;

    // Single L.geoJSON call + a single addLayer call below: one render pass,
    // never a per-feature addLayer/addTo loop.
    const geoLayer = L.geoJSON(fc as GeoJSON.FeatureCollection, {
      // Render into the dedicated buildings pane so building paths sit below
      // the drawn shapes/draw handles and can have their pointer events toggled
      // off during drawing without affecting the manual-drawing layer.
      pane: BUILDINGS_PANE,
      style: (feature) => {
        if (useFlatStyle || !feature) {
          return flatBuildingStyle();
        }
        return styleForBuildingFeature(feature as BuildingFeature);
      },
      onEachFeature: (feature, layer) => {
        // Lazy area calculation: turf.area() (inside buildingPopupHtml) is
        // called ONLY here, on click — never during this render pass.
        layer.on('click', () => {
          layer.bindPopup(buildingPopupHtml(feature as BuildingFeature)).openPopup();
        });
      },
    });
    fg.addLayer(geoLayer);

    setStatus({ kind: 'loaded', count: fc.features.length, fromCache });
    onBuildingsChangeRef.current?.(summaryOf(fc, fromCache));
  }, []);

  // ---- The one and only fetch trigger: an explicit user action -------------
  const loadBuildingsHere = useCallback(async () => {
    if (!map) return;

    const zoom = map.getZoom();
    if (zoom < MIN_BUILDINGS_ZOOM) {
      // The persistent zoom-guard hint (driven by `zoomTooLow`) already
      // informs the user; no fetch is made (Requirements 1.3, 5.4).
      setZoomTooLow(true);
      return;
    }

    const bounds = map.getBounds();
    const cache = cacheRef.current;

    if (cache && cache.bounds.contains(bounds)) {
      // Cache hit: reuse the previous result without calling Overpass again.
      renderBuildings(cache.data, true);
      return;
    }

    // Cancel any previous in-flight request so a late response can never
    // overwrite this newer one (Requirements 7.1, 7.2, 7.3).
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setStatus({ kind: 'loading' });

    try {
      const raw = await fetchBuildingsInBounds(bounds, { signal: controller.signal });
      const fc = simplifyIfDense(raw) as BuildingsFeatureCollection;
      cacheRef.current = { bounds, data: fc };
      renderBuildings(fc, false);
    } catch (err) {
      if (isAbortError(err)) {
        // Superseded by a newer request; silent no-op — never shown as an error.
        return;
      }
      setStatus({ kind: 'error', message: describeError(err) });
    }
  }, [map, renderBuildings]);

  // ---- Cancel any in-flight request on unmount ------------------------------
  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
    };
  }, []);

  return (
    <div
      className="absolute bottom-24 left-2 z-[900] flex max-w-[260px] flex-col gap-2 rounded-md border border-zinc-200 bg-white/95 p-3 text-sm shadow-md backdrop-blur-sm md:bottom-2 dark:border-zinc-800 dark:bg-zinc-950/95"
      data-testid="buildings-layer-panel"
    >
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={loadBuildingsHere}
          className="inline-flex items-center gap-2 rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600"
        >
          Load Buildings Here
        </button>
        {status.kind === 'loading' && (
          <span
            role="status"
            aria-label="Loading buildings"
            className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-zinc-300 border-t-emerald-600 dark:border-zinc-700"
          />
        )}
      </div>

      {zoomTooLow && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          Zoom in further (level {MIN_BUILDINGS_ZOOM}+) to load buildings.
        </p>
      )}

      {status.kind === 'empty' && (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          No building data available for this area in OpenStreetMap.
        </p>
      )}

      {status.kind === 'error' && (
        <p className="text-xs text-red-600 dark:text-red-400">{status.message}</p>
      )}

      {status.kind === 'loaded' && (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          {status.count} building{status.count === 1 ? '' : 's'} loaded
          {status.fromCache ? ' (cached)' : ''}.
        </p>
      )}

      <ul className="flex flex-col gap-1 border-t border-zinc-200 pt-2 text-xs dark:border-zinc-800">
        {CATEGORY_ORDER.map((category) => (
          <li key={category} className="flex items-center gap-2">
            <span
              aria-hidden
              className="h-3 w-3 shrink-0 rounded-sm"
              style={{ backgroundColor: BUILDING_CATEGORY_COLORS[category] }}
            />
            <span className="text-zinc-600 dark:text-zinc-300">
              {BUILDING_CATEGORY_LABELS[category]}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
