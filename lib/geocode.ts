import type { GeocodeResult } from '@/types/geo';

/**
 * lib/geocode.ts — forward geocoding (address/place text → coordinates) via
 * OpenStreetMap's public Nominatim service.
 *
 * Pure network/conversion module: no Leaflet, no React. Mirrors the separation
 * used by `lib/overpass.ts` (framework-agnostic, unit-testable in Node).
 *
 * Usage policy: Nominatim's public instance asks callers to send an identifying
 * `User-Agent`/`Referer`, cap requests to at most one per second, and avoid
 * bulk/autocomplete-on-every-keystroke traffic. The search bar therefore
 * debounces input before calling this, and requests are cancellable via an
 * abort signal so superseded lookups don't pile up.
 * See https://operations.osmfoundation.org/policies/nominatim/.
 */

/** The public Nominatim search endpoint. */
export const NOMINATIM_ENDPOINT = 'https://nominatim.openstreetmap.org/search';

/** How the different failure modes are surfaced to callers. */
export type GeocodeErrorKind = 'network' | 'http' | 'parse';

/**
 * A typed error thrown by `geocodeAddress` so callers can distinguish a
 * connectivity problem, a non-2xx response, and an unparseable body. Request
 * cancellation (`AbortSignal`) is NOT wrapped — it rejects with the platform's
 * own abort error so callers can tell "cancelled" apart from "failed".
 */
export class GeocodeError extends Error {
  readonly kind: GeocodeErrorKind;
  readonly status?: number;

  constructor(kind: GeocodeErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'GeocodeError';
    this.kind = kind;
    this.status = status;
  }
}

/** The raw shape of a single Nominatim result (only the fields we consume). */
interface RawNominatimResult {
  place_id?: number;
  display_name?: string;
  lat?: string;
  lon?: string;
  /** Nominatim returns `[south, north, west, east]` as strings. */
  boundingbox?: [string, string, string, string];
}

/** True when `err` is the platform's `AbortError` raised by a cancelled fetch. */
function isAbortError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const candidate = err as { name?: unknown; code?: unknown };
  return candidate.name === 'AbortError' || candidate.code === 20;
}

/** Parse a numeric string, returning `undefined` when it is not finite. */
function toFiniteNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Convert one raw Nominatim entry into a `GeocodeResult`, or `null` when it
 * lacks the coordinates we require.
 */
function normalizeResult(raw: RawNominatimResult): GeocodeResult | null {
  const lat = toFiniteNumber(raw.lat);
  const lon = toFiniteNumber(raw.lon);
  if (lat === undefined || lon === undefined) return null;

  let boundingBox: GeocodeResult['boundingBox'];
  if (raw.boundingbox && raw.boundingbox.length === 4) {
    const [south, north, west, east] = raw.boundingbox.map((v) => Number(v));
    if ([south, north, west, east].every((v) => Number.isFinite(v))) {
      boundingBox = [south, north, west, east];
    }
  }

  return {
    placeId: raw.place_id ?? lat * 1e7 + lon,
    displayName: raw.display_name ?? `${lat}, ${lon}`,
    lat,
    lon,
    boundingBox,
  };
}

/**
 * Forward-geocode a free-form address/place query into a list of matches.
 *
 * - Resolves to a (possibly empty) array of `GeocodeResult`. An empty result
 *   is NOT an error — it just means Nominatim found no matches.
 * - A blank/whitespace-only query short-circuits to `[]` without a request.
 * - Rejects with a typed `GeocodeError` on network failure (`network`), a
 *   non-2xx response (`http`, with `status`), or an unparseable body (`parse`).
 * - If `options.signal` is aborted, rejects with the platform's own abort
 *   error (NOT a `GeocodeError`).
 * - Never performs any side effects beyond the network request.
 */
export async function geocodeAddress(
  query: string,
  options?: { signal?: AbortSignal; limit?: number },
): Promise<GeocodeResult[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  const params = new URLSearchParams({
    q: trimmed,
    format: 'jsonv2',
    addressdetails: '0',
    limit: String(options?.limit ?? 5),
  });
  const url = `${NOMINATIM_ENDPOINT}?${params.toString()}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        // Identify the app per Nominatim usage policy.
        'Accept-Language': 'en',
      },
      signal: options?.signal,
    });
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new GeocodeError(
      'network',
      `Failed to reach the geocoding service: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!response.ok) {
    throw new GeocodeError(
      'http',
      `Geocoding service responded with HTTP ${response.status}`,
      response.status,
    );
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new GeocodeError('parse', 'Geocoding response was not valid JSON');
  }

  if (!Array.isArray(json)) return [];

  return (json as RawNominatimResult[])
    .map(normalizeResult)
    .filter((r): r is GeocodeResult => r !== null);
}
