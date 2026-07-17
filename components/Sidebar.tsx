'use client';

/**
 * components/Sidebar.tsx — the shape list panel, responsive across breakpoints.
 *
 * Two visual variants share the same `shapes`/`onSave`/`onDelete` props:
 *   - Desktop (`md:` and up): a left-hand `<aside>` listing every shape with
 *     its area and a Save/Delete action. Hidden on small screens
 *     (`hidden md:flex`) so it never takes space on a phone.
 *   - Mobile (below `md`): the aside is hidden and instead a compact bar is
 *     pinned to the BOTTOM of the screen (`fixed inset-x-0 bottom-0`) showing
 *     just the most recently drawn/edited shape's area plus one action. This
 *     keeps the map full-screen on phones while still surfacing the area the
 *     moment a shape is completed.
 *
 * Area units: every readout shows km², acres, and **marla** — a traditional
 * South Asian land unit. We standardize 1 marla = 272.25 sq ft, and show that
 * conversion in brackets next to the "Marla" label so the unit is unambiguous.
 */

import type { BuildingCategory, BuildingsSummary, ShapeState } from '@/types/geo';
import { BUILDING_CATEGORY_COLORS, BUILDING_CATEGORY_LABELS } from '@/lib/buildings';

export interface SidebarProps {
  shapes: ShapeState[];
  onSave: (localId: string) => void | Promise<void>;
  onDelete: (localId: string) => void | Promise<void>;
  /**
   * Optional summary of fetched OSM building footprints (osm-building-
   * footprints feature). When omitted, Sidebar renders exactly as it did
   * before this prop existed — no layout or behavior change.
   */
  buildingsSummary?: BuildingsSummary;
}

/** The fixed conversion note shown next to every "Marla" readout. */
const MARLA_NOTE = '1 marla = 272.25 sq ft';

/** Display order for the buildings category breakdown, matching the legend. */
const CATEGORY_ORDER: BuildingCategory[] = ['residential', 'commercial', 'industrial', 'other'];

/**
 * Small, shared block showing the fetched-building count and category
 * breakdown. Rendered in both the desktop sidebar and the mobile bottom bar
 * whenever `buildingsSummary` is provided.
 */
function BuildingsSummarySection({ summary }: { summary: BuildingsSummary }) {
  return (
    <div className="flex flex-col gap-1 border-t border-zinc-200 px-4 py-3 text-sm dark:border-zinc-800">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium">Buildings</span>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          {summary.totalCount} loaded{summary.fromCache ? ' (cached)' : ''}
        </span>
      </div>
      <ul className="flex flex-col gap-0.5 text-xs text-zinc-600 dark:text-zinc-300">
        {CATEGORY_ORDER.map((category) => (
          <li key={category} className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="h-2.5 w-2.5 shrink-0 rounded-sm"
                style={{ backgroundColor: BUILDING_CATEGORY_COLORS[category] }}
              />
              {BUILDING_CATEGORY_LABELS[category]}
            </span>
            <span className="font-mono">{summary.byCategory[category]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function Sidebar({ shapes, onSave, onDelete, buildingsSummary }: SidebarProps) {
  // The most recently drawn/edited shape (last in the array) is what the
  // mobile bottom bar surfaces — the one the user just finished drawing.
  const latestShape = shapes[shapes.length - 1];

  return (
    <>
      {/* ---- Desktop sidebar (hidden on phones) --------------------------- */}
      <aside className="hidden h-full w-80 flex-col overflow-y-auto border-r border-zinc-200 bg-white text-zinc-900 md:flex dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100">
        <div className="border-b border-zinc-200 px-4 py-4 dark:border-zinc-800">
          <h1 className="text-lg font-semibold tracking-tight">Shapes</h1>
          <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">
            Draw polygons or rectangles on the map to calculate their area.
          </p>
        </div>

        {shapes.length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-500 dark:text-zinc-400">
            No shapes yet. Use the draw tools on the map to add one.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800">
            {shapes.map((shape, index) => (
              <li key={shape.localId} className="flex flex-col gap-2 px-4 py-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium">Shape {index + 1}</span>
                  <span
                    className={
                      shape.saved
                        ? 'text-xs font-medium text-emerald-600 dark:text-emerald-400'
                        : 'text-xs font-medium text-amber-600 dark:text-amber-400'
                    }
                  >
                    {shape.saved ? 'Saved' : 'Unsaved'}
                  </span>
                </div>

                <dl className="text-sm text-zinc-600 dark:text-zinc-300">
                  <div className="flex justify-between">
                    <dt>Area (m²)</dt>
                    <dd className="font-mono">{shape.area.m2.toFixed(2)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt>Area (km²)</dt>
                    <dd className="font-mono">{shape.area.km2.toFixed(6)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt>Area (acres)</dt>
                    <dd className="font-mono">{shape.area.acres.toFixed(4)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt>Marla ({MARLA_NOTE.replace('1 marla = ', '')})</dt>
                    <dd className="font-mono">{shape.area.marla.toFixed(2)}</dd>
                  </div>
                </dl>

                {shape.saved ? (
                  <button
                    type="button"
                    aria-label={`Delete shape ${index + 1}`}
                    onClick={() => onDelete(shape.localId)}
                    className="mt-1 inline-flex items-center justify-center rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-red-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600"
                  >
                    Delete
                  </button>
                ) : (
                  <button
                    type="button"
                    aria-label={`Save shape ${index + 1}`}
                    onClick={() => onSave(shape.localId)}
                    className="mt-1 inline-flex items-center justify-center rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
                  >
                    Save
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        {buildingsSummary && <BuildingsSummarySection summary={buildingsSummary} />}
      </aside>

      {/* ---- Mobile bottom bar (hidden on md+ screens) -------------------- */}
      {/* Pinned to the viewport bottom so the map stays full-screen behind it.
          Rendered when there is a shape to report on and/or a buildings
          summary to show (buildingsSummary is additive and never required
          for this bar to appear for the pre-existing shape-only behavior). */}
      {(latestShape || buildingsSummary) && (
        <div
          className="fixed inset-x-0 bottom-0 z-[2000] flex flex-col gap-2 border-t border-zinc-200 bg-white/95 px-4 py-3 shadow-[0_-4px_12px_rgba(0,0,0,0.08)] backdrop-blur-sm md:hidden dark:border-zinc-800 dark:bg-zinc-950/95"
          style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
        >
          {latestShape && (
            <>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-semibold">Shape area</span>
                <span
                  className={
                    latestShape.saved
                      ? 'text-xs font-medium text-emerald-600 dark:text-emerald-400'
                      : 'text-xs font-medium text-amber-600 dark:text-amber-400'
                  }
                >
                  {latestShape.saved ? 'Saved' : 'Unsaved'}
                </span>
              </div>

              <div className="flex items-center justify-between gap-3 text-sm text-zinc-700 dark:text-zinc-200">
                <div className="flex flex-col">
                  <span className="font-mono">{latestShape.area.m2.toFixed(2)} m²</span>
                  <span className="font-mono">{latestShape.area.km2.toFixed(6)} km²</span>
                  <span className="font-mono">{latestShape.area.acres.toFixed(4)} acres</span>
                  <span className="font-mono">
                    {latestShape.area.marla.toFixed(2)} marla ({MARLA_NOTE.replace('1 marla = ', '')})
                  </span>
                </div>

                {latestShape.saved ? (
                  <button
                    type="button"
                    aria-label="Delete this area"
                    onClick={() => onDelete(latestShape.localId)}
                    className="inline-flex shrink-0 items-center justify-center rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600"
                  >
                    Delete
                  </button>
                ) : (
                  <button
                    type="button"
                    aria-label="Save this area"
                    onClick={() => onSave(latestShape.localId)}
                    className="inline-flex shrink-0 items-center justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
                  >
                    Save
                  </button>
                )}
              </div>
            </>
          )}

          {buildingsSummary && (
            <div
              className={
                latestShape
                  ? 'flex items-center justify-between gap-3 border-t border-zinc-200 pt-2 text-xs text-zinc-600 dark:border-zinc-800 dark:text-zinc-300'
                  : 'flex items-center justify-between gap-3 text-xs text-zinc-600 dark:text-zinc-300'
              }
            >
              <span className="font-medium">Buildings</span>
              <span className="font-mono">
                {buildingsSummary.totalCount} loaded{buildingsSummary.fromCache ? ' (cached)' : ''}
              </span>
            </div>
          )}
        </div>
      )}
    </>
  );
}
