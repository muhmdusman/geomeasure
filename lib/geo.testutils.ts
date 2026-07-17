import fc from 'fast-check';
import type { Feature, Polygon, Position } from 'geojson';

/**
 * Test-only helpers: fast-check arbitraries for building valid and malformed
 * GeoJSON polygon features. Kept out of the production module so it never ships
 * in the app bundle, but importable from any `*.test.ts` file under `lib/`.
 */

/** A finite longitude within GeoJSON bounds. */
const lngArb = fc.double({ min: -180, max: 180, noNaN: true });
/** A finite latitude within GeoJSON bounds. */
const latArb = fc.double({ min: -90, max: 90, noNaN: true });

/**
 * Build an axis-aligned "box" ring from a center and half-extents, clamped to
 * valid lng/lat bounds and explicitly closed (first position equals last).
 */
function boxRing(
  centerLng: number,
  centerLat: number,
  halfWidth: number,
  halfHeight: number,
): Position[] {
  const clampLng = (v: number) => Math.min(180, Math.max(-180, v));
  const clampLat = (v: number) => Math.min(90, Math.max(-90, v));

  const west = clampLng(centerLng - halfWidth);
  const east = clampLng(centerLng + halfWidth);
  const south = clampLat(centerLat - halfHeight);
  const north = clampLat(centerLat + halfHeight);

  return [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south], // closed ring
  ];
}

/**
 * Arbitrary that yields a valid `Feature<Polygon>` with a single closed outer
 * ring. Coordinates are `[lng, lat]` and stay within GeoJSON bounds.
 */
export const validPolygonFeatureArb: fc.Arbitrary<Feature<Polygon>> = fc
  .record({
    centerLng: lngArb,
    centerLat: latArb,
    halfWidth: fc.double({ min: 0.0001, max: 5, noNaN: true }),
    halfHeight: fc.double({ min: 0.0001, max: 5, noNaN: true }),
  })
  .map(({ centerLng, centerLat, halfWidth, halfHeight }) => ({
    type: 'Feature' as const,
    properties: {},
    geometry: {
      type: 'Polygon' as const,
      coordinates: [boxRing(centerLng, centerLat, halfWidth, halfHeight)],
    },
  }));

/**
 * Arbitrary that yields values which are NOT valid polygon features. Covers a
 * spread of malformed shapes: wrong geometry types, unclosed rings, non-objects,
 * missing fields, and out-of-range coordinates.
 */
export const malformedPolygonInputArb: fc.Arbitrary<unknown> = fc.oneof(
  // Non-object primitives and null.
  fc.constant(null),
  fc.constant(undefined),
  fc.integer(),
  fc.string(),
  fc.boolean(),

  // Missing/incorrect top-level type.
  fc.record({
    type: fc.constantFrom('FeatureCollection', 'Polygon', 'NotAFeature'),
    geometry: fc.constant({ type: 'Polygon', coordinates: [] }),
  }),

  // Wrong geometry type: LineString.
  fc.record({
    centerLng: lngArb,
    centerLat: latArb,
  }).map(({ centerLng, centerLat }) => ({
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'LineString',
      coordinates: [
        [centerLng, centerLat],
        [centerLng + 1, centerLat + 1],
      ],
    },
  })),

  // Wrong geometry type: MultiPolygon.
  fc.record({
    centerLng: lngArb,
    centerLat: latArb,
    halfWidth: fc.double({ min: 0.0001, max: 5, noNaN: true }),
    halfHeight: fc.double({ min: 0.0001, max: 5, noNaN: true }),
  }).map(({ centerLng, centerLat, halfWidth, halfHeight }) => ({
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'MultiPolygon',
      coordinates: [[boxRing(centerLng, centerLat, halfWidth, halfHeight)]],
    },
  })),

  // Unclosed ring (first != last).
  fc.record({
    centerLng: lngArb,
    centerLat: latArb,
    halfWidth: fc.double({ min: 0.0001, max: 5, noNaN: true }),
    halfHeight: fc.double({ min: 0.0001, max: 5, noNaN: true }),
  }).map(({ centerLng, centerLat, halfWidth, halfHeight }) => {
    const ring = boxRing(centerLng, centerLat, halfWidth, halfHeight);
    return {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [ring.slice(0, ring.length - 1)], // drop closing vertex
      },
    };
  }),

  // Too few positions (< 4) even if "closed".
  fc.record({ lng: lngArb, lat: latArb }).map(({ lng, lat }) => ({
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [lng, lat],
          [lng + 1, lat],
          [lng, lat],
        ],
      ],
    },
  })),

  // Missing geometry field entirely.
  fc.constant({ type: 'Feature', properties: {} }),

  // Empty coordinates array.
  fc.constant({
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [] },
  }),

  // Out-of-range coordinates (lng > 180 / lat > 90).
  fc.record({
    badLng: fc.double({ min: 180.0001, max: 1000, noNaN: true }),
    badLat: fc.double({ min: 90.0001, max: 1000, noNaN: true }),
  }).map(({ badLng, badLat }) => ({
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [badLng, badLat],
          [badLng, badLat + 0.001],
          [badLng + 0.001, badLat + 0.001],
          [badLng + 0.001, badLat],
          [badLng, badLat],
        ],
      ],
    },
  })),
);
