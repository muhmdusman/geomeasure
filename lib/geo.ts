import { area } from '@turf/turf';
import type { Feature, Polygon, Position } from 'geojson';
import type { AreaResult } from '@/types/geo';

/** Longitude bounds per RFC 7946 (GeoJSON). */
const MIN_LNG = -180;
const MAX_LNG = 180;
/** Latitude bounds per RFC 7946 (GeoJSON). */
const MIN_LAT = -90;
const MAX_LAT = 90;

/** Exact international-acre conversion factor: 1 acre = 4046.8564224 m². */
const SQUARE_METERS_PER_ACRE = 4046.8564224;
/** 1 km² = 1,000,000 m². */
const SQUARE_METERS_PER_SQUARE_KM = 1_000_000;
/**
 * 1 marla = 272.25 square feet (the standard value used in Pakistan, India's
 * Punjab/Haryana/Himachal Pradesh, and Bangladesh). We convert m² -> sq ft
 * using the exact factor 1 m² = 10.7639104167 sq ft, then divide by 272.25.
 */
const SQUARE_FEET_PER_SQUARE_METER = 10.7639104167;
const SQUARE_FEET_PER_MARLA = 272.25;

/**
 * Narrow an arbitrary value to a valid GeoJSON `Feature<Polygon>`.
 *
 * A value is considered a valid polygon feature only when ALL of the following hold:
 * - it is a non-null object;
 * - `type === 'Feature'`;
 * - `geometry` is a non-null object with `geometry.type === 'Polygon'`;
 * - `geometry.coordinates` is a non-empty array of linear rings shaped as `number[][][]`;
 * - the outer ring has at least 4 positions and is closed (first position deep-equals last);
 * - every position is `[number, number]` with finite values within
 *   `-180 <= lng <= 180` and `-90 <= lat <= 90`.
 *
 * Accepts arbitrary `unknown` input and has no side effects (a proper type guard).
 */
export function isPolygonFeature(value: unknown): value is Feature<Polygon> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const feature = value as Record<string, unknown>;
  if (feature.type !== 'Feature') {
    return false;
  }

  const geometry = feature.geometry;
  if (typeof geometry !== 'object' || geometry === null) {
    return false;
  }

  const geom = geometry as Record<string, unknown>;
  if (geom.type !== 'Polygon') {
    return false;
  }

  const coordinates = geom.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length === 0) {
    return false;
  }

  // Every element must be a valid linear ring.
  for (const ring of coordinates) {
    if (!isValidLinearRing(ring)) {
      return false;
    }
  }

  return true;
}

/**
 * A linear ring is a closed array of at least 4 valid positions where the
 * first and last positions are equal.
 */
function isValidLinearRing(ring: unknown): ring is Position[] {
  if (!Array.isArray(ring) || ring.length < 4) {
    return false;
  }

  for (const position of ring) {
    if (!isValidPosition(position)) {
      return false;
    }
  }

  const first = ring[0] as Position;
  const last = ring[ring.length - 1] as Position;
  // Closed: first position deep-equals last.
  if (first[0] !== last[0] || first[1] !== last[1]) {
    return false;
  }

  return true;
}

/**
 * A position is `[lng, lat]` with finite numbers inside GeoJSON coordinate bounds.
 */
function isValidPosition(position: unknown): position is Position {
  if (!Array.isArray(position) || position.length !== 2) {
    return false;
  }

  const [lng, lat] = position;
  if (typeof lng !== 'number' || typeof lat !== 'number') {
    return false;
  }
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    return false;
  }
  if (lng < MIN_LNG || lng > MAX_LNG) {
    return false;
  }
  if (lat < MIN_LAT || lat > MAX_LAT) {
    return false;
  }

  return true;
}

/**
 * Compute the geodesic area of a polygon feature in multiple units.
 *
 * Pure and deterministic: does not mutate the input feature and always returns
 * `m2`, `km2`, `acres`, and `marla` that are `>= 0`, with
 * `km2 === m2 / 1_000_000`, `acres === m2 / 4046.8564224`, and
 * `marla === (m2 * 10.7639104167) / 272.25` (1 marla = 272.25 sq ft).
 *
 * @throws {Error} when `feature` is not a valid `Feature<Polygon>`.
 */
export function calculateArea(feature: Feature<Polygon>): AreaResult {
  if (!isPolygonFeature(feature)) {
    throw new Error(
      'calculateArea: input must be a valid GeoJSON Feature<Polygon> with a closed outer ring',
    );
  }

  const m2 = area(feature); // geodesic square meters, always >= 0
  const km2 = m2 / SQUARE_METERS_PER_SQUARE_KM;
  const acres = m2 / SQUARE_METERS_PER_ACRE;
  // marla = square feet / 272.25 (1 marla = 272.25 sq ft, the standard used
  // in Pakistan / Punjab region land measurement).
  const marla = (m2 * SQUARE_FEET_PER_SQUARE_METER) / SQUARE_FEET_PER_MARLA;

  return { m2, km2, acres, marla };
}
