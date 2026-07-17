'use client';

/**
 * components/Map.tsx — the core Leaflet integration.
 *
 * SSR workaround: Leaflet touches `window`/`document` at import and runtime, so
 * this file is marked `'use client'` AND is expected to be loaded by the parent
 * exclusively through `next/dynamic(() => import('./Map'), { ssr: false })`.
 * That combination guarantees none of this module's browser-only code runs
 * during server rendering. As a defensive belt-and-suspenders measure the init
 * effect also early-returns when `typeof window === 'undefined'`.
 *
 * Coordinate-order gotcha: GeoJSON stores positions as `[longitude, latitude]`
 * (RFC 7946) which is the REVERSE of Leaflet's `LatLng(lat, lng)`. Leaflet's
 * `layer.toGeoJSON()` and `L.geoJSON(feature)` handle this conversion for us in
 * both directions, so we always keep `[lng, lat]` on the GeoJSON side and let
 * Leaflet own the `LatLng` side. Comments below flag each boundary.
 */

import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet-draw';
import 'leaflet-draw/dist/leaflet.draw.css';

import { calculateArea } from '@/lib/geo';
import type { AreaResult, PolygonFeature, ShapeState } from '@/types/geo';

export interface MapProps {
  shapes: ShapeState[];
  onShapeCreated: (shape: ShapeState) => void;
  onShapeEdited: (localId: string, feature: PolygonFeature, area: AreaResult) => void;
  onShapeDeleted: (localIds: string[]) => void;
  /**
   * Called once, immediately after the Leaflet map is created (even under
   * React Strict Mode double-invoke this fires exactly once, since it runs
   * after the same `mapRef.current` guard that protects map creation).
   * Lets a sibling component (e.g. BuildingsLayer) add its own layer to this
   * SAME map instance instead of creating a second map.
   */
  onMapReady?: (map: L.Map) => void;
}

/** Default map view: centered on Pakistan so the country is framed on load. */
const DEFAULT_CENTER: L.LatLngExpression = [30.3753, 69.3451];
const DEFAULT_ZOOM = 6;

const OSM_TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTRIBUTION = '&copy; OpenStreetMap contributors';
const OSM_MAX_ZOOM = 19;

/**
 * Build the popup HTML for a shape's computed area (km², acres, and marla —
 * 1 marla = 272.25 sq ft, the standard used in Pakistan/Punjab-region land
 * measurement).
 */
function areaPopupHtml(area: AreaResult): string {
  return `<div class="area-popup"><strong>Area</strong><br/>${area.m2.toFixed(
    2,
  )} m²<br/>${area.km2.toFixed(6)} km²<br/>${area.acres.toFixed(
    4,
  )} acres<br/>${area.marla.toFixed(2)} marla (272.25 sq ft)</div>`;
}

/**
 * Bind (and refresh) the area popup on a Leaflet layer.
 */
function bindAreaPopup(layer: L.Layer, area: AreaResult): void {
  layer.bindPopup(areaPopupHtml(area));
}

export default function Map(props: MapProps) {
  // Keep the latest callbacks in a ref so the init effect (which runs once)
  // always invokes the current props without needing them in its dep array.
  const propsRef = useRef(props);
  propsRef.current = props;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const drawnItemsRef = useRef<L.FeatureGroup | null>(null);

  // Correlate a Leaflet layer (via `L.stamp`) back to its shared-state localId.
  // NOTE: this component is named `Map`, which shadows the global `Map`
  // constructor in module scope, so we reference `globalThis.Map` explicitly.
  const stampToLocalIdRef = useRef<Map<number, string>>(new globalThis.Map());
  // Track which saved-shape localIds have already been seeded onto the map so
  // the [props.shapes] sync effect only adds each saved shape once.
  const seededLocalIdsRef = useRef<Set<string>>(new Set());

  // ---- Map initialization (Algorithm A) -----------------------------------
  // Empty dep array: run once on mount. In React Strict Mode (development) the
  // effect body is intentionally invoked twice; the `mapRef.current` guard makes
  // the second invocation a no-op so only ONE live map instance ever exists.
  useEffect(() => {
    // SSR belt-and-suspenders: never touch Leaflet without a DOM.
    if (typeof window === 'undefined') return;
    // Strict-Mode / re-init guard: a map already exists for this container.
    if (mapRef.current) return;
    if (!containerRef.current) return;

    const map = L.map(containerRef.current, {
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      // Canvas rendering is noticeably faster than SVG once many polygons are
      // on screen (e.g. after loading OSM building footprints). This only
      // affects L.Path rendering — leaflet-draw's edit-mode vertex handles
      // are DOM markers and are unaffected.
      preferCanvas: true,
    });
    mapRef.current = map;

    // Expose the map instance to sibling components (e.g. BuildingsLayer) so
    // they can add their own layer to this SAME map rather than creating a
    // second Leaflet map. Fires exactly once, even under Strict Mode, because
    // it runs after the `mapRef.current` guard above.
    propsRef.current.onMapReady?.(map);

    L.tileLayer(OSM_TILE_URL, {
      attribution: OSM_ATTRIBUTION,
      maxZoom: OSM_MAX_ZOOM,
    }).addTo(map);

    // Feature group that holds every editable/deletable shape.
    const drawnItems = new L.FeatureGroup();
    map.addLayer(drawnItems);
    drawnItemsRef.current = drawnItems;

    // Draw control: polygon + rectangle only; edit/delete operate on drawnItems.
    const drawControl = new L.Control.Draw({
      draw: {
        polygon: {},
        rectangle: {},
        polyline: false,
        circle: false,
        marker: false,
        circlemarker: false,
      },
      edit: {
        featureGroup: drawnItems,
      },
    });
    map.addControl(drawControl);

    // ---- CREATED handler (Algorithm B) ------------------------------------
    map.on(L.Draw.Event.CREATED, (e: L.LeafletEvent) => {
      const layer = (e as L.DrawEvents.Created).layer;
      drawnItems.addLayer(layer);

      // toGeoJSON() emits [lng, lat] GeoJSON regardless of Leaflet's LatLng order.
      const feature = layer.toGeoJSON() as PolygonFeature;
      // Rectangles serialize as Polygon too; guard defensively.
      if (feature.geometry.type !== 'Polygon') return;

      const area = calculateArea(feature);
      bindAreaPopup(layer, area);
      layer.openPopup();

      const localId = crypto.randomUUID();
      const stamp = L.stamp(layer);
      stampToLocalIdRef.current.set(stamp, localId);
      // This layer is already on the map. Mark it before updating parent state
      // so the shapes sync effect does not immediately add a duplicate copy.
      seededLocalIdsRef.current.add(localId);

      propsRef.current.onShapeCreated({
        localId,
        feature,
        area,
        saved: false,
        leafletLayerId: stamp,
      });
    });

    // ---- EDITED handler (Algorithm B) -------------------------------------
    map.on(L.Draw.Event.EDITED, (e: L.LeafletEvent) => {
      const layers = (e as L.DrawEvents.Edited).layers;
      layers.eachLayer((layer: L.Layer) => {
        // `L.Layer` doesn't declare `toGeoJSON`, but drawn polygon/rectangle
        // layers implement it (they are `L.Polygon`), emitting [lng, lat].
        const feature = (layer as L.Polygon).toGeoJSON() as PolygonFeature;
        if (feature.geometry.type !== 'Polygon') return;

        const area = calculateArea(feature);
        bindAreaPopup(layer, area);

        const localId = stampToLocalIdRef.current.get(L.stamp(layer));
        if (localId) {
          propsRef.current.onShapeEdited(localId, feature, area);
        }
      });
    });

    // ---- DELETED handler (Algorithm B) ------------------------------------
    map.on(L.Draw.Event.DELETED, (e: L.LeafletEvent) => {
      const layers = (e as L.DrawEvents.Deleted).layers;
      const localIds: string[] = [];
      layers.eachLayer((layer: L.Layer) => {
        const stamp = L.stamp(layer);
        const localId = stampToLocalIdRef.current.get(stamp);
        if (localId) {
          localIds.push(localId);
          // Clean up correlation maps so stale stamps can't leak.
          stampToLocalIdRef.current.delete(stamp);
          seededLocalIdsRef.current.delete(localId);
        }
      });
      if (localIds.length > 0) {
        propsRef.current.onShapeDeleted(localIds);
      }
    });

    // Seed any shapes already present at mount (parent may also populate later;
    // the [props.shapes] effect below handles the async-arrival case).
    seedSavedShapes(propsRef.current.shapes, drawnItems);

    // ---- Cleanup ----------------------------------------------------------
    return () => {
      map.remove(); // frees DOM nodes + all listeners
      mapRef.current = null;
      drawnItemsRef.current = null;
      stampToLocalIdRef.current.clear();
      seededLocalIdsRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Saved-shape seeding (Algorithm A seeding loop) ---------------------
  // Add each saved shape to the map exactly once (keyed by localId). This runs
  // both from the init effect (initial mount) and whenever props.shapes changes
  // because the parent typically fetches saved shapes asynchronously and passes
  // them in after the map has already mounted.
  function seedSavedShapes(shapes: ShapeState[], drawnItems: L.FeatureGroup) {
    for (const shape of shapes) {
      if (seededLocalIdsRef.current.has(shape.localId)) continue;

      // GeoJSON coordinates are [lng, lat]; L.geoJSON converts them to Leaflet
      // LatLng internally. It returns a group, so iterate the produced layers
      // and add each to drawnItems (correlating stamps for edit/delete).
      const geoLayer = L.geoJSON(shape.feature);
      geoLayer.eachLayer((layer: L.Layer) => {
        bindAreaPopup(layer, shape.area);
        drawnItems.addLayer(layer);
        stampToLocalIdRef.current.set(L.stamp(layer), shape.localId);
      });

      seededLocalIdsRef.current.add(shape.localId);
    }
  }

  useEffect(() => {
    const drawnItems = drawnItemsRef.current;
    if (!drawnItems) return; // map not initialized yet
    seedSavedShapes(props.shapes, drawnItems);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.shapes]);

  // Container fills its parent; the page provides the full-screen height.
  return <div ref={containerRef} className="h-full w-full" />;
}
