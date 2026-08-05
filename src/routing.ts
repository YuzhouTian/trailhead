import { BROUTER_URL } from './config';
import { computeClimbs, haversine, type LatLng } from './geo';

export interface RouteResult {
  coords: LatLng[];
  distanceM: number;
  ascentM: number;
  descentM: number;
}

/**
 * Route through all waypoints in order using the public BRouter server,
 * snapping to actual OSM paths. Waypoints are [lat, lng].
 */
export async function routeViaBrouter(
  waypoints: LatLng[],
  profile: string,
  signal?: AbortSignal
): Promise<RouteResult> {
  const lonlats = waypoints.map(([lat, lng]) => `${lng.toFixed(6)},${lat.toFixed(6)}`).join('|');
  const url = `${BROUTER_URL}?lonlats=${lonlats}&profile=${encodeURIComponent(profile)}&alternativeidx=0&format=geojson`;

  const res = await fetch(url, { signal });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Routing failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  const feature = json?.features?.[0];
  const coords: LatLng[] = (feature?.geometry?.coordinates ?? []).map(
    (c: number[]) =>
      (typeof c[2] === 'number' ? [c[1], c[0], c[2]] : [c[1], c[0]]) as LatLng
  );
  if (coords.length < 2) throw new Error('Router returned an empty route');

  const props = feature.properties ?? {};
  return {
    coords,
    distanceM: parseFloat(props['track-length'] ?? '0') || 0,
    ascentM: parseFloat(props['filtered ascend'] ?? props['plain-ascend'] ?? '0') || 0,
    descentM: computeClimbs(coords).descentM
  };
}

/**
 * Route through waypoints where each leg may be snapped to paths (BRouter)
 * or drawn as a straight freeform line. `snaps[i]` says whether the leg
 * *arriving at* waypoint i is snapped; missing/undefined means all snapped.
 */
export async function routeMixed(
  waypoints: LatLng[],
  snaps: boolean[] | undefined | null,
  profile: string,
  signal?: AbortSignal
): Promise<RouteResult> {
  // Group consecutive same-mode legs so a run of snapped legs is one BRouter call.
  const groups: { pts: LatLng[]; snap: boolean }[] = [];
  for (let i = 1; i < waypoints.length; i++) {
    const snap = snaps ? snaps[i] !== false : true;
    const last = groups[groups.length - 1];
    if (last && last.snap === snap) {
      last.pts.push(waypoints[i]);
    } else {
      groups.push({ pts: [waypoints[i - 1], waypoints[i]], snap });
    }
  }

  const results = await Promise.all(
    groups.map(async (g): Promise<RouteResult> => {
      if (g.snap) return routeViaBrouter(g.pts, profile, signal);
      let d = 0;
      for (let i = 1; i < g.pts.length; i++) d += haversine(g.pts[i - 1], g.pts[i]);
      return { coords: g.pts.map((p) => [...p] as LatLng), distanceM: d, ascentM: 0, descentM: 0 };
    })
  );

  const coords: LatLng[] = [];
  let distanceM = 0;
  let ascentM = 0;
  let descentM = 0;
  for (const r of results) {
    const start =
      coords.length &&
      r.coords.length &&
      coords[coords.length - 1][0] === r.coords[0][0] &&
      coords[coords.length - 1][1] === r.coords[0][1]
        ? 1
        : 0;
    coords.push(...r.coords.slice(start));
    distanceM += r.distanceM;
    ascentM += r.ascentM;
    descentM += r.descentM;
  }
  if (coords.length < 2) throw new Error('Route needs at least two points');
  return { coords, distanceM, ascentM, descentM };
}
