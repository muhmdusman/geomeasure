import { useEffect, useState, type ComponentType } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MapProps } from './Map';

/**
 * AreaCalculatorApp — in-memory create/save/delete data-flow smoke test.
 *
 * There is no backend in this version, so nothing is fetched. Real Leaflet
 * needs a browser canvas, so the Map is mocked with a lightweight stub that
 * exposes buttons to drive `onShapeCreated`, letting us exercise the Save/Delete
 * paths end-to-end through the real Sidebar without touching Leaflet.
 */

// A stub feature used when the mocked Map "creates" a shape.
const stubFeature = {
  type: 'Feature' as const,
  properties: {},
  geometry: {
    type: 'Polygon' as const,
    coordinates: [
      [
        [-122.48, 37.83],
        [-122.48, 37.84],
        [-122.47, 37.84],
        [-122.47, 37.83],
        [-122.48, 37.83],
      ],
    ],
  },
};

// next/dynamic in jsdom is awkward with ssr:false, so replace it with a
// generic wrapper that resolves ANY loader (used for both the Map and
// BuildingsLayer dynamic imports) and renders the mocked module once ready.
// Uses real React state (not a bare closure variable) so resolving the loader
// reliably triggers a re-render regardless of microtask timing — this matters
// once more than one dynamic import is in play (Map + BuildingsLayer) and
// across vi.resetModules()/dynamic re-imports in the wiring tests below.
vi.mock('next/dynamic', () => ({
  default: <P extends object>(loader: () => Promise<{ default: ComponentType<P> }>) => {
    return function DynamicMock(props: P) {
      const [Comp, setComp] = useState<ComponentType<P> | null>(null);
      useEffect(() => {
        let active = true;
        void loader().then((mod) => {
          if (active) setComp(() => mod.default);
        });
        return () => {
          active = false;
        };
      }, []);
      return Comp ? <Comp {...props} /> : null;
    };
  },
}));

// Mock the Map component itself. It renders a button that invokes
// onShapeCreated with a stub unsaved shape so we can drive the Sidebar
// actions, and a button that invokes onMapReady with a fake map instance so
// the (also mocked, see below) BuildingsLayer can be exercised too.
vi.mock('./Map', () => ({
  default: (props: MapProps) => (
    <div data-testid="map">
      <button
        type="button"
        onClick={() =>
          props.onShapeCreated({
            localId: 'created-1',
            feature: stubFeature,
            area: { m2: 1000, km2: 0.001, acres: 0.2471, marla: 0.395 },
            saved: false,
          })
        }
      >
        simulate-create
      </button>
      <button type="button" onClick={() => props.onMapReady?.({} as never)}>
        simulate-map-ready
      </button>
    </div>
  ),
}));

// BuildingsLayer owns its own Leaflet FeatureGroup and Overpass fetching,
// which is unrelated to this wrapper-wiring smoke test and covered by its own
// component tests (components/BuildingsLayer.test.tsx). Mock it here to a
// simple stub so AreaCalculatorApp can render without needing a real Leaflet
// map instance or network access.
vi.mock('./BuildingsLayer', () => ({
  default: () => <div data-testid="buildings-layer" />,
}));

import AreaCalculatorApp from './AreaCalculatorApp';

afterEach(() => {
  vi.clearAllMocks();
});

describe('AreaCalculatorApp — in-memory create/save/delete', () => {
  it('starts empty and shows a created shape in the Sidebar with a Save button', async () => {
    render(<AreaCalculatorApp />);

    expect(screen.getByText(/no shapes yet/i)).toBeTruthy();

    // Simulate the Map creating a new in-memory (unsaved) shape.
    fireEvent.click(await screen.findByRole('button', { name: /simulate-create/i }));

    // The new unsaved shape shows a Save button in the Sidebar.
    expect(
      await screen.findByRole('button', { name: /save shape 1/i }),
    ).toBeTruthy();
  });

  it('marks a shape saved on Save, then removes it on Delete — all in memory', async () => {
    render(<AreaCalculatorApp />);

    fireEvent.click(await screen.findByRole('button', { name: /simulate-create/i }));

    // Save flips the shape to a Delete button (saved state).
    fireEvent.click(await screen.findByRole('button', { name: /save shape 1/i }));
    const deleteButton = await screen.findByRole('button', {
      name: /delete shape 1/i,
    });
    expect(deleteButton).toBeTruthy();

    // Delete removes it, returning to the empty state.
    fireEvent.click(deleteButton);
    await waitFor(() => {
      expect(screen.getByText(/no shapes yet/i)).toBeTruthy();
    });
  });
});

describe('AreaCalculatorApp — osm-building-footprints wiring', () => {
  it('forwards the map instance from onMapReady to BuildingsLayer via props', async () => {
    // Re-mock BuildingsLayer for this test to inspect the `map` prop it
    // receives, without affecting the module-level mock used by the tests
    // above (vi.doMock + dynamic re-import keeps this scoped).
    vi.resetModules();

    const receivedProps: { map: unknown }[] = [];
    vi.doMock('./BuildingsLayer', () => ({
      default: (props: { map: unknown }) => {
        receivedProps.push(props);
        return <div data-testid="buildings-layer" />;
      },
    }));

    const { default: AppWithSpy } = await import('./AreaCalculatorApp');
    render(<AppWithSpy />);

    // BuildingsLayer is itself behind a dynamic(ssr:false) import, so wait for
    // it to resolve before asserting on the props it received.
    await waitFor(() => expect(receivedProps.length).toBeGreaterThan(0));
    // Before the map is ready, BuildingsLayer must receive `map: null`.
    expect(receivedProps[receivedProps.length - 1].map).toBeNull();

    // Simulate Map.tsx calling onMapReady.
    fireEvent.click(await screen.findByRole('button', { name: /simulate-map-ready/i }));

    await waitFor(() => {
      expect(receivedProps[receivedProps.length - 1].map).not.toBeNull();
    });

    vi.doUnmock('./BuildingsLayer');
  });

  it('forwards onBuildingsChange updates from BuildingsLayer through to the Sidebar', async () => {
    vi.resetModules();

    vi.doMock('./BuildingsLayer', () => ({
      default: (props: { onBuildingsChange?: (s: unknown) => void }) => (
        <button
          type="button"
          onClick={() =>
            props.onBuildingsChange?.({
              totalCount: 4,
              byCategory: { residential: 2, commercial: 1, industrial: 0, other: 1 },
              fromCache: false,
            })
          }
        >
          simulate-buildings-change
        </button>
      ),
    }));

    const { default: AppWithSpy } = await import('./AreaCalculatorApp');
    render(<AppWithSpy />);

    fireEvent.click(
      await screen.findByRole('button', { name: /simulate-buildings-change/i }),
    );

    expect(await screen.findAllByText(/4 loaded/i)).not.toHaveLength(0);

    vi.doUnmock('./BuildingsLayer');
  });
});
