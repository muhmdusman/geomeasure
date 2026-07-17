// @vitest-environment jsdom
//
// Leaflet touches `window` even when just constructing an `L.LatLngBounds`
// (it runs browser-feature detection at module load), so this Node-environment
// module's tests are pinned to jsdom via the directive above.
import { describe, it, expect, vi, afterEach } from 'vitest';
import L from 'leaflet';
import { fetchBuildingsInBounds, OverpassError, OVERPASS_ENDPOINTS } from '@/lib/overpass';

const bounds = L.latLngBounds([37.83, -122.48], [37.84, -122.47]);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchBuildingsInBounds — mirror failover', () => {
  it('falls over to the next endpoint on a transient HTTP error and succeeds', async () => {
    const okBody = JSON.stringify({ elements: [] });
    const fetchMock = vi
      .fn()
      // First mirror: transient 504 -> should trigger failover.
      .mockResolvedValueOnce(new Response('Gateway Timeout', { status: 504 }))
      // Second mirror: succeeds.
      .mockResolvedValueOnce(new Response(okBody, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchBuildingsInBounds(bounds);

    expect(result.type).toBe('FeatureCollection');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(OVERPASS_ENDPOINTS[0]);
    expect(fetchMock.mock.calls[1][0]).toBe(OVERPASS_ENDPOINTS[1]);
  });

  it('rejects with the last transient error only after every mirror fails', async () => {
    const fetchMock = vi.fn(async () => new Response('Bad Gateway', { status: 502 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchBuildingsInBounds(bounds)).rejects.toMatchObject({
      kind: 'http',
      status: 502,
    });
    expect(fetchMock).toHaveBeenCalledTimes(OVERPASS_ENDPOINTS.length);
  });

  it('does NOT fail over on a non-transient HTTP error (e.g. 400)', async () => {
    const fetchMock = vi.fn(async () => new Response('Bad Request', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchBuildingsInBounds(bounds)).rejects.toMatchObject({
      kind: 'http',
      status: 400,
    });
    // Only the first endpoint is tried — a 400 won't be fixed by another mirror.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('fetchBuildingsInBounds — error paths', () => {
  it('rejects with an OverpassError(kind: "network") when fetch throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    await expect(fetchBuildingsInBounds(bounds)).rejects.toMatchObject({
      kind: 'network',
    });
    await expect(fetchBuildingsInBounds(bounds)).rejects.toBeInstanceOf(OverpassError);
  });

  it('rejects with an OverpassError(kind: "http", status) on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('Gateway Timeout', {
            status: 504,
            statusText: 'Gateway Timeout',
          }),
      ),
    );

    await expect(fetchBuildingsInBounds(bounds)).rejects.toMatchObject({
      kind: 'http',
      status: 504,
    });
  });

  it('rejects with an OverpassError(kind: "parse") when the body is not valid JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not json{{{', { status: 200 })),
    );

    await expect(fetchBuildingsInBounds(bounds)).rejects.toMatchObject({
      kind: 'parse',
    });
  });

  it('rejects with the platform AbortError (not an OverpassError) when the signal is aborted', async () => {
    const controller = new AbortController();

    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new DOMException('The operation was aborted.', 'AbortError');
            reject(err);
          });
        });
      }),
    );

    const promise = fetchBuildingsInBounds(bounds, { signal: controller.signal });
    controller.abort();

    await expect(promise).rejects.not.toBeInstanceOf(OverpassError);
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('fetchBuildingsInBounds — successful conversion', () => {
  it('resolves to a FeatureCollection carrying the expected building tags', async () => {
    // A minimal Overpass response: one way (a closed 4-node square tagged
    // building=house) and its referenced nodes, matching the shape produced
    // by `out body;>;out skel qt;`.
    const overpassFixture = {
      version: 0.6,
      generator: 'test-fixture',
      elements: [
        { type: 'node', id: 1, lat: 37.83, lon: -122.48 },
        { type: 'node', id: 2, lat: 37.83, lon: -122.47 },
        { type: 'node', id: 3, lat: 37.84, lon: -122.47 },
        { type: 'node', id: 4, lat: 37.84, lon: -122.48 },
        {
          type: 'way',
          id: 100,
          nodes: [1, 2, 3, 4, 1],
          tags: { building: 'house' },
        },
      ],
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(overpassFixture), { status: 200 })),
    );

    const result = await fetchBuildingsInBounds(bounds);

    expect(result.type).toBe('FeatureCollection');
    expect(result.features.length).toBeGreaterThan(0);
    const withBuildingTag = result.features.filter(
      (f) => (f.properties as Record<string, unknown> | null)?.building === 'house',
    );
    expect(withBuildingTag.length).toBeGreaterThan(0);
  });

  it('resolves to an empty FeatureCollection when Overpass returns no elements', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ elements: [] }), { status: 200 })),
    );

    const result = await fetchBuildingsInBounds(bounds);

    expect(result.type).toBe('FeatureCollection');
    expect(result.features).toEqual([]);
  });
});
