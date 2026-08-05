import { BROUTER_URL } from './config';
import type { LatLng } from './geo';

export interface RouteResult {
  coords: LatLng[];
  distanceM: number;
  ascentM: number;
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
    ascentM: parseFloat(props['filtered ascend'] ?? props['plain-ascend'] ?? '0') || 0
  };
}
