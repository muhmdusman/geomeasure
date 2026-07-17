import { describe, it, expect, vi, afterEach } from 'vitest';
import { geocodeAddress, GeocodeError } from '@/lib/geocode';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A minimal Nominatim result matching the fields geocodeAddress consumes. */
const lahoreFixture = [
  {
    place_id: 245628830,
    display_name: 'Lahore, Punjab, Pakistan',
    lat: '31.5656822',
    lon: '74.3141829',
    boundingbox: ['31.4056822', '31.7256822', '74.1541829', '74.4741829'],
  },
];

describe('geocodeAddress — happy path', () => {
  it('normalizes Nominatim results into GeocodeResult objects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(lahoreFixture), { status: 200 })),
    );

    const results = await geocodeAddress('Lahore');

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      placeId: 245628830,
      displayName: 'Lahore, Punjab, Pakistan',
      lat: 31.5656822,
      lon: 74.3141829,
      boundingBox: [31.4056822, 31.7256822, 74.1541829, 74.4741829],
    });
  });

  it('encodes the query and requested limit into the request URL', async () => {
    const fetchMock = vi.fn(async () => new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await geocodeAddress('Gulberg, Lahore', { limit: 3 });

    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toContain('q=Gulberg%2C+Lahore');
    expect(calledUrl).toContain('limit=3');
  });
});

describe('geocodeAddress — short-circuits and empties', () => {
  it('returns [] for a blank query without making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await geocodeAddress('   ')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns [] when Nominatim yields no matches', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })));
    expect(await geocodeAddress('asdkjhaskdjh')).toEqual([]);
  });

  it('drops results missing coordinates', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify([{ display_name: 'no coords' }]), { status: 200 }),
      ),
    );
    expect(await geocodeAddress('somewhere')).toEqual([]);
  });
});

describe('geocodeAddress — error paths', () => {
  it('rejects with GeocodeError(kind: "network") when fetch throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    await expect(geocodeAddress('Lahore')).rejects.toBeInstanceOf(GeocodeError);
    await expect(geocodeAddress('Lahore')).rejects.toMatchObject({ kind: 'network' });
  });

  it('rejects with GeocodeError(kind: "http", status) on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Too Many Requests', { status: 429 })),
    );

    await expect(geocodeAddress('Lahore')).rejects.toMatchObject({
      kind: 'http',
      status: 429,
    });
  });

  it('rejects with GeocodeError(kind: "parse") on an unparseable body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not json{{{', { status: 200 })),
    );

    await expect(geocodeAddress('Lahore')).rejects.toMatchObject({ kind: 'parse' });
  });

  it('propagates the platform AbortError (not a GeocodeError) when aborted', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
          }),
      ),
    );

    const promise = geocodeAddress('Lahore', { signal: controller.signal });
    controller.abort();

    await expect(promise).rejects.not.toBeInstanceOf(GeocodeError);
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });
});
