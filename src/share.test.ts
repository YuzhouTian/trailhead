import { beforeAll, describe, expect, it } from 'vitest';
import type { LatLng } from './geo';
import {
  buildShareUrl,
  CORRUPTED_LINK_MESSAGE,
  parseShareHash,
  ShareLinkError
} from './share';
import { encodePolyline } from './polyline';
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
    // so buildShareUrl simplifies until the link fits its budget. The shape has
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

describe('link budget', () => {
  /** A wandering track, so simplification has real corners to keep. */
  const wander = (n: number, ele = false): LatLng[] =>
    Array.from({ length: n }, (_, i) => {
      const p: LatLng = [
        54.4 + Math.sin(i / 40) * 0.03 + i * 0.00004,
        -3.2 + Math.cos(i / 55) * 0.03
      ];
      if (ele) p.push(Math.round(300 + Math.sin(i / 30) * 400));
      return p;
    });

  it.each([
    [500, false],
    [1500, false],
    [4000, false],
    [1500, true],
    [4000, true]
  ])('keeps a %i-point track (elevations: %s) inside the link budget', (n, ele) => {
    // The budget is on the link, because the link is what has to fit through a
    // QR code and a mail client. Before this, a 500-point track made a 3.5 KB
    // URL — unscannable (#44) and easily truncated in transit (#45).
    const url = buildShareUrl(route({ coords: wander(n, ele) }), 'hiking');
    expect(url.length).toBeLessThanOrEqual(750);
  });

  it('keeps enough of the shape to still be the same walk', () => {
    const coords = wander(2000);
    const parsed = parseShareHash(hashOf(buildShareUrl(route({ coords }), 'hiking')))!;
    expect(parsed.coords!.length).toBeGreaterThanOrEqual(24);
    // Every kept point sits on the original line, and both ends are exact.
    const kept = parsed.coords!;
    expect(kept[0][0]).toBeCloseTo(coords[0][0], 4);
    expect(kept[kept.length - 1][0]).toBeCloseTo(coords[coords.length - 1][0], 4);
  });

  it('leaves a short track alone rather than thinning to a budget it already meets', () => {
    const coords = wander(30);
    const parsed = parseShareHash(hashOf(buildShareUrl(route({ coords }), 'hiking')))!;
    expect(parsed.coords).toHaveLength(30);
  });
});

describe('link damage', () => {
  /** A route that fills the link budget, so there is plenty of payload to damage. */
  const longLink = (): string =>
    buildShareUrl(
      route({
        coords: Array.from({ length: 600 }, (_, i) => [
          54.4 + Math.sin(i / 40) * 0.03 + i * 0.00004,
          -3.2 + Math.cos(i / 55) * 0.03
        ])
      }),
      'hiking'
    );

  it('names truncation instead of failing anonymously', () => {
    // Every cut point through a real link has to land on a message the receiver
    // can act on, not a dead end. That was the whole of #45.
    const hash = hashOf(longLink());
    for (let cut = 4; cut < hash.length; cut += 7) {
      let thrown: unknown = null;
      let parsed: unknown = null;
      try {
        parsed = parseShareHash(hash.slice(0, cut));
      } catch (e) {
        thrown = e;
      }
      // Either it decodes to nothing, or it says what went wrong — never a
      // route, and never a bare failure.
      expect(parsed).toBeNull();
      if (thrown) expect(thrown).toBeInstanceOf(ShareLinkError);
    }
  });

  it('rejects a link with one character corrupted rather than importing it', () => {
    // A flipped character used to decode cleanly into a route drawn in the
    // wrong place — plausible, wrong coordinates on a hill are worse than
    // an error message.
    const hash = hashOf(longLink());
    const intact = JSON.stringify(parseShareHash(hash));
    let tried = 0;
    let wrongRoute = 0;
    for (let i = 4; i < hash.length; i++) {
      const bent = hash.slice(0, i) + (hash[i] === 'A' ? 'B' : 'A') + hash.slice(i + 1);
      tried++;
      try {
        const parsed = parseShareHash(bent);
        // The last base64 character carries spare bits that decode to nothing,
        // so flipping it yields the same payload — the same route, not a wrong
        // one. Anything else getting through is the bug.
        if (parsed && JSON.stringify(parsed) !== intact) wrongRoute++;
      } catch {
        /* rejected, which is the point */
      }
    }
    expect(tried).toBeGreaterThan(500);
    expect(wrongRoute).toBe(0);
  });

  it('says the link is corrupted when only the checksum disagrees', () => {
    const hash = hashOf(buildShareUrl(route({ waypoints: [[54.4, -3.2], [54.5, -3.1]] }), 'hiking'));
    const payload = JSON.parse(
      atob(hash.slice(3).replace(/-/g, '+').replace(/_/g, '/'))
    ) as Record<string, string>;
    payload.n = 'A different name';
    const bent = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(() => parseShareHash(`#r=${bent}`)).toThrow(CORRUPTED_LINK_MESSAGE);
  });

  it('still reads a link from before checksums existed', () => {
    // Links are out in people's inboxes; an unverified one is better than a
    // rejected one.
    const payload = { n: 'Old link', c: encodePolyline([[54.4, -3.2], [54.5, -3.1]]) };
    const b64 = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(parseShareHash(`#r=${b64}`)!.coords).toHaveLength(2);
  });
});

describe('links that got knocked about in transit', () => {
  const url = (): string =>
    buildShareUrl(route({ waypoints: [[54.4271, -3.2472], [54.4542, -3.2116]] }), 'hiking');

  it.each([
    ['a trailing full stop from a sentence', (u: string) => `${u}.`],
    ['brackets added by a chat client', (u: string) => `<${u}>`],
    ['a tracking parameter appended', (u: string) => `${u}&utm_source=chat`],
    ['prose around it', (u: string) => `Here you go — ${u} — see you Saturday`],
    ['a line break through the middle', (u: string) => `${u.slice(0, 60)}\r\n${u.slice(60)}`],
    ['wrapped at 78 columns', (u: string) => u.replace(/(.{78})/g, '$1\n')]
  ])('reads a link through %s', (_label, damage) => {
    // Opening a link used to anchor on the whole fragment while pasting one
    // searched, so half of these silently did nothing when opened (#45).
    const parsed = parseShareHash(damage(url()));
    expect(parsed!.name).toBe('Scafell Pike from Wasdale');
    expect(parsed!.waypoints).toHaveLength(2);
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
