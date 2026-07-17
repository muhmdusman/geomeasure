'use client';

/**
 * components/SearchBar.tsx — an address/place search box that flies the shared
 * Leaflet map to a selected geocoding result.
 *
 * Like BuildingsLayer, this operates on the SAME map instance owned by Map.tsx
 * (passed in via the `map` prop) rather than creating its own. It never touches
 * `drawnItems` or the buildings layer — its only map interaction is moving the
 * view (`fitBounds`/`setView`) and dropping a temporary marker on the result.
 *
 * Geocoding uses OpenStreetMap's Nominatim service (see lib/geocode.ts). Input
 * is debounced and superseded lookups are aborted to respect Nominatim's usage
 * policy (no per-keystroke bulk traffic).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import L from 'leaflet';

import { GeocodeError, geocodeAddress } from '@/lib/geocode';
import type { GeocodeResult } from '@/types/geo';

export interface SearchBarProps {
  /** The single Leaflet map instance owned by Map.tsx; null until it is ready. */
  map: L.Map | null;
}

/** Debounce (ms) before firing a geocode request after the user stops typing. */
const DEBOUNCE_MS = 450;

/** Minimum query length before we bother searching. */
const MIN_QUERY_LENGTH = 3;

/** Zoom level used when a result has no bounding box (a precise point). */
const POINT_RESULT_ZOOM = 16;

/**
 * A self-contained marker icon built from HTML/CSS (a `divIcon`) so we don't
 * depend on Leaflet's default PNG marker assets, which commonly 404 under
 * bundlers like Next.js/Turbopack unless their image URLs are re-wired.
 */
function createSearchIcon(): L.DivIcon {
  return L.divIcon({
    className: 'search-result-marker',
    html:
      '<span style="display:block;width:16px;height:16px;border-radius:9999px;' +
      'background:#2563eb;border:3px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,0.25);"></span>',
    iconSize: [16, 16],
    iconAnchor: [8, 8],
    popupAnchor: [0, -10],
  });
}

type Status =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'results'; results: GeocodeResult[] }
  | { kind: 'empty' }
  | { kind: 'error'; message: string };

/** True when `err` is the platform's `AbortError` raised by a cancelled fetch. */
function isAbortError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const candidate = err as { name?: unknown; code?: unknown };
  return candidate.name === 'AbortError' || candidate.code === 20;
}

/** Short, user-facing message for a caught geocoding failure. */
function describeError(err: unknown): string {
  if (err instanceof GeocodeError) {
    switch (err.kind) {
      case 'network':
        return 'Could not reach the search service. Check your connection.';
      case 'http':
        return `Search service error (HTTP ${err.status ?? 'unknown'}). Try again.`;
      case 'parse':
        return 'Search service returned an unexpected response.';
    }
  }
  return 'Something went wrong while searching. Try again.';
}

export default function SearchBar({ map }: SearchBarProps) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [open, setOpen] = useState(false);

  const controllerRef = useRef<AbortController | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // ---- Debounced geocoding on query change --------------------------------
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      // Cancel any in-flight request and reset to idle for short/empty input.
      controllerRef.current?.abort();
      setStatus({ kind: 'idle' });
      return;
    }

    const timeoutId = setTimeout(async () => {
      // Supersede any previous in-flight lookup.
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      setStatus({ kind: 'loading' });
      setOpen(true);

      try {
        const results = await geocodeAddress(trimmed, { signal: controller.signal });
        if (results.length === 0) {
          setStatus({ kind: 'empty' });
        } else {
          setStatus({ kind: 'results', results });
        }
      } catch (err) {
        if (isAbortError(err)) return; // superseded; stay silent
        setStatus({ kind: 'error', message: describeError(err) });
      }
    }, DEBOUNCE_MS);

    return () => clearTimeout(timeoutId);
  }, [query]);

  // ---- Cancel any in-flight request on unmount -----------------------------
  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
    };
  }, []);

  // ---- Close the results dropdown on an outside click ----------------------
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  // ---- Fly to a chosen result and drop a marker ----------------------------
  const goToResult = useCallback(
    (result: GeocodeResult) => {
      if (!map) return;

      if (result.boundingBox) {
        const [south, north, west, east] = result.boundingBox;
        // Leaflet bounds are [[south, west], [north, east]].
        map.fitBounds([
          [south, west],
          [north, east],
        ]);
      } else {
        map.setView([result.lat, result.lon], POINT_RESULT_ZOOM);
      }

      // Replace any previous search marker with one at the new location.
      if (markerRef.current) {
        map.removeLayer(markerRef.current);
      }
      const marker = L.marker([result.lat, result.lon], { icon: createSearchIcon() });
      marker.addTo(map).bindPopup(result.displayName).openPopup();
      markerRef.current = marker;

      setQuery(result.displayName);
      setOpen(false);
    },
    [map],
  );

  // ---- Remove the marker when the map goes away (unmount/remount) ----------
  useEffect(() => {
    return () => {
      if (map && markerRef.current) {
        map.removeLayer(markerRef.current);
        markerRef.current = null;
      }
    };
  }, [map]);

  const results = status.kind === 'results' ? status.results : [];

  return (
    <div
      ref={containerRef}
      className="absolute left-1/2 top-3 z-[1000] w-[min(92vw,420px)] -translate-x-1/2"
      data-testid="search-bar"
    >
      <div className="flex items-center gap-2 rounded-md border border-zinc-200 bg-white/95 px-3 py-2 shadow-md backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-950/95">
        <svg
          aria-hidden
          viewBox="0 0 20 20"
          className="h-4 w-4 shrink-0 text-zinc-400"
          fill="currentColor"
        >
          <path
            fillRule="evenodd"
            d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z"
            clipRule="evenodd"
          />
        </svg>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => {
            if (results.length > 0) setOpen(true);
          }}
          placeholder="Search for an address or place…"
          aria-label="Search for an address or place"
          className="w-full bg-transparent text-sm text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100"
        />
        {status.kind === 'loading' && (
          <span
            role="status"
            aria-label="Searching"
            className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-zinc-300 border-t-blue-600 dark:border-zinc-700"
          />
        )}
        {query.length > 0 && status.kind !== 'loading' && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              setQuery('');
              setStatus({ kind: 'idle' });
              setOpen(false);
            }}
            className="shrink-0 rounded p-0.5 text-zinc-400 transition-colors hover:text-zinc-600 dark:hover:text-zinc-200"
          >
            <svg viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor" aria-hidden>
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        )}
      </div>

      {open && (status.kind === 'results' || status.kind === 'empty' || status.kind === 'error') && (
        <div className="mt-1 overflow-hidden rounded-md border border-zinc-200 bg-white shadow-lg dark:border-zinc-800 dark:bg-zinc-950">
          {status.kind === 'results' && (
            <ul className="max-h-72 overflow-y-auto py-1 text-sm">
              {status.results.map((result) => (
                <li key={result.placeId}>
                  <button
                    type="button"
                    onClick={() => goToResult(result)}
                    className="block w-full px-3 py-2 text-left text-zinc-700 transition-colors hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
                  >
                    {result.displayName}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {status.kind === 'empty' && (
            <p className="px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400">
              No matches found. Try a different search.
            </p>
          )}

          {status.kind === 'error' && (
            <p className="px-3 py-2 text-xs text-red-600 dark:text-red-400">{status.message}</p>
          )}
        </div>
      )}
    </div>
  );
}
