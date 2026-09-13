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

/** Two nearest points that count as equally near — a loop's start vs finish. */
const TIE_M = 25;

/**
 * Project a position onto the route: how far off it is, and how far along.
 * Walks every segment, so it is exact rather than a nearest-vertex guess.
 *
 * `hintAlongM` is roughly how far along the route we already were. Where the
 * line passes close to itself — a loop returning to its start, an out-and-back
 * retracing the same path — several points are near-equally close, and the
 * bare nearest can snap to the wrong one (standing at a loop's start reads as
 * 100% done, because the finish is the same spot). Among the near-tied points
 * we pick the one closest to the hint, so progress stays continuous. With no
 * hint the target is 0, so a freshly loaded route reads from its start.
 */
export function projectOnPolyline(
  p: LatLng,
  line: LatLng[],
  hintAlongM: number | null = null
): RouteProgress | null {
  if (line.length < 2) return null;

  // Flat metres east/north of `p`: exact enough at walking scale, and what
  // makes the per-segment work plain arithmetic.
  const kx = (Math.PI * Math.cos((p[0] * Math.PI) / 180) * R) / 180;
  const ky = (Math.PI * R) / 180;

  // One pass, no allocation per vertex. This runs on every GPS fix — about once
  // a second — over the whole route, and the version that built a small array
  // per vertex and an object per segment, in two passes, was measurable on a
  // long route. Scalars in, scalars out.
  //
  // The tie rule still needs the nearest distance before it can tell which
  // points are near-tied with it, and that is not known until the end. So every
  // segment within TIE_M of the nearest *so far* is noted as a candidate; the
  // running nearest only ever shrinks, so no segment that ends up within TIE_M
  // of the true nearest can have been passed over. Usually only a handful
  // qualify, and the second look is over those alone.
  let minD = Infinity;
  let count = 0;
  let travelled = 0;
  let ax = (line[0][1] - p[1]) * kx;
  let ay = (line[0][0] - p[0]) * ky;
  for (let i = 1; i < line.length; i++) {
    const bx = (line[i][1] - p[1]) * kx;
    const by = (line[i][0] - p[0]) * ky;
    const abx = bx - ax;
    const aby = by - ay;
    // sqrt rather than Math.hypot, which is several times slower in V8 and
    // guards against an overflow that walking-scale metres never come near.
    const len2 = abx * abx + aby * aby;
    const len = Math.sqrt(len2);
    let t = 0;
    if (len2 > 0) t = Math.max(0, Math.min(1, (-ax * abx - ay * aby) / len2));
    const cx = ax + t * abx;
    const cy = ay + t * aby;
    const d = Math.sqrt(cx * cx + cy * cy);
    if (d < minD) minD = d;
    if (d <= minD + TIE_M) {
      if (count === candD.length) growCandidates();
      candD[count] = d;
      candAlong[count] = travelled + t * len;
      candIndex[count] = i - 1;
      count++;
    }
    travelled += len;
    ax = bx;
    ay = by;
  }

  // Among points within TIE_M of the nearest, take the one nearest the hint.
  const target = hintAlongM ?? 0;
  let best = -1;
  let bestScore = Infinity;
  for (let c = 0; c < count; c++) {
    if (candD[c] > minD + TIE_M) continue;
    const score = Math.abs(candAlong[c] - target);
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best < 0 ? null : { offRouteM: candD[best], alongM: candAlong[best], index: candIndex[best] };
}

// Candidate segments for projectOnPolyline, kept between calls so a fix does
// not allocate them afresh. Grown by doubling; a long route whose line doubles
// back on itself for its whole length is the only thing that ever grows them.
let candD = new Float64Array(64);
let candAlong = new Float64Array(64);
let candIndex = new Int32Array(64);
function growCandidates(): void {
  const size = candD.length * 2;
  const d = new Float64Array(size);
  const along = new Float64Array(size);
  const index = new Int32Array(size);
  d.set(candD);
  along.set(candAlong);
  index.set(candIndex);
  candD = d;
  candAlong = along;
  candIndex = index;
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

/**
 * formatDistance in two halves, for a stats cell: the metric figure, and the
 * miles to put under it — empty under a kilometre, where there are none.
 */
export function distanceParts(m: number): [metric: string, miles: string] {
  const [metric, miles = ''] = formatDistance(m).split(' / ');
  return [metric, miles];
}

export function formatDuration(hours: number): string {
  // Round to whole minutes first, then split: rounding the minutes on their own
  // lets a remainder round up to 60 while the hour count stays behind.
  const total = Math.round(hours * 60);
  const h = Math.floor(total / 60);
  const min = total % 60;
  return h > 0 ? `${h} h ${min.toString().padStart(2, '0')} min` : `${min} min`;
}

/** "3 h 05" — a stats cell has room for the figure, not the unit spelled out. */
export function shortDuration(hours: number): string {
  return formatDuration(hours).replace(/ h (\d\d) min$/, ' h $1');
}

/** Naismith's rule: pace on the flat plus one hour per 600 m of ascent. */
export function naismithHours(distM: number, ascentM: number, speedKmh: number): number {
  return distM / 1000 / Math.max(speedKmh, 0.1) + ascentM / 600;
}

/**
 * Total climb and drop, ignoring wobbles under 5 m so GPS noise doesn't inflate
 * them. `from` measures only the route from that point on — the same answer as
 * `coords.slice(from)`, without copying the route to get it, which matters to
 * the remaining-climb readout because it asks on every GPS fix.
 */
export function computeClimbs(
  coords: LatLng[],
  from = 0
): { ascentM: number; descentM: number } {
  let ascentM = 0;
  let descentM = 0;
  let ref: number | null = null;
  for (let i = Math.max(0, from); i < coords.length; i++) {
    const e = coords[i][2];
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
