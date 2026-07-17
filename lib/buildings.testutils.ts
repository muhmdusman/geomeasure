import fc from 'fast-check';
import type { Feature, FeatureCollection, Polygon, Position } from 'geojson';
import type { BuildingProperties } from '@/types/geo';

/**
 * Test-only helpers: fast-check arbitraries for building fixture building
 * FeatureCollections with a controllable vertex density. Kept out of the
 * production module, importable from any `*.test.ts` file under `lib/`.
 */

const lngArb = fc.double({ min: -180, max: 180, noNaN: true });
const latArb = fc.double({ min: -85, max: 85, noNaN: true });

/** A closed ring with `vertexCount` positions (including the closing repeat). */
function ringWithVertexCount(
  centerLng: number,
  centerLat: number,
  vertexCount: number,
): Position[] {
  const n = Math.max(4, vertexCount);
  const ring: Position[] = [];
  const radius = 0.001;
  for (let i = 0; i < n - 1; i++) {
    const angle = (2 * Math.PI * i) / (n - 1);
    ring.push([centerLng + radius * Math.cos(angle), centerLat + radius * Math.sin(angle)]);
  }
  ring.push(ring[0]); // close the ring
  return ring;
}

/**
 * Arbitrary yielding a `Feature<Polygon, BuildingProperties>` whose outer ring
 * has approximately `verticesPerFeature` positions.
 */
function buildingFeatureArb(
  verticesPerFeature: number,
): fc.Arbitrary<Feature<Polygon, BuildingProperties>> {
  return fc
    .record({
      lng: lngArb,
      lat: latArb,
      building: fc.constantFrom('house', 'retail', 'warehouse', 'yes', undefined),
      name: fc.option(fc.string({ maxLength: 10 }), { nil: undefined }),
    })
    .map(({ lng, lat, building, name }) => ({
      type: 'Feature' as const,
      properties: { building, name } as BuildingProperties,
      geometry: {
        type: 'Polygon' as const,
        coordinates: [ringWithVertexCount(lng, lat, verticesPerFeature)],
      },
    }));
}

/**
 * Arbitrary yielding a `FeatureCollection` of building features whose total
 * vertex count is randomized but generally sparse (well under any density
 * threshold likely to be exercised in tests).
 */
export const sparseBuildingsFeatureCollectionArb: fc.Arbitrary<
  FeatureCollection<Polygon, BuildingProperties>
> = fc
  .array(buildingFeatureArb(6), { minLength: 0, maxLength: 20 })
  .map((features) => ({ type: 'FeatureCollection' as const, features }));

/**
 * Build a `FeatureCollection` with exactly `featureCount` features, each
 * with `verticesPerFeature` ring positions — used to construct fixtures on
 * either side of the density threshold deterministically.
 */
export function buildDenseFixture(
  featureCount: number,
  verticesPerFeature: number,
): FeatureCollection<Polygon, BuildingProperties> {
  const features: Feature<Polygon, BuildingProperties>[] = [];
  for (let i = 0; i < featureCount; i++) {
    features.push({
      type: 'Feature',
      properties: { building: i % 2 === 0 ? 'house' : 'retail', name: `Fixture ${i}` },
      geometry: {
        type: 'Polygon',
        coordinates: [ringWithVertexCount(i * 0.01, 0, verticesPerFeature)],
      },
    });
  }
  return { type: 'FeatureCollection', features };
}
