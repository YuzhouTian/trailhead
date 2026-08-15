// "Directions to": a route from where you are now to a place you picked — a pin
// you saved, or a spot you have only just long-pressed.
//
// The trick this module rests on is that a detour is an ordinary SavedRoute
// which simply never gets saved. Handing one to the app's setActiveRoute buys
// the line on the map, the stats, the Naismith estimate, the elevation profile,
// the on/off-route banner, the remaining-distance readout, the offline-tiles
// button and restore-on-reload — none of which is written here, or anywhere
// else, for this feature.
//
// Like the planner, it keeps nothing: the finished route leaves through the
// setActiveRoute callback, because what "active" means is the app's business.
// It reads where you are through tracking's accessors rather than owning any
// GPS state, the same arrangement pins.ts has.
//
// Holding the route you were already on and resuming it afterwards is the
// second half of issue #22 and is deliberately not here yet — see replaceCheck()
// for what happens meanwhile.

import { haversine, type LatLng } from '../geo';
import { routeMixed } from '../routing';
import { type SavedRoute, type Settings } from '../state';
import { toast } from '../ui/dom';
import { getKnownPosition, getLastFix, setKnownPosition } from './tracking';

/** Where a set of directions leads. */
export interface DetourTarget {
  name: string;
  lat: number;
  lng: number;
}

/**
 * Progress reporting for whatever asked for the directions, so the button that
 * was tapped can say what is happening. `null` means "done, put yourself back".
 */
export type DetourLabel = (text: string | null) => void;

// Owned by the app, shared by reference or read through getters.
let settings: Settings;
let getActiveRoute: () => SavedRoute | null;
let setActiveRoute: (r: SavedRoute | null, fit?: boolean, persist?: boolean) => void;

/** The in-flight routing request, so a second tap cancels the first. */
let abort: AbortController | null = null;

// ---------------------------------------------------------------- where am I

/**
 * The point to route from. A live fix is seconds old and always wins. Failing
 * that, ask for one — routing from the wrong place is worse than waiting a
 * moment — and only fall back to the last position we know of if the fix never
 * arrives, which is still very likely where you are standing.
 */
async function startPoint(): Promise<LatLng | null> {
  const live = getLastFix();
  if (live) return live;
  if (!('geolocation' in navigator)) return getKnownPosition();
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const here: LatLng = [pos.coords.latitude, pos.coords.longitude];
        setKnownPosition(here);
        resolve(here);
      },
      () => resolve(getKnownPosition()),
      { enableHighAccuracy: true, maximumAge: 60_000, timeout: 15_000 }
    );
  });
}

// ---------------------------------------------------------------- the route

function toRoute(
  from: LatLng,
  dest: DetourTarget,
  coords: LatLng[],
  distanceM: number,
  ascentM: number,
  descentM: number,
  straightLine = false
): SavedRoute {
  return {
    id: String(Date.now()),
    name: straightLine ? `Straight line to ${dest.name}` : `Directions to ${dest.name}`,
    // Genuinely the waypoints this route was built from, so it can be reopened
    // in the planner later like any other two-point route.
    waypoints: [from, [dest.lat, dest.lng]],
    snaps: null,
    coords,
    distanceM,
    ascentM,
    descentM,
    detourTo: dest.name,
    straightLine,
    createdAt: Date.now()
  };
}

/**
 * Until pause-and-resume lands, making a detour active closes whatever route
 * you were on, so ask first. Saved routes are still in your list afterwards;
 * an unsaved one would be gone, which is exactly why this is a question rather
 * than something that quietly happens.
 */
function replaceCheck(dest: DetourTarget): boolean {
  const current = getActiveRoute();
  if (!current) return true;
  return confirm(`Close “${current.name}” and route to “${dest.name}”?`);
}

/**
 * Route from where you are to `dest` and make it the active route. Reports
 * progress through `label` so the caller's button can speak, and resolves true
 * only if a route actually became active — the caller uses that to decide
 * whether to get its card out of the way.
 */
export async function directionsTo(dest: DetourTarget, label: DetourLabel): Promise<boolean> {
  if (!replaceCheck(dest)) return false;

  abort?.abort();
  abort = new AbortController();
  const signal = abort.signal;

  label('Finding you…');
  const from = await startPoint();
  if (signal.aborted) return false;
  if (!from) {
    label(null);
    toast('No position yet — turn on Me and try again', 4000);
    return false;
  }

  const to: LatLng = [dest.lat, dest.lng];
  label('Routing…');
  try {
    const r = await routeMixed([from, to], null, settings.profile, signal);
    if (signal.aborted) return false;
    label(null);
    setActiveRoute(toRoute(from, dest, r.coords, r.distanceM, r.ascentM, r.descentM));
    return true;
  } catch (e) {
    if ((e as Error).name === 'AbortError') return false;
    // Router unreachable, which on a hill is the normal case rather than the
    // exceptional one. Fall back to a straight line as the planner does — but
    // say so in the route's own name and in how it is drawn, not only in a
    // toast that is gone in five seconds. The difference between a path and a
    // bearing is the whole point of the feature.
    label(null);
    setActiveRoute(toRoute(from, dest, [from, to], haversine(from, to), 0, 0, true));
    toast(`Router unreachable — showing a straight line, not a path. ${(e as Error).message}`, 5000);
    return true;
  }
}

/** Wire the module up. Nothing here is owned by it — see the header. */
export function initDetour(opts: {
  settings: Settings;
  getActiveRoute: () => SavedRoute | null;
  setActiveRoute: (r: SavedRoute | null, fit?: boolean, persist?: boolean) => void;
}): void {
  settings = opts.settings;
  getActiveRoute = opts.getActiveRoute;
  setActiveRoute = opts.setActiveRoute;
}
