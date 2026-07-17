import osmtogeojson from 'osmtogeojson';
import type { FeatureCollection, GeometryObject } from 'geojson';
import type L from 'leaflet';

/**
 * lib/overpass.ts — build Overpass QL queries and fetch OSM building
 * footprints for a map viewport, converting the raw response to GeoJSON.
 *
 * Pure network/conversion module: no Leaflet rendering, no React. Mirrors the
 * separation used by `lib/geo.ts` (framework-agnostic, unit-testable in Node).
 */

/**
 * Public Overpass API endpoints, tried in order. The public instances are
 * heavily shared and frequently return transient overload responses (HTTP
 * 429/502/503/504) or simply time out; when that happens `fetchBuildingsInBounds`
 * fails over to the next mirror instead of surfacing an error to the user.
 */
export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
] as const;

/** The primary Overpass API endpoint (first entry of `OVERPASS_ENDPOINTS`). */
export const OVERPASS_ENDPOINT = OVERPASS_ENDPOINTS[0];

/**
 * Per-attempt client-side timeout (ms). Slightly longer than the `timeout:`
 * value embedded in the query so a responsive server can finish, but short
 * enough that a hung/overloaded mirror is abandoned and the next one is tried.
 */
const ATTEMPT_TIMEOUT_MS = 30_000;

/** HTTP statuses that indicate a transient server problem worth retrying on the next mirror. */
const TRANSIENT_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);

/**
 * Below this Leaflet zoom level, the current viewport's bounding box is too
 * large for an Overpass building query to reliably succeed (the query would
 * likely time out or return an excessively large payload). Callers should
 * ask the user to zoom in further instead of firing a query at this level.
 */
export const MIN_BUILDINGS_ZOOM = 15;

/** The three ways a building fetch can fail, so callers can distinguish them. */
export type OverpassErrorKind = 'network' | 'http' | 'parse';

/**
 * A typed error thrown by `fetchBuildingsInBounds` so callers never have to
 * guess whether a failure was a network problem, a non-2xx HTTP response, or
 * a malformed response body. Request cancellation (`AbortSignal`) is NOT
 * wrapped in this type — it rejects with the platform's own abort error so
 * callers can distinguish "cancelled" from "failed".
 */
export class OverpassError extends Error {
  readonly kind: OverpassErrorKind;
  readonly status?: number;

  constructor(kind: OverpassErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'OverpassError';
    this.kind = kind;
    this.status = status;
  }
}

/**
 * Build the Overpass QL query string for every building footprint (ways and
 * closed relations) within `bounds`.
 *
 * The bbox is embedded as `south,west,north,east` — Overpass QL's required
 * order — into BOTH a `way["building"]` clause and a `relation["building"]`
 * clause, so multi-polygon building footprints (common for large/merged
 * buildings modeled as relations) are included alongside simple ways.
 *
 * Does not mutate `bounds`.
 */
export function buildOverpassQuery(bounds: L.LatLngBounds): string {
  const south = bounds.getSouth();
  const rawWest = bounds.getWest();
  const north = bounds.getNorth();
  const rawEast = bounds.getEast();

  // Leaflet allows the map to wrap horizontally, so a viewport may report
  // longitudes outside OSM's accepted -180..180 range (for example 181°).
  // Normalize that viewport and split it at the antimeridian when necessary;
  // sending an out-of-range bbox makes Overpass reject the query with HTTP 400.
  const width = Math.min(360, Math.max(0, rawEast - rawWest));
  const isAlreadyValid =
    rawWest >= -180 && rawWest < 180 && rawEast > rawWest && rawEast <= 180;
  const west =
    rawWest >= -180 && rawWest < 180
      ? rawWest
      : ((rawWest + 180) % 360 + 360) % 360 - 180;
  const east = west + width;
  const bboxes =
    isAlreadyValid
      ? [`${south},${rawWest},${north},${rawEast}`]
      : width >= 360
        ? [`${south},-180,${north},180`]
        : east <= 180
          ? [`${south},${west},${north},${east}`]
          : [
              `${south},${west},${north},180`,
              `${south},-180,${north},${east - 360}`,
            ];
  const clauses = bboxes
    .flatMap((bbox) => [`way["building"](${bbox});`, `relation["building"](${bbox});`])
    .join('');

  // `out geom;` returns each way/relation with its coordinates inline, so we
  // avoid the expensive recursive node resolution (`>;out skel qt;`) that made
  // the query time out on the overloaded public mirrors. `osmtogeojson` reads
  // this inline geometry directly.
  return `[out:json][timeout:25];(${clauses});out geom;`;
}

/**
 * True when `err` is the platform's `AbortError` raised by a cancelled
 * `fetch`. NOTE: `DOMException` (what browsers/jsdom/undici throw for an
 * aborted fetch) is NOT an instance of `Error`, so this checks the `name`/
 * `code` fields directly rather than gating on `instanceof Error`.
 */
function isAbortError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const candidate = err as { name?: unknown; code?: unknown };
  return candidate.name === 'AbortError' || candidate.code === 20;
}

/**
 * Fetch every `way["building"]` / closed `relation["building"]` inside
 * `bounds` from the Overpass API and convert the result to a GeoJSON
 * `FeatureCollection` using `osmtogeojson`.
 *
 * - Resolves to a `FeatureCollection` (possibly with zero features — an empty
 *   result is not an error).
 * - Rejects with a typed `OverpassError` on a network failure (`kind:
 *   'network'`), a non-2xx HTTP response (`kind: 'http'`, with `status` set),
 *   or a response body that cannot be parsed as JSON (`kind: 'parse'`).
 * - If `options.signal` is aborted, rejects with the platform's own abort
 *   error (NOT an `OverpassError`), so callers can tell "cancelled" apart
 *   from "failed".
 * - Never mutates `bounds`.
 */
export async function fetchBuildingsInBounds(
  bounds: L.LatLngBounds,
  options?: { signal?: AbortSignal },
): Promise<FeatureCollection> {
  const query = buildOverpassQuery(bounds);
  const body = `data=${encodeURIComponent(query)}`;

  // Track the last transient failure so that if EVERY mirror fails we can
  // surface a representative error rather than a generic one.
  let lastError: OverpassError | undefined;

  for (let i = 0; i < OVERPASS_ENDPOINTS.length; i++) {
    const endpoint = OVERPASS_ENDPOINTS[i];
    const isLastEndpoint = i === OVERPASS_ENDPOINTS.length - 1;

    try {
      const osmJson = await fetchFromEndpoint(endpoint, body, options?.signal);
      // osmtogeojson converts OSM elements[] (ways/relations with inline
      // geometry from `out geom;`) into a GeoJSON FeatureCollection.
      return osmtogeojson(osmJson) as FeatureCollection<GeometryObject>;
    } catch (err) {
      // A caller-initiated cancellation must propagate immediately and must
      // never fall through to the next mirror.
      if (isAbortError(err)) {
        throw err;
      }

      const overpassError =
        err instanceof OverpassError
          ? err
          : new OverpassError(
              'network',
              `Failed to reach the Overpass API: ${err instanceof Error ? err.message : String(err)}`,
            );

      // Parse errors and non-transient HTTP errors are not helped by trying
      // another mirror, so fail fast. Transient/network errors fall over to
      // the next endpoint.
      const isTransient =
        overpassError.kind === 'network' ||
        (overpassError.kind === 'http' &&
          overpassError.status !== undefined &&
          TRANSIENT_HTTP_STATUSES.has(overpassError.status));

      if (!isTransient || isLastEndpoint) {
        throw overpassError;
      }

      lastError = overpassError;
      // Try the next mirror.
    }
  }

  // Unreachable in practice (the loop either returns or throws), but keeps the
  // type checker satisfied and guards against an empty endpoint list.
  throw (
    lastError ??
    new OverpassError('network', 'Failed to reach any Overpass API endpoint')
  );
}

/**
 * Run a single Overpass request against one endpoint, applying a per-attempt
 * client-side timeout on top of any caller-supplied abort signal. Resolves to
 * the parsed OSM JSON, or throws an `OverpassError` (`http`/`parse`/`network`)
 * — except caller-initiated cancellation, which propagates as the platform's
 * own abort error so `fetchBuildingsInBounds` can distinguish it.
 */
async function fetchFromEndpoint(
  endpoint: string,
  body: string,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), ATTEMPT_TIMEOUT_MS);

  // Abort this attempt if the caller cancels, forwarding their signal to the
  // per-attempt controller.
  const onCallerAbort = () => timeoutController.abort();
  signal?.addEventListener('abort', onCallerAbort);

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: timeoutController.signal,
    });
  } catch (err) {
    // If the CALLER aborted, propagate a real abort error so the outer loop
    // stops. If only our per-attempt timeout fired, treat it as a transient
    // network failure so the outer loop can try the next mirror.
    if (signal?.aborted) {
      throw err;
    }
    throw new OverpassError(
      'network',
      `Failed to reach the Overpass API: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', onCallerAbort);
  }

  if (!response.ok) {
    throw new OverpassError(
      'http',
      `Overpass API responded with HTTP ${response.status}`,
      response.status,
    );
  }

  try {
    return await response.json();
  } catch (err) {
    if (isAbortError(err)) {
      throw err;
    }
    throw new OverpassError('parse', 'Overpass API response was not valid JSON');
  }
}
