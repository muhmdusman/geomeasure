import { describe, it, expect } from 'vitest';
import type { Feature, Polygon } from 'geojson';
import {
  categorizeBuildingTag,
  buildingPopupHtml,
  simplifyIfDense,
} from '@/lib/buildings';
import { buildDenseFixture } from '@/lib/buildings.testutils';
import type { BuildingProperties } from '@/types/geo';

describe('categorizeBuildingTag — known OSM tag mappings', () => {
  it.each([
    ['house', 'residential'],
    ['residential', 'residential'],
    ['apartments', 'residential'],
    ['retail', 'commercial'],
    ['commercial', 'commercial'],
    ['office', 'commercial'],
    ['warehouse', 'industrial'],
    ['industrial', 'industrial'],
    ['yes', 'other'],
    [undefined, 'other'],
    ['greenhouse', 'other'], // unrecognized OSM value
  ] as const)('categorizeBuildingTag(%s) -> %s', (tag, expected) => {
    expect(categorizeBuildingTag(tag)).toBe(expected);
  });
});

/** Build a 1° x 1° box feature (large — used to exercise the km² branch). */
function largeBoxFeature(): Feature<Polygon, BuildingProperties> {
  return {
    type: 'Feature',
    properties: { building: 'commercial' },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
          [0, 0],
        ],
      ],
    },
  };
}

/** Build a small (~100 m²) box feature — well under the km² threshold. */
function smallBoxFeature(): Feature<Polygon, BuildingProperties> {
  const d = 0.00009; // roughly a 10m x 10m box near the equator
  return {
    type: 'Feature',
    properties: { building: 'house' },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [d, 0],
          [d, d],
          [0, d],
          [0, 0],
        ],
      ],
    },
  };
}

describe('buildingPopupHtml', () => {
  it('includes m² but not km² for a small building', () => {
    const html = buildingPopupHtml(smallBoxFeature());
    expect(html).toContain('m²');
    expect(html).not.toContain('km²');
  });

  it('includes both m² and km² for a building >= 1,000,000 m²', () => {
    const html = buildingPopupHtml(largeBoxFeature());
    expect(html).toContain('m²');
    expect(html).toContain('km²');
  });

  it('includes the categorized building type label', () => {
    expect(buildingPopupHtml(largeBoxFeature())).toContain('Commercial');
    expect(buildingPopupHtml(smallBoxFeature())).toContain('Residential');
  });
});

describe('simplifyIfDense', () => {
  it('returns the input unchanged when the collection is sparse', () => {
    const sparse = buildDenseFixture(3, 6);
    const result = simplifyIfDense(sparse);
    expect(result).toBe(sparse); // same reference: cheap no-op path
  });

  it('simplifies geometry (without changing feature count) when dense', () => {
    const dense = buildDenseFixture(50, 2000);
    const result = simplifyIfDense(dense);
    expect(result.features.length).toBe(dense.features.length);
    // Simplification should not increase vertex count for any feature.
    for (let i = 0; i < dense.features.length; i++) {
      const inputRing = (dense.features[i].geometry as Polygon).coordinates[0];
      const outputRing = (result.features[i].geometry as Polygon).coordinates[0];
      expect(outputRing.length).toBeLessThanOrEqual(inputRing.length);
    }
  });
});
