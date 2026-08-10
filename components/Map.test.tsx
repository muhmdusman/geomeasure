import { StrictMode } from 'react';
import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Property 8: Single map instance.
 * Validates: Requirements 2.3, 2.4 (Strict-Mode single instance + cleanup).
 *
 * Real Leaflet needs a browser canvas, so we mock `leaflet` entirely and track
 * how many  maps are created vs. removed. The assertion is on the NET number of
 * live map instances: even though React Strict Mode invokes the mount effect
 * twice, the `mapRef.current` guard must keep exactly one live map, and unmount
 * must fully tear it down via  `map.remove()`.
 */

// Shared trackers, hoisted so the vi.mock factory below can close over them.
const tracker = vi.hoisted(() => ({
  created: 0,
  removed: 0,
  removeSpies: [] as Array<() => void>,
}));

// Mock CSS side-effect imports so jsdom/vitest doesn't try to parse them.
vi.mock('leaflet/dist/leaflet.css', () => ({}));
vi.mock('leaflet-draw/dist/leaflet.draw.css', () => ({}));
vi.mock('leaflet-draw', () => ({}));

vi.mock('leaflet', () => {
  const makeMap = () => {
    tracker.created += 1;
    const remove = vi.fn(() => {
      tracker.removed += 1;
    });
    tracker.removeSpies.push(remove);
    return {
      on: vi.fn(),
      addLayer: vi.fn(),
      addControl: vi.fn(),
      removeControl: vi.fn(),
      remove,
    };
  };

  class FeatureGroup {
    addLayer = vi.fn();
    eachLayer = vi.fn();
  }

  const L = {
    map: vi.fn(makeMap),
    tileLayer: vi.fn(() => ({ addTo: vi.fn() })),
    FeatureGroup,
    Control: {
      Draw: class {
        constructor(..._args: unknown[]) {}
      },
    },
    Draw: {
      Event: {
        CREATED: 'draw:created',
        EDITED: 'draw:edited',
        DELETED: 'draw:deleted',
      },
    },
    geoJSON: vi.fn(() => ({ eachLayer: vi.fn() })),
    stamp: vi.fn(() => 1),
  };

  return { default: L, ...L };
});

// Import AFTER the mocks are registered.
import Map from './Map';
import L from 'leaflet';

const noop = () => {};

const baseProps = {
  shapes: [],
  onShapeCreated: noop,
  onShapeEdited: noop,
  onShapeDeleted: noop,
};

beforeEach(() => {
  tracker.created = 0;
  tracker.removed = 0;
  tracker.removeSpies = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Map — onMapReady callback and preferCanvas (osm-building-footprints)', () => {
  it('passes preferCanvas: true to L.map', () => {
    render(<Map {...baseProps} />);

    expect(L.map).toHaveBeenCalled();
    const optionsArg = (L.map as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(optionsArg).toMatchObject({ preferCanvas: true });
  });

  it('calls onMapReady once per live map created, and never again after unmount', () => {
    const onMapReady = vi.fn();

    // NOTE: React Strict Mode's double-invoke is mount -> cleanup -> mount
    // (not two mounts without a cleanup in between). Since cleanup resets
    // mapRef.current to null before the second invocation, the guard does NOT
    // block the second invocation — a second, genuinely new map is created,
    // and the first is torn down. So onMapReady fires once per REAL map
    // creation (matching `L.map()` call count), and its last call reflects
    // the surviving (not-yet-removed) map — exactly the map still on screen.
    const { unmount } = render(
      <StrictMode>
        <Map {...baseProps} onMapReady={onMapReady} />
      </StrictMode>,
    );

    expect(onMapReady).toHaveBeenCalledTimes(tracker.created);
    const lastReadyMap = onMapReady.mock.calls[onMapReady.mock.calls.length - 1][0];
    expect(lastReadyMap.remove).not.toHaveBeenCalled(); // the surviving map is still live

    const callCountAfterMount = onMapReady.mock.calls.length;
    unmount();
    // Unmounting must not fire it again.
    expect(onMapReady).toHaveBeenCalledTimes(callCountAfterMount);
  });

  it('does not throw when onMapReady is omitted', () => {
    expect(() => render(<Map {...baseProps} />)).not.toThrow();
  });
});

describe('Map — single map instance (Property 8)', () => {
  it('creates at most one live map under React Strict Mode double-invoke', () => {
    const { unmount } = render(
      <StrictMode>
        <Map {...baseProps} />
      </StrictMode>,
    );

    // Under Strict Mode the mount effect runs twice; the mapRef guard means the
    // net number of live maps (created minus removed) must be exactly one.
    const liveAfterMount = tracker.created - tracker.removed;
    expect(liveAfterMount).toBe(1);

    unmount();

    // After unmount every created map must be torn down: no live maps remain.
    const liveAfterUnmount = tracker.created - tracker.removed;
    expect(liveAfterUnmount).toBe(0);
  });

  it('calls map.remove() on unmount to free resources', () => {
    const { unmount } = render(<Map {...baseProps} />);

    expect(tracker.created).toBeGreaterThanOrEqual(1);
    unmount();

    // At least one remove spy exists and the most recent live map was removed.
    expect(tracker.removeSpies.length).toBeGreaterThanOrEqual(1);
    expect(tracker.removeSpies.some((spy) => spy.mock.calls.length > 0)).toBe(true);
    expect(tracker.created - tracker.removed).toBe(0);
  });
});
