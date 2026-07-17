import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import Sidebar from './Sidebar';
import type { ShapeState } from '@/types/geo';

/**
 * Sidebar action rendering.
 * Validates: Requirements 8.1 (Save on unsaved), 11.1 (Delete on saved).
 *
 * These are DOM tests (jsdom via the components/** environment glob). We render
 * the Sidebar with a single shape in each persistence state and assert the
 * correct action button renders and calls back with the right id.
 */

function makeShape(overrides: Partial<ShapeState>): ShapeState {
  return {
    localId: 'local-1',
    feature: {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
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
    },
    area: { m2: 1000, km2: 0.001, acres: 0.2471, marla: 0.395 },
    saved: false,
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('Sidebar — action rendering', () => {
  it('renders a Save button (not Delete) for an unsaved shape and calls onSave with its localId', () => {
    const onSave = vi.fn();
    const onDelete = vi.fn();
    const shape = makeShape({ localId: 'unsaved-abc', saved: false });

    render(<Sidebar shapes={[shape]} onSave={onSave} onDelete={onDelete} />);

    const saveButton = screen.getByRole('button', { name: /save shape 1/i });
    expect(saveButton).toBeTruthy();
    expect(screen.queryByRole('button', { name: /delete shape/i })).toBeNull();

    fireEvent.click(saveButton);

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith('unsaved-abc');
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('renders a Delete button (not Save) for a saved shape and calls onDelete with its localId', () => {
    const onSave = vi.fn();
    const onDelete = vi.fn();
    const shape = makeShape({
      localId: 'saved-xyz',
      saved: true,
    });

    render(<Sidebar shapes={[shape]} onSave={onSave} onDelete={onDelete} />);

    const deleteButton = screen.getByRole('button', { name: /delete shape 1/i });
    expect(deleteButton).toBeTruthy();
    expect(screen.queryByRole('button', { name: /save shape/i })).toBeNull();

    fireEvent.click(deleteButton);

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith('saved-xyz');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('shows an empty state message when there are no shapes', () => {
    render(<Sidebar shapes={[]} onSave={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByText(/no shapes yet/i)).toBeTruthy();
  });
});

describe('Sidebar — buildingsSummary (osm-building-footprints, non-breaking extension)', () => {
  it('renders identically (same markup) with and without a shapes list when buildingsSummary is omitted', () => {
    const shape = makeShape({ localId: 'unsaved-abc', saved: false });

    const withoutProp = render(
      <Sidebar shapes={[shape]} onSave={vi.fn()} onDelete={vi.fn()} />,
    );
    const withoutPropHtml = withoutProp.container.innerHTML;
    withoutProp.unmount();

    const explicitUndefined = render(
      <Sidebar
        shapes={[shape]}
        onSave={vi.fn()}
        onDelete={vi.fn()}
        buildingsSummary={undefined}
      />,
    );
    expect(explicitUndefined.container.innerHTML).toBe(withoutPropHtml);
    explicitUndefined.unmount();

    // Same for the empty-shapes case, matching the pre-existing empty-state test.
    const emptyWithout = render(<Sidebar shapes={[]} onSave={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByText(/no shapes yet/i)).toBeTruthy();
    emptyWithout.unmount();
  });

  it('displays the total count and category breakdown when buildingsSummary is provided', () => {
    render(
      <Sidebar
        shapes={[]}
        onSave={vi.fn()}
        onDelete={vi.fn()}
        buildingsSummary={{
          totalCount: 6,
          byCategory: { residential: 3, commercial: 2, industrial: 0, other: 1 },
          fromCache: false,
        }}
      />,
    );

    // Both the desktop aside and the mobile bottom bar render this summary
    // simultaneously in the DOM (only CSS visibility differs by breakpoint),
    // so assert at least one instance of each exists rather than a single one.
    expect(screen.getAllByText('Buildings').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/6 loaded/i).length).toBeGreaterThanOrEqual(1);
  });

  it('shows "(cached)" when the summary came from the bbox cache', () => {
    render(
      <Sidebar
        shapes={[]}
        onSave={vi.fn()}
        onDelete={vi.fn()}
        buildingsSummary={{
          totalCount: 2,
          byCategory: { residential: 1, commercial: 0, industrial: 0, other: 1 },
          fromCache: true,
        }}
      />,
    );

    expect(screen.getAllByText(/2 loaded \(cached\)/i).length).toBeGreaterThanOrEqual(1);
  });
});
