// @vitest-environment jsdom
//
// Leaflet touches `window` even when just constructing an `L.LatLngBounds`
// (it runs browser-feature detection at module load), so this Node-environment
// module's tests are pinned to jsdom via the directive above.
import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import L from 'leaflet';
import { buildOverpassQuery, fetchBuildingsInBounds } from '@/lib/overpass';

/**
 * Correctness properties for lib/overpass.ts.
 *
 * `L.LatLngBounds` has no DOM dependency (it's pure lat/lng math), so it is
 * safe to construct and use in the Node test environment.
 */

/** A finite latitude within GeoJSON/Leaflet bounds, avoiding the poles. */
const latArb = fc.double({ min: -85, max: 85, noNaN: true });
/** A finite longitude within GeoJSON bounds. */
const lngArb = fc.double({ min: -180, max: 180, noNaN: true });

/** A random, valid, non-degenerate bounding box (south < north, west < east). */
const validBoundsArb: fc.Arbitrary<L.LatLngBounds> = fc
  .record({
    south: latArb,
    west: lngArb,
    heightDeg: fc.double({ min: 0.0001, max: 5, noNaN: true }),
    widthDeg: fc.double({ min: 0.0001, max: 5, noNaN: true }),
  })
  .map(({ south, west, heightDeg, widthDeg }) => {
    const north = Math.min(south + heightDeg, 89.9);
    const east = Math.min(west + widthDeg, 179.9);
    return L.latLngBounds([south, west], [north, east]);
  });

describe('lib/overpass — correctness properties', () => {
  // Property 1: Query bbox well-formedness
  // Validates: Requirements 4.2, 4.3
  it('Property 1: buildOverpassQuery embeds both clauses with south,west,north,east order', () => {
    fc.assert(
      fc.property(validBoundsArb, (bounds) => {
        const query = buildOverpassQuery(bounds);

        expect(query).toContain('way["building"]');
        expect(query).toContain('relation["building"]');

        const bbox = `${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()}`;
        expect(query).toContain(`way["building"](${bbox})`);
        expect(query).toContain(`relation["building"](${bbox})`);
      }),
    );
  });

  // Property 2: fetchBuildingsInBounds purity of input
  // Validates: Requirements 4.8
  it('Property 2: fetchBuildingsInBounds never mutates its bounds argument (success path)', async () => {
    await fc.assert(
      fc.asyncProperty(validBoundsArb, async (bounds) => {
        const snapshot = {
          south: bounds.getSouth(),
          west: bounds.getWest(),
          north: bounds.getNorth(),
          east: bounds.getEast(),
        };

        const fetchMock = vi.fn(
          async () =>
            new Response(JSON.stringify({ elements: [] }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
        );
        vi.stubGlobal('fetch', fetchMock);

        await fetchBuildingsInBounds(bounds);

        expect(bounds.getSouth()).toBe(snapshot.south);
        expect(bounds.getWest()).toBe(snapshot.west);
        expect(bounds.getNorth()).toBe(snapshot.north);
        expect(bounds.getEast()).toBe(snapshot.east);

        vi.unstubAllGlobals();
      }),
      { numRuns: 25 },
    );
  });

  it('Property 2: fetchBuildingsInBounds never mutates its bounds argument (failure path)', async () => {
    await fc.assert(
      fc.asyncProperty(validBoundsArb, async (bounds) => {
        const snapshot = {
          south: bounds.getSouth(),
          west: bounds.getWest(),
          north: bounds.getNorth(),
          east: bounds.getEast(),
        };

        vi.stubGlobal(
          'fetch',
          vi.fn(async () => {
            throw new Error('boom');
          }),
        );

        await expect(fetchBuildingsInBounds(bounds)).rejects.toThrow();

        expect(bounds.getSouth()).toBe(snapshot.south);
        expect(bounds.getWest()).toBe(snapshot.west);
        expect(bounds.getNorth()).toBe(snapshot.north);
        expect(bounds.getEast()).toBe(snapshot.east);

        vi.unstubAllGlobals();
      }),
      { numRuns: 25 },
    );
  });
});
