import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { categorizeBuildingTag, simplifyIfDense } from '@/lib/buildings';
import { sparseBuildingsFeatureCollectionArb, buildDenseFixture } from '@/lib/buildings.testutils';

/** OSM-plausible building tag values mixed with arbitrary garbage strings. */
const tagArb = fc.oneof(
  fc.constantFrom(
    'house',
    'residential',
    'apartments',
    'detached',
    'terrace',
    'semidetached_house',
    'commercial',
    'retail',
    'office',
    'shop',
    'supermarket',
    'industrial',
    'warehouse',
    'manufacture',
    'yes',
  ),
  fc.string(),
  fc.constant(undefined),
);

const VALID_CATEGORIES = new Set(['residential', 'commercial', 'industrial', 'other']);

describe('lib/buildings — correctness properties', () => {
  // Property 3 & 4: Categorization totality & determinism
  // Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5
  it('Property 3: categorizeBuildingTag always returns one of the four categories and never throws', () => {
    fc.assert(
      fc.property(tagArb, (tag) => {
        expect(() => categorizeBuildingTag(tag)).not.toThrow();
        const category = categorizeBuildingTag(tag);
        expect(VALID_CATEGORIES.has(category)).toBe(true);
      }),
    );
  });

  it('Property 4: categorizeBuildingTag is deterministic across repeated calls', () => {
    fc.assert(
      fc.property(tagArb, (tag) => {
        const first = categorizeBuildingTag(tag);
        const second = categorizeBuildingTag(tag);
        expect(second).toBe(first);
      }),
    );
  });

  // Property 8: Simplification preserves feature count and properties
  // Validates: Requirements 9.3
  it('Property 8: simplifyIfDense preserves feature count and each feature\'s properties (sparse input)', () => {
    fc.assert(
      fc.property(sparseBuildingsFeatureCollectionArb, (fc_) => {
        const result = simplifyIfDense(fc_);
        expect(result.features.length).toBe(fc_.features.length);
        for (let i = 0; i < fc_.features.length; i++) {
          expect(result.features[i].properties).toEqual(fc_.features[i].properties);
        }
      }),
    );
  });

  it('Property 8: simplifyIfDense preserves feature count and properties on a dense fixture', () => {
    // Well above the density threshold: many features with high vertex counts.
    const dense = buildDenseFixture(50, 2000);
    const result = simplifyIfDense(dense);

    expect(result.features.length).toBe(dense.features.length);
    for (let i = 0; i < dense.features.length; i++) {
      expect(result.features[i].properties).toEqual(dense.features[i].properties);
    }
  });
});
