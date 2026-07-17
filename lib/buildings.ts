import { area, simplify } from '@turf/turf';
import type { Feature, FeatureCollection, GeometryObject } from 'geojson';
import type L from 'leaflet';
import type { BuildingCategory, BuildingFeature, BuildingProperties } from '@/types/geo';

/**
 * lib/buildings.ts — pure presentation/domain logic for fetched OSM building
 * features: categorization, styling, geometry simplification, and popup
 * formatting. No network, no Leaflet map calls, no React. Mirrors the
 * separation used by `lib/geo.ts`.
 */

/**
 * Above this many features, `BuildingsLayer` uses a single flat style instead
 * of a per-feature style function, keeping render cost roughly constant
 * regardless of the category mix.
 */
export const MAX_STYLED_FEATURES = 2000;

/** One color per BuildingCategory, used for both the map style and the legend. */
export const BUILDING_CATEGORY_COLORS: Record<BuildingCategory, string> = {
  residential: '#f59e0b', // amber
  commercial: '#3b82f6', // blue
  industrial: '#8b5cf6', // violet
  other: '#6b7280', // neutral gray
};

/** OSM `building` tag values that map to the `residential` category. */
const RESIDENTIAL_TAGS = new Set([
  'house',
  'residential',
  'apartments',
  'detached',
  'terrace',
  'semidetached_house',
]);

/** OSM `building` tag values that map to the `commercial` category. */
const COMMERCIAL_TAGS = new Set(['commercial', 'retail', 'office', 'shop', 'supermarket']);

/** OSM `building` tag values that map to the `industrial` category. */
const INDUSTRIAL_TAGS = new Set(['industrial', 'warehouse', 'manufacture']);

/**
 * Map a raw OSM `building` tag value to one of four display categories.
 *
 * Total function: accepts any `string | undefined` and never throws.
 * Untyped buildings (`'yes'`), unrecognized OSM values, and missing tags all
 * fall back to `'other'`. Deterministic — the same input always yields the
 * same category.
 */
export function categorizeBuildingTag(tag: string | undefined): BuildingCategory {
  if (tag === undefined) {
    return 'other';
  }
  if (RESIDENTIAL_TAGS.has(tag)) {
    return 'residential';
  }
  if (COMMERCIAL_TAGS.has(tag)) {
    return 'commercial';
  }
  if (INDUSTRIAL_TAGS.has(tag)) {
    return 'industrial';
  }
  // Includes 'yes' (untyped) and any unrecognized OSM value.
  return 'other';
}

/**
 * Leaflet path style for a single building feature, keyed on its category
 * (derived from `feature.properties.building`).
 */
export function styleForBuildingFeature(
  feature: Feature<GeometryObject, BuildingProperties>,
): L.PathOptions {
  const category = categorizeBuildingTag(feature.properties?.building);
  const color = BUILDING_CATEGORY_COLORS[category];
  return {
    color,
    weight: 1,
    fillColor: color,
    fillOpacity: 0.45,
  };
}

/**
 * Flat fallback style used when the result set is large (see
 * `MAX_STYLED_FEATURES`), avoiding a per-feature style callback.
 */
export function flatBuildingStyle(): L.PathOptions {
  return {
    color: BUILDING_CATEGORY_COLORS.other,
    weight: 1,
    fillColor: BUILDING_CATEGORY_COLORS.other,
    fillOpacity: 0.35,
  };
}

/**
 * Total vertex count across every ring of every feature in `fc`, used to
 * decide whether simplification is worthwhile.
 */
function countVertices(fc: FeatureCollection): number {
  let total = 0;
  for (const feature of fc.features) {
    const geom = feature.geometry;
    if (!geom) continue;
    if (geom.type === 'Polygon') {
      for (const ring of geom.coordinates) {
        total += ring.length;
      }
    } else if (geom.type === 'MultiPolygon') {
      for (const polygon of geom.coordinates) {
        for (const ring of polygon) {
          total += ring.length;
        }
      }
    }
  }
  return total;
}

/** Above this total vertex count, `simplifyIfDense` runs `turf.simplify()`. */
const DENSITY_VERTEX_THRESHOLD = 50_000;

/**
 * A small tolerance (in degrees, matching GeoJSON coordinate units) chosen to
 * shave redundant vertices from unusually dense/merged building geometry
 * without visibly distorting building outlines.
 */
const SIMPLIFY_TOLERANCE = 0.00001;

/**
 * Run `turf.simplify()` over every feature when the collection's total vertex
 * count exceeds a density threshold; otherwise return the input unchanged.
 *
 * Always preserves `features.length` and each feature's `properties` exactly
 * — only geometry coordinates may change.
 */
export function simplifyIfDense(fc: FeatureCollection): FeatureCollection {
  if (countVertices(fc) <= DENSITY_VERTEX_THRESHOLD) {
    return fc;
  }

  return {
    type: 'FeatureCollection',
    features: fc.features.map((feature) =>
      simplify(feature, { tolerance: SIMPLIFY_TOLERANCE, highQuality: false }),
    ),
  };
}

/** 1 km² = 1,000,000 m² — the threshold above which we also show km² in the popup. */
const SQUARE_METERS_PER_SQUARE_KM = 1_000_000;

/** Human-readable label for each BuildingCategory, used in popups and the legend. */
export const BUILDING_CATEGORY_LABELS: Record<BuildingCategory, string> = {
  residential: 'Residential',
  commercial: 'Commercial',
  industrial: 'Industrial',
  other: 'Other',
};

/**
 * Lazily compute a building's area (via `turf.area()`) and format the popup
 * HTML shown on click: its categorized OSM type and its area in m², plus km²
 * when the area is large (>= 1,000,000 m²).
 *
 * Calls `turf.area(feature)` exactly once. Callers MUST only invoke this from
 * a click handler — never during load/render — so loading a large result set
 * never pays this cost up front.
 */
export function buildingPopupHtml(feature: BuildingFeature): string {
  const category = categorizeBuildingTag(feature.properties?.building);
  const label = BUILDING_CATEGORY_LABELS[category];
  const m2 = area(feature);

  const lines = [`<strong>${label}</strong>`, `${m2.toFixed(1)} m²`];
  if (m2 >= SQUARE_METERS_PER_SQUARE_KM) {
    lines.push(`${(m2 / SQUARE_METERS_PER_SQUARE_KM).toFixed(4)} km²`);
  }

  return `<div class="building-popup">${lines.join('<br/>')}</div>`;
}
