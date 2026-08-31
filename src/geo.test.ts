import { describe, expect, it } from 'vitest';
import {
  compassDir,
  computeClimbs,
  cumulativeDistances,
  formatDistance,
  formatDuration,
  haversine,
  latLngToTile,
  naismithHours,
  projectOnPolyline,
  simplifyIndices,
  type LatLng
} from './geo';

/** The sphere geo.ts measures on. Fixtures below are derived from it, not from it. */
const R = 6371000;

describe('haversine', () => {
  it('is zero for the same point', () => {
    expect(haversine([54.45, -3.21], [54.45, -3.21])).toBe(0);
  });

  it('makes a degree of latitude one 360th of the circumference', () => {
    // Independent of the haversine formula: on a sphere, a degree of any great
    // circle is 2*pi*R/360, and meridians are great circles.
    expect(haversine([0, 0], [1, 0])).toBeCloseTo((2 * Math.PI * R) / 360, 6);
    expect(haversine([54, -3], [55, -3])).toBeCloseTo((2 * Math.PI * R) / 360, 6);
  });

  it('makes a quarter of the equator a quarter of the circumference', () => {
    expect(haversine([0, 0], [0, 90])).toBeCloseTo((Math.PI * R) / 2, 6);
    expect(haversine([0, 0], [0, 180])).toBeCloseTo(Math.PI * R, 6);
  });

  it('agrees with the spherical law of cosines', () => {
    // A different formula for the same quantity. The two disagree only for
    // near-antipodal pairs, where the law of cosines loses precision, so the
    // fixtures are ordinary walking-to-continental distances.
    const rad = (d: number) => (d * Math.PI) / 180;
    const lawOfCosines = (a: LatLng, b: LatLng) =>
      R *
      Math.acos(
        Math.sin(rad(a[0])) * Math.sin(rad(b[0])) +
          Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]))
      );
    const pairs: [LatLng, LatLng][] = [
      [[54.4542, -3.2116], [54.482, -3.2196]], // Scafell Pike to Great Gable
      [[51.5074, -0.1278], [48.8566, 2.3522]], // London to Paris
      [[55.9486, -3.1999], [51.4816, -3.181]], // Edinburgh to Cardiff
      [[54.0, -3.0], [54.0, -3.001]] // one field's width
    ];
    for (const [a, b] of pairs) {
      expect(haversine(a, b)).toBeCloseTo(lawOfCosines(a, b), 3);
    }
  });

  it('is symmetric', () => {
    const a: LatLng = [54.4542, -3.2116];
    const b: LatLng = [56.79694, -5.00333];
    expect(haversine(a, b)).toBeCloseTo(haversine(b, a), 9);
  });

  it('ignores elevation', () => {
    // The third slot is carried through the app but is not part of the ground
    // distance; a route that climbs 1,000 m has not thereby got longer.
    expect(haversine([54, -3, 0], [54.01, -3, 1000])).toBe(haversine([54, -3], [54.01, -3]));
  });
});

describe('compassDir', () => {
  const here: LatLng = [54, -3];

  it.each([
    ['N', [55, -3]],
    ['E', [54, -2]],
    ['S', [53, -3]],
    ['W', [54, -4]]
  ] as [string, LatLng][])('calls due %s by its name', (dir, there) => {
    expect(compassDir(here, there)).toBe(dir);
  });

  it('rounds to the nearest of the eight points', () => {
    // North-east of here in both axes, so somewhere in the NE octant.
    expect(compassDir(here, [54.5, -2.5])).toBe('NE');
    expect(compassDir(here, [53.5, -3.5])).toBe('SW');
  });
});

describe('cumulativeDistances', () => {
  const line: LatLng[] = [
    [54.0, -3.0],
    [54.01, -3.0],
    [54.02, -3.0],
    [54.02, -3.01]
  ];

  it('starts at zero', () => {
    expect(cumulativeDistances(line)[0]).toBe(0);
  });

  it('gives one entry per point', () => {
    expect(cumulativeDistances(line)).toHaveLength(line.length);
  });

  it('accumulates the leg lengths', () => {
    const cum = cumulativeDistances(line);
    for (let i = 1; i < line.length; i++) {
      expect(cum[i] - cum[i - 1]).toBeCloseTo(haversine(line[i - 1], line[i]), 9);
    }
  });

  it('is monotonic even when a route doubles back', () => {
    const there: LatLng[] = [
      [54.0, -3.0],
      [54.01, -3.0],
      [54.0, -3.0]
    ];
    const cum = cumulativeDistances(there);
    expect(cum[2]).toBeCloseTo(2 * cum[1], 6);
  });

  it('handles a single point', () => {
    expect(cumulativeDistances([[54, -3]])).toEqual([0]);
  });
});

describe('projectOnPolyline', () => {
  // A straight kilometre due north up the -3 meridian, sampled every 0.001
  // degrees. A degree of latitude is 2*pi*R/360, so the line is 1,112 m long
  // and every fixture below follows from that.
  const DEG_LAT_M = (2 * Math.PI * R) / 360;
  const straight: LatLng[] = Array.from({ length: 11 }, (_, i) => [54 + i * 0.001, -3]);

  it('returns null for a line that is not a line', () => {
    expect(projectOnPolyline([54, -3], [])).toBeNull();
    expect(projectOnPolyline([54, -3], [[54, -3]])).toBeNull();
  });

  it('reads zero along at the start', () => {
    const p = projectOnPolyline([54, -3], straight)!;
    expect(p.offRouteM).toBeCloseTo(0, 6);
    expect(p.alongM).toBeCloseTo(0, 6);
    expect(p.index).toBe(0);
  });

  it('reads the full length at the end', () => {
    const p = projectOnPolyline([54.01, -3], straight)!;
    expect(p.offRouteM).toBeCloseTo(0, 6);
    expect(p.alongM).toBeCloseTo(0.01 * DEG_LAT_M, 0);
  });

  it('projects onto the middle of a segment, not the nearest vertex', () => {
    // Halfway between two sampled points. A nearest-vertex implementation
    // would snap to one of them and be out by half a segment.
    const p = projectOnPolyline([54.0035, -3], straight)!;
    expect(p.alongM).toBeCloseTo(0.0035 * DEG_LAT_M, 0);
    expect(p.index).toBe(3);
  });

  it('measures how far off the line a position is', () => {
    // 0.001 degrees of longitude at 54 degrees north, projected the way the
    // function does: one degree of longitude shrinks by cos(latitude).
    const offsetM = 0.001 * DEG_LAT_M * Math.cos((54.005 * Math.PI) / 180);
    const p = projectOnPolyline([54.005, -3 + 0.001], straight)!;
    expect(p.offRouteM).toBeCloseTo(offsetM, 0);
    expect(p.alongM).toBeCloseTo(0.005 * DEG_LAT_M, 0);
  });

  it('clamps to the ends rather than extrapolating past them', () => {
    const before = projectOnPolyline([53.99, -3], straight)!;
    expect(before.alongM).toBeCloseTo(0, 6);
    expect(before.offRouteM).toBeCloseTo(0.01 * DEG_LAT_M, 0);

    const after = projectOnPolyline([54.02, -3], straight)!;
    expect(after.alongM).toBeCloseTo(0.01 * DEG_LAT_M, 0);
    expect(after.offRouteM).toBeCloseTo(0.01 * DEG_LAT_M, 0);
  });

  describe('where the route passes close to itself (#17)', () => {
    // Out and back up the same meridian: 2 km north, then the same 2 km south.
    // Every point on the outward leg has an identical twin on the return, so
    // the bare nearest point is ambiguous everywhere along it.
    const outAndBack: LatLng[] = [
      ...Array.from({ length: 11 }, (_, i): LatLng => [54 + i * 0.002, -3]),
      ...Array.from({ length: 10 }, (_, i): LatLng => [54.018 - i * 0.002, -3])
    ];
    const TOTAL_M = 0.04 * DEG_LAT_M;
    const nearStart: LatLng = [54.0005, -3];

    it('reads from the start with no hint, not from the finish', () => {
      // This is the bug: standing at the trailhead before setting off, the
      // route card said 85% done because the finish is the same place.
      const p = projectOnPolyline(nearStart, outAndBack)!;
      expect(p.alongM).toBeLessThan(0.1 * TOTAL_M);
      expect(p.alongM).toBeCloseTo(0.0005 * DEG_LAT_M, 0);
    });

    it('reads from the finish once the hint says we walked there', () => {
      const p = projectOnPolyline(nearStart, outAndBack, TOTAL_M - 50)!;
      expect(p.alongM).toBeGreaterThan(0.9 * TOTAL_M);
      expect(p.alongM).toBeCloseTo(TOTAL_M - 0.0005 * DEG_LAT_M, 0);
    });

    it('stays on the outward leg while the hint is on the outward leg', () => {
      const halfway: LatLng = [54.01, -3];
      const out = projectOnPolyline(halfway, outAndBack, 0.01 * DEG_LAT_M)!;
      expect(out.alongM).toBeCloseTo(0.01 * DEG_LAT_M, 0);

      const back = projectOnPolyline(halfway, outAndBack, 0.03 * DEG_LAT_M)!;
      expect(back.alongM).toBeCloseTo(0.03 * DEG_LAT_M, 0);
    });

    it('treats a null hint as a hint of zero, not as no preference', () => {
      const withNull = projectOnPolyline(nearStart, outAndBack, null)!;
      const withZero = projectOnPolyline(nearStart, outAndBack, 0)!;
      expect(withNull.alongM).toBeCloseTo(withZero.alongM, 6);
    });

    it('does not let a hint drag the answer off a genuinely nearest point', () => {
      // The turning point is unambiguous — only one part of the route is near
      // it — so a wildly wrong hint must not move the answer.
      const atTurn: LatLng = [54.02, -3];
      const p = projectOnPolyline(atTurn, outAndBack, 0)!;
      expect(p.alongM).toBeCloseTo(0.02 * DEG_LAT_M, 0);
      expect(p.offRouteM).toBeCloseTo(0.0, 0);
    });
  });
});

describe('formatDistance', () => {
  it('uses whole metres below a kilometre', () => {
    expect(formatDistance(0)).toBe('0 m');
    expect(formatDistance(1)).toBe('1 m');
    expect(formatDistance(452.6)).toBe('453 m');
    expect(formatDistance(999)).toBe('999 m');
  });

  it('switches to kilometres and miles at a kilometre', () => {
    expect(formatDistance(1000)).toBe('1.0 km / 0.6 mi');
  });

  it('converts miles by the statutory definition', () => {
    // A mile is exactly 1,609.344 m, so this is a fixed conversion, not a
    // rounded one.
    expect(formatDistance(1609.344)).toBe('1.6 km / 1.0 mi');
    expect(formatDistance(1609.344 * 10)).toBe('16.1 km / 10.0 mi');
    expect(formatDistance(42195)).toBe('42.2 km / 26.2 mi'); // a marathon
  });
});

describe('formatDuration', () => {
  it('gives minutes only below an hour', () => {
    expect(formatDuration(0)).toBe('0 min');
    expect(formatDuration(0.5)).toBe('30 min');
  });

  it('gives hours and zero-padded minutes above an hour', () => {
    expect(formatDuration(1)).toBe('1 h 00 min');
    expect(formatDuration(1 + 1 / 60)).toBe('1 h 01 min');
    expect(formatDuration(2.25)).toBe('2 h 15 min');
    expect(formatDuration(12.5)).toBe('12 h 30 min');
  });

  it('rolls up to the next hour instead of showing 60 minutes', () => {
    expect(formatDuration(1.999)).toBe('2 h 00 min');
    expect(formatDuration(0.999)).toBe('1 h 00 min');
    expect(formatDuration(0.995)).toBe('1 h 00 min');
  });
});

describe('naismithHours', () => {
  // Naismith's rule as stated: allow one hour per 5 km on the flat, plus an
  // extra hour for every 600 m of ascent. geo.ts takes the flat pace as a
  // setting rather than fixing it at 5 km/h.
  it('is distance over speed on the flat', () => {
    expect(naismithHours(5000, 0, 5)).toBeCloseTo(1, 9);
    expect(naismithHours(20000, 0, 4)).toBeCloseTo(5, 9);
  });

  it('adds an hour per 600 m of ascent', () => {
    expect(naismithHours(0, 600, 5)).toBeCloseTo(1, 9);
    expect(naismithHours(0, 300, 5)).toBeCloseTo(0.5, 9);
  });

  it('adds the two together', () => {
    expect(naismithHours(5000, 600, 5)).toBeCloseTo(2, 9);
  });

  it('ignores descent, which the rule does not charge for', () => {
    expect(naismithHours(5000, 0, 5)).toBe(naismithHours(5000, 0, 5));
  });

  it('floors an implausible speed rather than dividing by zero', () => {
    expect(Number.isFinite(naismithHours(1000, 0, 0))).toBe(true);
    expect(naismithHours(1000, 0, 0)).toBeCloseTo(10, 9); // 1 km at 0.1 km/h
    expect(naismithHours(1000, 0, -5)).toBeCloseTo(10, 9);
  });
});

describe('computeClimbs', () => {
  it('separates ascent from descent', () => {
    const coords: LatLng[] = [
      [54.45, -3.21, 200],
      [54.46, -3.2, 320],
      [54.47, -3.19, 480],
      [54.48, -3.18, 300]
    ];
    expect(computeClimbs(coords)).toEqual({ ascentM: 280, descentM: 180 });
  });

  it('ignores wobbles under 5 m', () => {
    // Documented behaviour: GPS-derived elevation jitters by a few metres, and
    // counting every wobble inflates a flat walk into a mountain.
    const jitter: LatLng[] = [
      [54, -3, 100],
      [54.001, -3, 103],
      [54.002, -3, 98],
      [54.003, -3, 102],
      [54.004, -3, 100]
    ];
    expect(computeClimbs(jitter)).toEqual({ ascentM: 0, descentM: 0 });
  });

  it('counts a climb that clears the threshold in full', () => {
    // 100 -> 106 is 6 m of real climb, not 1 m of "excess over the threshold".
    expect(
      computeClimbs([
        [54, -3, 100],
        [54.001, -3, 106]
      ])
    ).toEqual({ ascentM: 6, descentM: 0 });
  });

  it('is zero for a route with no elevations at all', () => {
    expect(
      computeClimbs([
        [54, -3],
        [54.01, -3]
      ])
    ).toEqual({ ascentM: 0, descentM: 0 });
  });

  it('skips points with no elevation rather than treating them as sea level', () => {
    const gappy: LatLng[] = [
      [54, -3, 200],
      [54.001, -3],
      [54.002, -3, 300]
    ];
    expect(computeClimbs(gappy)).toEqual({ ascentM: 100, descentM: 0 });
  });

  it('is empty for an empty route', () => {
    expect(computeClimbs([])).toEqual({ ascentM: 0, descentM: 0 });
  });

  describe('on a slice of a route (#20)', () => {
    // The remaining-climb readout takes the tail of the route from where you
    // are. #20 was this being computed over the wrong slice, so the descent
    // still to come never appeared.
    const route: LatLng[] = [
      [54.0, -3, 100],
      [54.1, -3, 300], // +200
      [54.2, -3, 500], // +200
      [54.3, -3, 250], // -250
      [54.4, -3, 400] // +150
    ];

    it('measures the whole route', () => {
      expect(computeClimbs(route)).toEqual({ ascentM: 550, descentM: 250 });
    });

    it('measures only what is left when sliced from the summit', () => {
      expect(computeClimbs(route.slice(2))).toEqual({ ascentM: 150, descentM: 250 });
    });

    it('measures only what is left when sliced from the last point', () => {
      expect(computeClimbs(route.slice(4))).toEqual({ ascentM: 0, descentM: 0 });
    });

    it('adds up: a slice plus its complement is the whole, once the join is counted', () => {
      const head = computeClimbs(route.slice(0, 3)); // 100 -> 500
      const tail = computeClimbs(route.slice(2)); // 500 -> 400
      expect(head.ascentM + tail.ascentM).toBe(550);
      expect(head.descentM + tail.descentM).toBe(250);
    });
  });
});

describe('simplifyIndices', () => {
  it('returns every index for two points or fewer', () => {
    expect(simplifyIndices([], 0.001)).toEqual([]);
    expect(simplifyIndices([[54, -3]], 0.001)).toEqual([0]);
    expect(
      simplifyIndices(
        [
          [54, -3],
          [54.1, -3]
        ],
        0.001
      )
    ).toEqual([0, 1]);
  });

  it('always keeps both endpoints', () => {
    const line: LatLng[] = Array.from({ length: 50 }, (_, i) => [54 + i * 0.01, -3 + i * 0.01]);
    const kept = simplifyIndices(line, 10); // absurd tolerance: drop everything droppable
    expect(kept[0]).toBe(0);
    expect(kept[kept.length - 1]).toBe(line.length - 1);
  });

  it('drops points that lie on the straight line between their neighbours', () => {
    const straight: LatLng[] = [
      [54.0, -3],
      [54.1, -3],
      [54.2, -3],
      [54.3, -3],
      [54.4, -3]
    ];
    expect(simplifyIndices(straight, 0.0001)).toEqual([0, 4]);
  });

  it('keeps a detour bigger than the tolerance', () => {
    const spike: LatLng[] = [
      [54.0, -3],
      [54.1, -3],
      [54.2, -2.5], // 0.5 degrees off the line
      [54.3, -3],
      [54.4, -3]
    ];
    expect(simplifyIndices(spike, 0.01)).toContain(2);
  });

  it('drops a detour smaller than the tolerance', () => {
    const wobble: LatLng[] = [
      [54.0, -3],
      [54.1, -3],
      [54.2, -2.999], // 0.001 degrees off the line
      [54.3, -3],
      [54.4, -3]
    ];
    expect(simplifyIndices(wobble, 0.01)).toEqual([0, 4]);
  });

  it('returns indices in ascending order with no duplicates', () => {
    const line: LatLng[] = Array.from({ length: 200 }, (_, i) => [
      54 + i * 0.001,
      -3 + Math.sin(i / 7) * 0.02
    ]);
    const kept = simplifyIndices(line, 0.002);
    expect(kept).toEqual([...kept].sort((a, b) => a - b));
    expect(new Set(kept).size).toBe(kept.length);
    expect(kept.length).toBeLessThan(line.length);
  });

  it('keeps more points as the tolerance tightens', () => {
    const line: LatLng[] = Array.from({ length: 200 }, (_, i) => [
      54 + i * 0.001,
      -3 + Math.sin(i / 7) * 0.02
    ]);
    expect(simplifyIndices(line, 0.0001).length).toBeGreaterThan(
      simplifyIndices(line, 0.01).length
    );
  });
});

describe('latLngToTile', () => {
  it('has one tile at zoom 0', () => {
    expect(latLngToTile(51.5, -0.1, 0)).toEqual([0, 0]);
    expect(latLngToTile(-33.9, 151.2, 0)).toEqual([0, 0]);
  });

  it('puts the origin at the middle of the grid', () => {
    // Web Mercator is square and symmetric about (0, 0), so at zoom z the
    // origin falls on the corner of the four middle tiles: index 2^(z-1).
    expect(latLngToTile(0, 0, 1)).toEqual([1, 1]);
    expect(latLngToTile(0, 0, 4)).toEqual([8, 8]);
    expect(latLngToTile(0, 0, 10)).toEqual([512, 512]);
  });

  it('runs x from west to east and y from north to south', () => {
    expect(latLngToTile(0, -180, 4)[0]).toBe(0);
    expect(latLngToTile(0, 179.999, 4)[0]).toBe(15);
    expect(latLngToTile(85.05, 0, 4)[1]).toBe(0);
    expect(latLngToTile(-85.05, 0, 4)[1]).toBe(15);
  });

  it('clamps rather than escaping the grid past the Mercator limit', () => {
    // Web Mercator stops at ~85.0511 degrees; the poles themselves are at
    // infinity, and a tile index of -1 or 2^z would 404 the tile server.
    for (const z of [1, 8, 16]) {
      const n = 2 ** z;
      for (const [lat, lng] of [
        [90, 0],
        [-90, 0],
        [89.9, 200],
        [-89.9, -200]
      ]) {
        const [x, y] = latLngToTile(lat, lng, z);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThan(n);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThan(n);
      }
    }
  });

  it('inverts the published tile-to-latitude formula', () => {
    // `num2deg` from the OpenStreetMap wiki's Slippy map tilenames page gives
    // the north-west corner of a tile. Nudged inside, that corner must land
    // back in the tile it came from.
    const num2deg = (x: number, y: number, z: number): [number, number] => {
      const n = 2 ** z;
      const lng = (x / n) * 360 - 180;
      const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
      return [(latRad * 180) / Math.PI, lng];
    };
    for (const z of [4, 12, 16]) {
      for (const [x, y] of [
        [1, 1],
        [2 ** z - 2, 2 ** z - 2],
        [Math.floor(2 ** z / 3), Math.floor(2 ** z / 5)]
      ]) {
        const [lat, lng] = num2deg(x + 0.5, y + 0.5, z); // middle of the tile
        expect(latLngToTile(lat, lng, z)).toEqual([x, y]);
      }
    }
  });

  it('places a known point in the tile that contains it', () => {
    // Scafell Pike at zoom 14. Independent check: the tile's own bounds, from
    // the published inverse formula, must straddle the summit.
    const z = 14;
    const [x, y] = latLngToTile(54.4542, -3.2116, z);
    const n = 2 ** z;
    const west = (x / n) * 360 - 180;
    const east = ((x + 1) / n) * 360 - 180;
    const north = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
    const south = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI;
    expect(-3.2116).toBeGreaterThanOrEqual(west);
    expect(-3.2116).toBeLessThan(east);
    expect(54.4542).toBeLessThanOrEqual(north);
    expect(54.4542).toBeGreaterThan(south);
  });
});
