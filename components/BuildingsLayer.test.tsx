import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeatureCollection } from 'geojson';

/**
 * components/BuildingsLayer.test.tsx
 *
 * Leaflet is mocked (same approach as the existing components/Map.test.tsx)
 * so these tests never need a real browser canvas. `lib/overpass.ts` is also
 * mocked so cache/zoom-guard/stale-request behavior can be controlled
 * precisely without hitting the network. `lib/buildings.ts` is used for real
 * (its pure functions have no DOM dependency), which also exercises the real
 * `categorizeBuildingTag`/`buildingPopupHtml` integration.
 */

// ---- Shared trackers (hoisted so the vi.mock factory below can close over them) --
const tracker = vi.hoisted(() => ({
  addLayerCalls: 0,
  clearLayersCalls: 0,
  lastGeoJsonLayers: [] as Array<{ _fireClick: () => void; bindPopup: ReturnType<typeof vi.fn> }>,
}));

vi.mock('leaflet', () => {
  class FeatureGroup {
    layers: unknown[] = [];
    addTo(map: { addLayer: (l: unknown) => void }) {
      map.addLayer(this);
      return this;
    }
    addLayer(layer: unknown) {
      tracker.addLayerCalls += 1;
      this.layers.push(layer);
    }
    clearLayers() {
      tracker.clearLayersCalls += 1;
      this.layers = [];
    }
  }

  const geoJSON = vi.fn((fc: FeatureCollection, options?: {
    style?: (feature?: unknown) => unknown;
    onEachFeature?: (feature: unknown, layer: unknown) => void;
  }) => {
    const layers = fc.features.map((feature) => {
      const handlers: Record<string, () => void> = {};
      const layer = {
        on: (evt: string, cb: () => void) => {
          handlers[evt] = cb;
        },
        bindPopup: vi.fn(function bindPopup(this: unknown) {
          return this;
        }),
        openPopup: vi.fn(function openPopup(this: unknown) {
          return this;
        }),
        _fireClick: () => handlers.click?.(),
      };
      options?.style?.(feature);
      options?.onEachFeature?.(feature, layer);
      return layer;
    });
    tracker.lastGeoJsonLayers = layers;
    return { __isGeoJsonLayer: true, __layers: layers };
  });

  const L = { FeatureGroup, geoJSON };
  return { default: L, ...L };
});

vi.mock('@/lib/overpass', () => {
  class OverpassError extends Error {
    kind: string;
    status?: number;
    constructor(kind: string, message: string, status?: number) {
      super(message);
      this.name = 'OverpassError';
      this.kind = kind;
      this.status = status;
    }
  }
  return {
    OVERPASS_ENDPOINT: 'https://overpass-api.de/api/interpreter',
    MIN_BUILDINGS_ZOOM: 15,
    OverpassError,
    fetchBuildingsInBounds: vi.fn(),
  };
});

import BuildingsLayer from './BuildingsLayer';
import { fetchBuildingsInBounds, OverpassError } from '@/lib/overpass';

const mockedFetch = fetchBuildingsInBounds as unknown as ReturnType<typeof vi.fn>;

/** A fake bounds object; `contains` behavior is controlled per-test. */
function makeFakeBounds(containsResult: boolean) {
  return { contains: vi.fn(() => containsResult) };
}

/** A minimal fake L.Map satisfying everything BuildingsLayer calls on it. */
function makeFakeMap(zoom: number, bounds: { contains: (b: unknown) => boolean }) {
  // Support multiple handlers per event (e.g. both the zoom-guard moveend and
  // the draw-isolation listeners) rather than a single-slot map.
  const listeners: Record<string, Array<() => void>> = {};
  const panes: Record<string, { style: Record<string, string> }> = {};
  return {
    getZoom: vi.fn(() => zoom),
    getBounds: vi.fn(() => bounds),
    getPane: vi.fn((name: string) => panes[name]),
    createPane: vi.fn((name: string) => {
      const pane = { style: {} as Record<string, string> };
      panes[name] = pane;
      return pane;
    }),
    on: vi.fn((evt: string, cb: () => void) => {
      (listeners[evt] ??= []).push(cb);
    }),
    off: vi.fn((evt: string, cb?: () => void) => {
      if (!listeners[evt]) return;
      listeners[evt] = cb ? listeners[evt].filter((fn) => fn !== cb) : [];
    }),
    addLayer: vi.fn(),
    removeLayer: vi.fn(),
    _fireMoveEnd: () => listeners.moveend?.forEach((fn) => fn()),
    _fireEvent: (evt: string) => listeners[evt]?.forEach((fn) => fn()),
  };
}

function buildingFeature(building: string | undefined) {
  return {
    type: 'Feature' as const,
    properties: { building },
    geometry: {
      type: 'Polygon' as const,
      coordinates: [
        [
          [0, 0],
          [0.0001, 0],
          [0.0001, 0.0001],
          [0, 0.0001],
          [0, 0],
        ],
      ],
    },
  };
}

beforeEach(() => {
  tracker.addLayerCalls = 0;
  tracker.clearLayersCalls = 0;
  tracker.lastGeoJsonLayers = [];
  mockedFetch.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('BuildingsLayer — zoom guard and cache correctness (Properties 5 & 6)', () => {
  it('never calls fetchBuildingsInBounds when zoom is below MIN_BUILDINGS_ZOOM', async () => {
    const map = makeFakeMap(10, makeFakeBounds(false));
    render(<BuildingsLayer map={map as never} />);

    fireEvent.click(screen.getByRole('button', { name: /load buildings here/i }));

    expect(mockedFetch).not.toHaveBeenCalled();
    expect(await screen.findByText(/zoom in further/i)).toBeTruthy();
  });

  it('never calls fetchBuildingsInBounds when the viewport is contained in the cache', async () => {
    // `cache.bounds.contains(currentViewport)` is what BuildingsLayer checks —
    // i.e. the bounds object stored in the cache is the one whose `.contains`
    // is consulted, NOT the current viewport's bounds object.
    const cachedBounds = makeFakeBounds(true);
    const map = makeFakeMap(16, cachedBounds);
    mockedFetch.mockResolvedValueOnce({
      type: 'FeatureCollection',
      features: [buildingFeature('house')],
    });

    render(<BuildingsLayer map={map as never} />);
    fireEvent.click(screen.getByRole('button', { name: /load buildings here/i }));

    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(1));

    // Second trigger, same (now-cached) bounds object — contains() returns
    // true, so this must be treated as a cache hit.
    fireEvent.click(screen.getByRole('button', { name: /load buildings here/i }));

    await waitFor(() => {
      expect(screen.getByText(/1 building loaded \(cached\)/i)).toBeTruthy();
    });
    // Still only the one call from the first (cache-miss) trigger.
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(cachedBounds.contains).toHaveBeenCalled();
  });

  it('calls fetchBuildingsInBounds when the viewport is NOT contained in the cache', async () => {
    const map = makeFakeMap(16, makeFakeBounds(false));
    mockedFetch.mockResolvedValue({ type: 'FeatureCollection', features: [] });

    render(<BuildingsLayer map={map as never} />);
    fireEvent.click(screen.getByRole('button', { name: /load buildings here/i }));
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: /load buildings here/i }));
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(2));
  });
});

describe('BuildingsLayer — stale request handling (Property 11)', () => {
  it('renders only the most recently triggered request\'s result and shows no error for the aborted one', async () => {
    const map = makeFakeMap(16, makeFakeBounds(false));

    let resolveFirst!: (v: FeatureCollection) => void;
    let firstSignal: AbortSignal | undefined;
    let secondSignal: AbortSignal | undefined;

    mockedFetch
      .mockImplementationOnce((_bounds: unknown, opts?: { signal?: AbortSignal }) => {
        firstSignal = opts?.signal;
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      })
      .mockImplementationOnce((_bounds: unknown, opts?: { signal?: AbortSignal }) => {
        secondSignal = opts?.signal;
        return Promise.resolve({
          type: 'FeatureCollection',
          features: [buildingFeature('retail')],
        });
      });

    render(<BuildingsLayer map={map as never} />);

    fireEvent.click(screen.getByRole('button', { name: /load buildings here/i }));
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(1));

    // Trigger a second load before the first resolves — the first's controller
    // must be aborted.
    fireEvent.click(screen.getByRole('button', { name: /load buildings here/i }));
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(2));

    expect(firstSignal?.aborted).toBe(true);
    expect(secondSignal?.aborted).toBe(false);

    // Now resolve the FIRST (stale) request after the second already resolved.
    resolveFirst({ type: 'FeatureCollection', features: [buildingFeature('house')] });

    await waitFor(() => {
      expect(screen.getByText(/1 building loaded/i)).toBeTruthy();
    });
    // No error shown for the superseded/aborted request.
    expect(screen.queryByText(/went wrong/i)).toBeNull();
  });
});

describe('BuildingsLayer — empty and error UI states', () => {
  it('shows the "no data" message on an empty FeatureCollection (not an error)', async () => {
    const map = makeFakeMap(16, makeFakeBounds(false));
    mockedFetch.mockResolvedValueOnce({ type: 'FeatureCollection', features: [] });

    render(<BuildingsLayer map={map as never} />);
    fireEvent.click(screen.getByRole('button', { name: /load buildings here/i }));

    expect(await screen.findByText(/no building data available/i)).toBeTruthy();
    expect(screen.queryByText(/went wrong/i)).toBeNull();
  });

  it('shows a distinct error message on a non-abort OverpassError, without throwing', async () => {
    const map = makeFakeMap(16, makeFakeBounds(false));
    mockedFetch.mockRejectedValueOnce(new OverpassError('http', 'boom', 504));

    render(<BuildingsLayer map={map as never} />);

    expect(() =>
      fireEvent.click(screen.getByRole('button', { name: /load buildings here/i })),
    ).not.toThrow();

    expect(await screen.findByText(/HTTP 504/i)).toBeTruthy();
    expect(screen.queryByText(/no building data available/i)).toBeNull();
  });
});

describe('BuildingsLayer — batched rendering and lazy area computation (Properties 9 & 12)', () => {
  it('adds the fetched set via exactly one addLayer call regardless of feature count', async () => {
    const map = makeFakeMap(16, makeFakeBounds(false));
    mockedFetch.mockResolvedValueOnce({
      type: 'FeatureCollection',
      features: [buildingFeature('house'), buildingFeature('retail'), buildingFeature(undefined)],
    });

    render(<BuildingsLayer map={map as never} />);
    fireEvent.click(screen.getByRole('button', { name: /load buildings here/i }));

    await waitFor(() => expect(screen.getByText(/3 buildings loaded/i)).toBeTruthy());
    // One batched addLayer call for the whole geoJSON group, not per-feature.
    expect(tracker.addLayerCalls).toBe(1);
  });

  it('computes area lazily: only on click, not during load/render', async () => {
    const map = makeFakeMap(16, makeFakeBounds(false));
    mockedFetch.mockResolvedValueOnce({
      type: 'FeatureCollection',
      features: [buildingFeature('house')],
    });

    render(<BuildingsLayer map={map as never} />);
    fireEvent.click(screen.getByRole('button', { name: /load buildings here/i }));
    await waitFor(() => expect(screen.getByText(/1 building loaded/i)).toBeTruthy());

    const [layer] = tracker.lastGeoJsonLayers;
    expect(layer.bindPopup).not.toHaveBeenCalled(); // no popup bound before a click

    layer._fireClick();

    expect(layer.bindPopup).toHaveBeenCalledTimes(1);
    const popupHtml = layer.bindPopup.mock.calls[0][0] as string;
    expect(popupHtml).toContain('m²');
  });

  it('calls onBuildingsChange with a correct category breakdown', async () => {
    const map = makeFakeMap(16, makeFakeBounds(false));
    mockedFetch.mockResolvedValueOnce({
      type: 'FeatureCollection',
      features: [buildingFeature('house'), buildingFeature('retail'), buildingFeature('yes')],
    });
    const onBuildingsChange = vi.fn();

    render(<BuildingsLayer map={map as never} onBuildingsChange={onBuildingsChange} />);
    fireEvent.click(screen.getByRole('button', { name: /load buildings here/i }));

    await waitFor(() => expect(onBuildingsChange).toHaveBeenCalled());
    const summary = onBuildingsChange.mock.calls[onBuildingsChange.mock.calls.length - 1][0];
    expect(summary.totalCount).toBe(3);
    expect(summary.byCategory).toEqual({ residential: 1, commercial: 1, industrial: 0, other: 1 });
    expect(summary.fromCache).toBe(false);
  });
});

describe('BuildingsLayer — layer isolation from manual drawing (Property 10)', () => {
  it('never references or manipulates any drawnItems-like layer — only its own FeatureGroup', async () => {
    // BuildingsLayer has no knowledge of Map.tsx's `drawnItems` FeatureGroup at
    // all (no import, no prop referencing it), so by construction it cannot
    // add/remove/mutate it. This test confirms its only map interactions are
    // scoped to addLayer/removeLayer for ITS OWN FeatureGroup and the
    // non-mutating getZoom/getBounds/on/off calls — never any draw-control API.
    const map = makeFakeMap(16, makeFakeBounds(false));
    mockedFetch.mockResolvedValueOnce({
      type: 'FeatureCollection',
      features: [buildingFeature('house')],
    });

    const { unmount } = render(<BuildingsLayer map={map as never} />);

    // FeatureGroup creation calls map.addLayer once (for the buildings group).
    expect(map.addLayer).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /load buildings here/i }));
    await waitFor(() => expect(screen.getByText(/1 building loaded/i)).toBeTruthy());

    // Loading buildings must not call map.addLayer again (only the buildings
    // FeatureGroup's OWN addLayer is used for the fetched layer, tracked above
    // as tracker.addLayerCalls) — map.addLayer stays at 1 (group creation only).
    expect(map.addLayer).toHaveBeenCalledTimes(1);

    unmount();
    // Cleanup removes only the buildings FeatureGroup from the map.
    expect(map.removeLayer).toHaveBeenCalledTimes(1);
  });
});
