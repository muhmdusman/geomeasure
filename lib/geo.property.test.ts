import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { calculateArea, isPolygonFeature } from '@/lib/geo';
import {
  validPolygonFeatureArb,
  malformedPolygonInputArb,
} from '@/lib/geo.testutils';

const SQUARE_METERS_PER_ACRE = 4046.8564224;
const SQUARE_METERS_PER_SQUARE_KM = 1_000_000;
const SQUARE_FEET_PER_SQUARE_METER = 10.7639104167;
const SQUARE_FEET_PER_MARLA = 272.25;

describe('lib/geo — correctness properties', () => {
  // Property 1: Area non-negativity
  // Validates: Requirements 4.4
  it('Property 1: area (m2, km2, acres, marla) is always >= 0 for valid features', () => {
    fc.assert(
      fc.property(validPolygonFeatureArb, (feature) => {
        const { m2, km2, acres, marla } = calculateArea(feature);
        expect(m2).toBeGreaterThanOrEqual(0);
        expect(km2).toBeGreaterThanOrEqual(0);
        expect(acres).toBeGreaterThanOrEqual(0);
        expect(marla).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  // Property 2: Unit conversion consistency
  // Validates: Requirements 4.2, 4.3
  it('Property 2: km2, acres, and marla are exact conversions of m2', () => {
    fc.assert(
      fc.property(validPolygonFeatureArb, (feature) => {
        const { m2, km2, acres, marla } = calculateArea(feature);
        expect(km2).toBe(m2 / SQUARE_METERS_PER_SQUARE_KM);
        expect(acres).toBe(m2 / SQUARE_METERS_PER_ACRE);
        expect(marla).toBe((m2 * SQUARE_FEET_PER_SQUARE_METER) / SQUARE_FEET_PER_MARLA);
      }),
    );
  });

  // Property 3: Purity / determinism
  // Validates: Requirements 4.5
  it('Property 3: repeated calls are deep-equal and never mutate the input', () => {
    fc.assert(
      fc.property(validPolygonFeatureArb, (feature) => {
        const before = JSON.stringify(feature);

        const first = calculateArea(feature);
        const second = calculateArea(feature);

        // Deep-equal results across repeated calls.
        expect(second).toEqual(first);

        // Input feature is not mutated.
        expect(JSON.stringify(feature)).toBe(before);
      }),
    );
  });

  // Property 5: Validation soundness
  // Validates: Requirements 9.4
  it('Property 5: isPolygonFeature returns true for valid features', () => {
    fc.assert(
      fc.property(validPolygonFeatureArb, (feature) => {
        expect(isPolygonFeature(feature)).toBe(true);
        // When true, the geometry is a closed-ring Polygon.
        expect(feature.geometry.type).toBe('Polygon');
        const ring = feature.geometry.coordinates[0];
        expect(ring.length).toBeGreaterThanOrEqual(4);
        expect(ring[0]).toEqual(ring[ring.length - 1]);
      }),
    );
  });

  it('Property 5: isPolygonFeature returns false for malformed inputs', () => {
    fc.assert(
      fc.property(malformedPolygonInputArb, (value) => {
        expect(isPolygonFeature(value)).toBe(false);
      }),
    );
  });
});
