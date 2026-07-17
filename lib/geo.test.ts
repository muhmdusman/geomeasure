import { describe, it, expect } from 'vitest';
import type { Feature, Polygon } from 'geojson';
import { calculateArea, isPolygonFeature } from '@/lib/geo';

/**
 * Build a 1° × 1° axis-aligned box whose south-west corner is at
 * `[lng, lat]`. Coordinates are `[lng, lat]` and the ring is closed.
 */
function oneDegreeBox(lng: number, lat: number): Feature<Polygon> {
  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [lng, lat],
          [lng + 1, lat],
          [lng + 1, lat + 1],
          [lng, lat + 1],
          [lng, lat],
        ],
      ],
    },
  };
}

describe('calculateArea — geodesic behavior', () => {
  it('computes a smaller area for a 1° box near the pole than near the equator', () => {
    const nearEquator = oneDegreeBox(0, 0); // 0°..1° lat
    const nearPole = oneDegreeBox(0, 80); // 80°..81° lat

    const equatorArea = calculateArea(nearEquator);
    const poleArea = calculateArea(nearPole);

    // Geodesic area shrinks with latitude: a 1° box near the pole spans far
    // less real-world surface than one at the equator.
    expect(poleArea.m2).toBeLessThan(equatorArea.m2);
    expect(poleArea.m2).toBeGreaterThan(0);
  });

  it('produces an illustrative magnitude for a 1° equatorial box', () => {
    const { m2, km2, acres, marla } = calculateArea(oneDegreeBox(0, 0));

    // A 1° box near the equator is roughly ~111 km on a side => ~12,300 km².
    expect(km2).toBeGreaterThan(11_000);
    expect(km2).toBeLessThan(13_500);

    // Cross-check unit conversions against the raw square-meter value.
    expect(km2).toBeCloseTo(m2 / 1_000_000, 6);
    expect(acres).toBeCloseTo(m2 / 4046.8564224, 3);
    expect(marla).toBeCloseTo((m2 * 10.7639104167) / 272.25, 3);
  });

  it('produces a much smaller magnitude for a 1° box near the pole', () => {
    const { km2 } = calculateArea(oneDegreeBox(0, 80));

    // Near 80° latitude the same 1° box collapses to a few thousand km².
    expect(km2).toBeGreaterThan(1_000);
    expect(km2).toBeLessThan(4_000);
  });

  it('does not mutate the input feature', () => {
    const feature = oneDegreeBox(-122.48, 37.83);
    const snapshot = structuredClone(feature);

    calculateArea(feature);

    expect(feature).toEqual(snapshot);
  });

  it('throws a clear error for invalid input', () => {
    const notAPolygon = {
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
    } as unknown as Feature<Polygon>;

    expect(() => calculateArea(notAPolygon)).toThrowError(/valid GeoJSON Feature<Polygon>/);
  });
});

describe('isPolygonFeature — validation examples', () => {
  it('accepts a well-formed closed polygon feature', () => {
    expect(isPolygonFeature(oneDegreeBox(0, 0))).toBe(true);
  });

  it('rejects non-object inputs', () => {
    expect(isPolygonFeature(null)).toBe(false);
    expect(isPolygonFeature(undefined)).toBe(false);
    expect(isPolygonFeature(42)).toBe(false);
    expect(isPolygonFeature('Feature')).toBe(false);
  });

  it('rejects a LineString geometry', () => {
    expect(
      isPolygonFeature({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
      }),
    ).toBe(false);
  });

  it('rejects a MultiPolygon geometry', () => {
    expect(
      isPolygonFeature({
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'MultiPolygon',
          coordinates: [oneDegreeBox(0, 0).geometry.coordinates],
        },
      }),
    ).toBe(false);
  });

  it('rejects an unclosed outer ring', () => {
    expect(
      isPolygonFeature({
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
            ],
          ],
        },
      }),
    ).toBe(false);
  });

  it('rejects a ring with fewer than 4 positions', () => {
    expect(
      isPolygonFeature({
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [[[0, 0], [1, 0], [0, 0]]],
        },
      }),
    ).toBe(false);
  });

  it('rejects out-of-range coordinates', () => {
    expect(
      isPolygonFeature({
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [200, 0],
              [201, 0],
              [201, 1],
              [200, 1],
              [200, 0],
            ],
          ],
        },
      }),
    ).toBe(false);
  });

  it('rejects a feature missing its geometry', () => {
    expect(isPolygonFeature({ type: 'Feature', properties: {} })).toBe(false);
  });
});
