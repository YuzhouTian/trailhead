export type LatLng = [number, number, number?]; // [lat, lng, elevation?]

const R = 6371000;

export function haversine(a: LatLng, b: LatLng): number {
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLng = ((b[1] - a[1]) * Math.PI) / 180;
  const la1 = (a[0] * Math.PI) / 180;
  const la2 = (b[0] * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Eight-point compass label for the direction from `a` to `b`, e.g. "NE". */
export function compassDir(a: LatLng, b: LatLng): string {
  const la1 = (a[0] * Math.PI) / 180;
  const la2 = (b[0] * Math.PI) / 180;
  const dLng = ((b[1] - a[1]) * Math.PI) / 180;
  const y = Math.sin(dLng) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);
  const deg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];
}

export interface RouteProgress {
  /** Perpendicular distance from the point to the route, metres. */
  offRouteM: number;
  /** Distance from the route start to the projected position, metres. */
  alongM: number;
  /** Index of the route point at or just before the projection. */
  index: number;
}

/**
 * Project a position onto the route: how far off it is, and how far along.
 * Walks every segment, so it is exact rather than a nearest-vertex guess.
 */
export function projectOnPolyline(p: LatLng, line: LatLng[]): RouteProgress | null {
  if (line.length < 2) return null;

  const cosLat = Math.cos((p[0] * Math.PI) / 180);
  const toXY = (q: LatLng): [number, number] => [
    ((q[1] - p[1]) * Math.PI * cosLat * R) / 180,
    ((q[0] - p[0]) * Math.PI * R) / 180
  ];

  let best = Infinity;
  let bestAlong = 0;
  let bestIndex = 0;
  let travelled = 0;
  let prev = toXY(line[0]);

  for (let i = 1; i < line.length; i++) {
    const cur = toXY(line[i]);
    const abx = cur[0] - prev[0];
    const aby = cur[1] - prev[1];
    const len = Math.hypot(abx, aby);
    let t = 0;
    if (len > 0) {
      t = Math.max(0, Math.min(1, (-prev[0] * abx - prev[1] * aby) / (len * len)));
    }
    const d = Math.hypot(prev[0] + t * abx, prev[1] + t * aby);
    if (d < best) {
      best = d;
      bestAlong = travelled + t * len;
      bestIndex = i - 1;
    }
    travelled += len;
    prev = cur;
  }
  return { offRouteM: best, alongM: bestAlong, index: bestIndex };
}

/** Cumulative distance to each point of a route, metres. */
export function cumulativeDistances(line: LatLng[]): number[] {
  const out = [0];
  for (let i = 1; i < line.length; i++) out.push(out[i - 1] + haversine(line[i - 1], line[i]));
  return out;
}

/** Distance from origin (0,0) to segment a-b in the projected plane. */
function distToSegment(a: [number, number], b: [number, number]): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const len2 = abx * abx + aby * aby;
  let t = 0;
  if (len2 > 0) {
    t = Math.max(0, Math.min(1, (-a[0] * abx - a[1] * aby) / len2));
  }
  const cx = a[0] + t * abx;
  const cy = a[1] + t * aby;
  return Math.hypot(cx, cy);
}

export function formatDistance(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(1)} km / ${(m / 1609.344).toFixed(1)} mi`;
}

export function formatDuration(hours: number): string {
  const h = Math.floor(hours);
  const min = Math.round((hours - h) * 60);
  return h > 0 ? `${h} h ${min.toString().padStart(2, '0')} min` : `${min} min`;
}

/** Naismith's rule: pace on the flat plus one hour per 600 m of ascent. */
export function naismithHours(distM: number, ascentM: number, speedKmh: number): number {
  return distM / 1000 / Math.max(speedKmh, 0.1) + ascentM / 600;
}

/** Total climb and drop, ignoring wobbles under 5 m so GPS noise doesn't inflate them. */
export function computeClimbs(coords: LatLng[]): { ascentM: number; descentM: number } {
  let ascentM = 0;
  let descentM = 0;
  let ref: number | null = null;
  for (const c of coords) {
    const e = c[2];
    if (typeof e !== 'number') continue;
    if (ref === null) {
      ref = e;
    } else if (e > ref + 5) {
      ascentM += e - ref;
      ref = e;
    } else if (e < ref - 5) {
      descentM += ref - e;
      ref = e;
    }
  }
  return { ascentM, descentM };
}

/**
 * Douglas-Peucker simplification returning indices of kept points,
 * so parallel arrays (e.g. elevations) stay aligned.
 */
export function simplifyIndices(coords: LatLng[], toleranceDeg: number): number[] {
  if (coords.length <= 2) return coords.map((_, i) => i);
  const keep = new Array(coords.length).fill(false);
  keep[0] = keep[coords.length - 1] = true;
  const stack: [number, number][] = [[0, coords.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let maxD = 0;
    let maxI = -1;
    for (let i = a + 1; i < b; i++) {
      const d = pointSegDistDeg(coords[i], coords[a], coords[b]);
      if (d > maxD) {
        maxD = d;
        maxI = i;
      }
    }
    if (maxD > toleranceDeg && maxI > 0) {
      keep[maxI] = true;
      stack.push([a, maxI], [maxI, b]);
    }
  }
  return keep.flatMap((k, i) => (k ? [i] : []));
}

function pointSegDistDeg(p: LatLng, a: LatLng, b: LatLng): number {
  const abx = b[1] - a[1];
  const aby = b[0] - a[0];
  const len2 = abx * abx + aby * aby;
  let t = 0;
  if (len2 > 0) {
    t = Math.max(0, Math.min(1, ((p[1] - a[1]) * abx + (p[0] - a[0]) * aby) / len2));
  }
  return Math.hypot(p[1] - (a[1] + t * abx), p[0] - (a[0] + t * aby));
}

/** Slippy-map tile coordinates for a lat/lng at a zoom level. */
export function latLngToTile(lat: number, lng: number, z: number): [number, number] {
  const n = 2 ** z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  );
  return [Math.min(n - 1, Math.max(0, x)), Math.min(n - 1, Math.max(0, y))];
}
