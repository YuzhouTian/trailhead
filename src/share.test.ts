import { beforeAll, describe, expect, it } from 'vitest';
import type { LatLng } from './geo';
import { buildShareUrl, parseShareHash } from './share';
import type { SavedRoute } from './state';

// `buildShareUrl` builds an absolute URL, so it needs somewhere to be. Two
// fields is the whole of its dependency on the browser — cheaper than pulling
// jsdom in for one property.
beforeAll(() => {
  Object.defineProperty(globalThis, 'location', {
    value: { origin: 'https://yuzhoutian.github.io', pathname: '/trailhead/' },
    configurable: true
  });
});

const route = (over: Partial<SavedRoute> = {}): SavedRoute => ({
  id: '1',
  name: 'Scafell Pike from Wasdale',
  waypoints: null,
  coords: [
    [54.4271, -3.2472],
    [54.4542, -3.2116]
  ],
  distanceM: 4200,
  ascentM: 900,
  descentM: 900,
  createdAt: 0,
  ...over
});

/** The fragment on its own, which is what `parseShareHash` is given. */
const hashOf = (url: string): string => url.slice(url.indexOf('#'));

describe('buildShareUrl', () => {
  it('hangs the payload off the current page as a fragment', () => {
    const url = buildShareUrl(route(), 'hiking-mountain');
    expect(url.startsWith('https://yuzhoutian.github.io/trailhead/#r=')).toBe(true);
  });

  it('encodes with the URL-safe base64 alphabet and no padding', () => {
    // The link goes in a QR code and in a URL fragment, so '+', '/' and '='
    // all have to stay out of it.
    const url = buildShareUrl(route({ name: 'A route with a longer name ???' }), 'hiking');
    expect(hashOf(url)).toMatch(/^#r=[A-Za-z0-9_-]+$/);
  });
});

describe('round trip', () => {
  it('carries a waypoint route, its profile and its name', () => {
    const waypoints: LatLng[] = [
      [54.4271, -3.2472],
      [54.44, -3.23],
      [54.4542, -3.2116]
    ];
    const parsed = parseShareHash(hashOf(buildShareUrl(route({ waypoints }), 'hiking-mountain')))!;
    expect(parsed.name).toBe('Scafell Pike from Wasdale');
    expect(parsed.profile).toBe('hiking-mountain');
    expect(parsed.coords).toBeUndefined();
    parsed.waypoints!.forEach((p, i) => {
      expect(p[0]).toBeCloseTo(waypoints[i][0], 5);
      expect(p[1]).toBeCloseTo(waypoints[i][1], 5);
    });
  });

  it('carries per-leg snap flags when some legs are freeform', () => {
    const waypoints: LatLng[] = [
      [54.4271, -3.2472],
      [54.44, -3.23],
      [54.4542, -3.2116]
    ];
    const parsed = parseShareHash(
      hashOf(buildShareUrl(route({ waypoints, snaps: [true, false, true] }), 'hiking'))
    )!;
    expect(parsed.snaps).toEqual([true, false, true]);
  });

  it('leaves the snap flags out when every leg is snapped', () => {
    // The common case, and the flags are pure overhead in a QR code.
    const waypoints: LatLng[] = [
      [54.4271, -3.2472],
      [54.4542, -3.2116]
    ];
    const parsed = parseShareHash(
      hashOf(buildShareUrl(route({ waypoints, snaps: [true, true] }), 'hiking'))
    )!;
    expect(parsed.snaps).toBeUndefined();
  });

  it('carries a raw track when there are no waypoints to re-route from', () => {
    const coords: LatLng[] = [
      [54.4271, -3.2472],
      [54.44, -3.23],
      [54.4542, -3.2116]
    ];
    const parsed = parseShareHash(hashOf(buildShareUrl(route({ coords }), 'hiking')))!;
    expect(parsed.waypoints).toBeUndefined();
    expect(parsed.coords).toHaveLength(3);
    parsed.coords!.forEach((p, i) => {
      expect(p[0]).toBeCloseTo(coords[i][0], 5);
      expect(p[1]).toBeCloseTo(coords[i][1], 5);
    });
  });

  it('carries elevations alongside a raw track', () => {
    const coords: LatLng[] = [
      [54.4271, -3.2472, 76],
      [54.44, -3.23, 500],
      [54.4542, -3.2116, 978]
    ];
    const parsed = parseShareHash(hashOf(buildShareUrl(route({ coords }), 'hiking')))!;
    // Elevations ride in a precision-0 channel, so they come back as whole
    // metres — which is all the elevation API gives in the first place.
    expect(parsed.coords!.map((p) => p[2])).toEqual([76, 500, 978]);
  });

  it('treats a single waypoint as a track, since one point is nothing to route', () => {
    const parsed = parseShareHash(
      hashOf(buildShareUrl(route({ waypoints: [[54.4271, -3.2472]] }), 'hiking'))
    )!;
    expect(parsed.waypoints).toBeUndefined();
    expect(parsed.coords).toBeDefined();
  });

  it('survives a name with non-ASCII characters', () => {
    // The payload goes through UTF-8 before base64; a naive `btoa` would throw
    // on these, and a naive decode would mangle them.
    const name = 'Yr Wyddfa – Llwybr Llanberis ☕ 20 °C';
    const parsed = parseShareHash(hashOf(buildShareUrl(route({ name }), 'hiking')))!;
    expect(parsed.name).toBe(name);
  });

  it('falls back to a placeholder for an empty name', () => {
    const parsed = parseShareHash(hashOf(buildShareUrl(route({ name: '' }), 'hiking')))!;
    expect(parsed.name).toBe('Shared route');
  });

  it('thins a dense track so the link stays scannable', () => {
    // 3,000 GPS points is a normal day's track and far too much for a QR code,
    // so buildShareUrl simplifies until it is under 500 points. The shape has
    // to survive: this one is a long arc, not a straight line.
    const coords: LatLng[] = Array.from({ length: 3000 }, (_, i) => [
      54.4 + Math.sin(i / 500) * 0.05,
      -3.2 + i * 0.00002
    ]);
    const parsed = parseShareHash(hashOf(buildShareUrl(route({ coords }), 'hiking')))!;
    expect(parsed.coords!.length).toBeLessThanOrEqual(500);
    expect(parsed.coords!.length).toBeGreaterThan(2);
    // Endpoints are never dropped, so the route still starts and ends where it did.
    const thinned = parsed.coords!;
    expect(thinned[0][0]).toBeCloseTo(coords[0][0], 4);
    expect(thinned[thinned.length - 1][0]).toBeCloseTo(coords[coords.length - 1][0], 4);
  });
});

describe('parseShareHash', () => {
  it.each([
    ['', 'an empty string'],
    ['#', 'a bare hash'],
    ['#r=', 'a hash with no payload'],
    ['#x=eyJuIjoieCJ9', 'the wrong fragment key'],
    ['eyJuIjoieCJ9', 'no fragment at all'],
    ['#r=eyJuIjoieCJ9&other=1', 'trailing junk'],
    ['#r=!!!not-base64!!!', 'characters outside the base64 alphabet']
  ])('returns null for %j (%s)', (hash) => {
    expect(parseShareHash(hash)).toBeNull();
  });

  it('returns null for a well-formed payload with no route in it', () => {
    const b64 = btoa(JSON.stringify({ n: 'Nameless' })).replace(/=+$/, '');
    expect(parseShareHash(`#r=${b64}`)).toBeNull();
  });

  it('rejects a corrupted payload rather than importing nonsense', () => {
    // A truncated or mistyped link decodes to bytes that are not JSON. What
    // matters is that no route comes out of it; parseShareHash signals this by
    // throwing, and both callers in features/sharing.ts catch and show a toast.
    for (const hash of ['#r=zzzz', '#r=aGVsbG8', '#r=' + btoa('not json').replace(/=+$/, '')]) {
      expect(() => parseShareHash(hash)).toThrow();
    }
  });

  it('rejects a link truncated part way through a real payload', () => {
    const url = buildShareUrl(route({ waypoints: [[54.4271, -3.2472], [54.4542, -3.2116]] }), 'x');
    const truncated = hashOf(url).slice(0, -8);
    // Either answer is safe — what must not happen is a route appearing.
    let parsed: unknown = null;
    try {
      parsed = parseShareHash(truncated);
    } catch {
      parsed = null;
    }
    expect(parsed).toBeNull();
  });
});
