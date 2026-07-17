import type { Feature, MultiPolygon, Polygon } from 'geojson';

/**
 * A GeoJSON Feature whose geometry is guaranteed to be a Polygon.
 *
 * IMPORTANT — coordinate order: GeoJSON positions are stored as
 * `[longitude, latitude]` (RFC 7946). This is the REVERSE of Leaflet's
 * `LatLng(lat, lng)` order. Always convert at the map ↔ GeoJSON boundary.
 */
export type PolygonFeature = Feature<Polygon>;

/**
 * The computed geodesic area of a polygon, expressed in multiple units.
 *
 * - `m2`    — square meters (from `turf.area`), always >= 0
 * - `km2`   — square kilometers (`m2 / 1_000_000`)
 * - `acres` — international acres (`m2 / 4046.8564224`)
 * - `marla` — a traditional South Asian land unit (Pakistan, India's Punjab /
 *             Haryana / Himachal Pradesh, Bangladesh), standardized as
 *             **272.25 square feet**. Computed as
 *             `(m2 * 10.7639104167) / 272.25`.
 */
export interface AreaResult {
  m2: number;
  km2: number;
  acres: number;
  marla: number;
}

/**
 * An in-memory representation of a shape on the client.
 *
 * Bridges the drawn Leaflet layer, its GeoJSON geometry, and the computed area,
 * along with a session-only `saved` flag. There is no backend in this version;
 * all state lives in memory for the current session.
 */
export interface ShapeState {
  /** Stable client-side id (e.g. `crypto.randomUUID()`), unique per session. */
  localId: string;
  /** The GeoJSON geometry, coordinates in `[longitude, latitude]` order. */
  feature: PolygonFeature;
  /** The computed area in m², km², and acres. */
  area: AreaResult;
  /** `true` once the user has clicked "Save" (in-memory for now). */
  saved: boolean;
  /** `L.stamp(layer)` used to correlate this shape with its Leaflet layer. */
  leafletLayerId?: number;
}

// ---------------------------------------------------------------------------
// OSM building footprints (osm-building-footprints feature)
//
// These types are additive: they do not modify PolygonFeature, AreaResult, or
// ShapeState above, which continue to back the manual draw/edit/delete flow.
// ---------------------------------------------------------------------------

/**
 * The subset of OSM tags we care about on a fetched building feature, as
 * produced by converting an Overpass response with `osmtogeojson`.
 *
 * `building` is free-form OSM data (e.g. `'house'`, `'residential'`,
 * `'commercial'`, `'retail'`, `'industrial'`, `'yes'` for untyped buildings, or
 * any other OSM value) and is never validated/rejected — `categorizeBuildingTag`
 * in `lib/buildings.ts` accepts any string or `undefined` without throwing.
 * Additional OSM tags pass through untyped via the index signature.
 */
export interface BuildingProperties {
  building?: string;
  name?: string;
  [tag: string]: unknown;
}

/**
 * The four display categories a building's OSM `building` tag is bucketed
 * into for styling and the legend. See `categorizeBuildingTag` in
 * `lib/buildings.ts` for the exact tag → category mapping.
 */
export type BuildingCategory = 'residential' | 'commercial' | 'industrial' | 'other';

/**
 * A GeoJSON Feature for a fetched OSM building footprint.
 *
 * Unlike `PolygonFeature` (strictly `Polygon`, used for manually drawn
 * shapes), building geometry may be `Polygon` OR `MultiPolygon` — OSM
 * `relation["building"]` footprints frequently convert to `MultiPolygon`.
 */
export type BuildingFeature = Feature<Polygon | MultiPolygon, BuildingProperties>;

/**
 * A summary of the currently-rendered building set: how many buildings were
 * fetched, broken down by category, and whether the render came from the
 * in-memory bbox cache rather than a fresh Overpass fetch.
 *
 * Invariant: `totalCount === sum(Object.values(byCategory))`, and all four
 * `BuildingCategory` keys are always present in `byCategory` (defaulting to
 * `0`), so consumers never need an `undefined` check.
 */
export interface BuildingsSummary {
  totalCount: number;
  byCategory: Record<BuildingCategory, number>;
  fromCache: boolean;
}

// ---------------------------------------------------------------------------
// Address search / geocoding (Nominatim)
// ---------------------------------------------------------------------------

/**
 * A single geocoding match returned by the Nominatim search service, narrowed
 * to the fields the address search bar needs.
 *
 * - `displayName` — human-readable label shown in the results dropdown.
 * - `lat` / `lon` — the matched location in decimal degrees (WGS84).
 * - `boundingBox` — optional `[south, north, west, east]` extent so the map can
 *   frame the whole result (e.g. a city) instead of just centering on a point.
 */
export interface GeocodeResult {
  placeId: number;
  displayName: string;
  lat: number;
  lon: number;
  boundingBox?: [south: number, north: number, west: number, east: number];
}
