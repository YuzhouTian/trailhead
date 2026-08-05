export type LatLng = [number, number]; // [lat, lng]

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

/**
 * Minimum distance in metres from point p to the polyline.
 * Uses a local equirectangular projection per segment — accurate to well
 * under a metre at hiking scales.
 */
export function distanceToPolyline(p: LatLng, line: LatLng[]): number {
  if (line.length === 0) return Infinity;
  if (line.length === 1) return haversine(p, line[0]);

  const cosLat = Math.cos((p[0] * Math.PI) / 180);
  const toXY = (q: LatLng): [number, number] => [
    ((q[1] - p[1]) * Math.PI * cosLat * R) / 180,
    ((q[0] - p[0]) * Math.PI * R) / 180
  ];

  let best = Infinity;
  let prev = toXY(line[0]);
  for (let i = 1; i < line.length; i++) {
    const cur = toXY(line[i]);
    best = Math.min(best, distToSegment(prev, cur));
    prev = cur;
  }
  return best;
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
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
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
