import { BROUTER_URL } from './config';
import { computeClimbs, haversine, type LatLng } from './geo';

// ---------------------------------------------------------------- our own profiles

/**
 * Profiles the public server does not ship, by the id the app stores and
 * shares. Loaded on first use rather than bundled into startup: nobody needs
 * one until they route, and routing needs a connection anyway.
 */
const CUSTOM_PROFILES: Record<string, () => Promise<string>> = {
  'hiking-mountain': () => import('./profiles/mountain-hiking.brf?raw').then((m) => m.default)
};

/**
 * The profile as it is sent: comments and blank lines dropped, which takes a
 * third off the upload (nothing on the server reads them), and line endings
 * normalised so a Windows checkout names it the same as everyone else's.
 */
export function compactProfile(text: string): string {
  return text
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trimEnd())
    .filter((l) => l.trim())
    .join('\n');
}

/** FNV-1a, as eight hex digits — enough to tell one version of a profile from the next. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Uploads made this session, by app profile id, each resolving to the id the
 * server keeps the profile under.
 *
 * The server id is named after the profile's content, so every phone running
 * the same build shares one file on the server and a changed profile gets a
 * new one. It is still uploaded once per session rather than once ever: the
 * server makes no promise to keep an uploaded file, and the upload overwrites
 * the same name, so it costs one small request and nothing piles up.
 *
 * A failed upload is forgotten, so the next route asks again rather than
 * failing for the rest of the session.
 */
const uploads = new Map<string, Promise<string>>();

function uploadProfile(profile: string, load: () => Promise<string>, force = false): Promise<string> {
  const pending = uploads.get(profile);
  if (pending && !force) return pending;
  const job = (async () => {
    const text = compactProfile(await load());
    const serverId = `custom_trailhead-${profile}-${hash(text)}`;
    // No abort signal: this upload is shared by every request waiting on it,
    // and one of them being cancelled is no reason to cancel it for the rest.
    const res = await fetch(`${BROUTER_URL}/profile/${serverId}`, { method: 'POST', body: text });
    const json = await res.json().catch(() => null);
    // The server answers 200 with an "error" field for a profile it could not
    // compile, having saved it anyway, so the status alone proves nothing.
    if (!res.ok || !json || json.error || json.profileid !== serverId) {
      throw new Error(`Couldn't set up the routing profile (${json?.error ?? res.status})`);
    }
    return serverId;
  })();
  uploads.set(profile, job);
  job.catch(() => { if (uploads.get(profile) === job) uploads.delete(profile); });
  return job;
}

/** Forget this session's uploads. For tests. */
export function resetProfileUploads(): void {
  uploads.clear();
}

// ---------------------------------------------------------------- routing

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
  const request = (id: string) =>
    fetch(`${BROUTER_URL}?lonlats=${lonlats}&profile=${encodeURIComponent(id)}&alternativeidx=0&format=geojson`, { signal });

  const load = CUSTOM_PROFILES[profile];
  let res = await request(load ? await uploadProfile(profile, load) : profile);
  // A profile the server has lost since this session uploaded it comes back as
  // a bare 500. So does a route it cannot find, which is why this is one retry
  // and not a loop: put the profile back, ask once more, and let a second
  // failure be the real answer.
  if (load && res.status === 500 && !signal?.aborted) {
    res = await request(await uploadProfile(profile, load, true));
  }
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
