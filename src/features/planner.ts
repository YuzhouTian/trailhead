// Making a route. Two ways in, one way out: sketch one on the map tap by tap
// and let the router snap it to real paths, or read one in from a GPX file.
// Both end the same way — a SavedRoute handed back to the app to save and show.
//
// Everything in here is scratch work. The waypoints, the blue dashed line, the
// stats bar along the bottom: all of it exists only while you are planning and
// is thrown away on Done or Clear. The finished route is not this module's to
// keep, so saving it and making it active are both callbacks — the saved list
// and the active route belong to the app.

import L from '../leaflet-setup';
import {
  computeClimbs,
  formatDistance,
  formatDuration,
  haversine,
  naismithHours,
  type LatLng
} from '../geo';
import { parseGpx } from '../gpx';
import { map } from '../map/map';
import { routeMixed, type RouteResult } from '../routing';
import { type SavedRoute, type Settings } from '../state';
import { $, toast } from '../ui/dom';
import { climbText, updateRouteCard } from '../ui/routeCard';

/** How long to wait after the last tap or drag before asking the router. */
const RECOMPUTE_DELAY_MS = 350;

const wpIcon = L.divIcon({ className: '', html: '<div class="wpMarker"></div>', iconSize: [20, 20], iconAnchor: [10, 10] });

// Owned by the app, shared by reference: the routing profile and the walking
// pace behind the plan bar's time estimate.
let settings: Settings;
let saveRoute: (r: SavedRoute) => void;
let setActiveRoute: (r: SavedRoute | null, fit?: boolean, persist?: boolean) => void;
let hidePanel: () => void;

let planning = false;
let planWaypoints: LatLng[] = [];
/** planSnaps[i]: the leg arriving at waypoint i follows paths (magnet on). */
let planSnaps: boolean[] = [];
let snapMode = true;
let planMarkers: L.Marker[] = [];
let planLine: L.Polyline | null = null;
let planResult: RouteResult | null = null;
let planAbort: AbortController | null = null;
let planTimer: number | undefined;

// ---------------------------------------------------------------- accessors

/** Whether a route is being sketched — the map's taps mean waypoints, not places. */
export function isPlanning(): boolean {
  return planning;
}

/** The route as currently routed, for the card to show while planning. */
export function getPlan(): RouteResult | null {
  return planResult;
}

// ---------------------------------------------------------------- sketching

function setPlanning(on: boolean): void {
  planning = on;
  document.body.classList.toggle('planning', on);
  $('btnPlan').classList.toggle('active', on);
  $('planBar').classList.toggle('hidden', !on);
  map.getContainer().style.cursor = on ? 'crosshair' : '';
  if (on) {
    // Hides the active route line/stats while sketching, but doesn't touch
    // localStorage: entering Plan shouldn't erase a hike that's still live.
    setActiveRoute(null, true, false);
    updatePlanStats();
  }
  updateRouteCard();
}

function clearPlan(): void {
  planWaypoints = [];
  planSnaps = [];
  planMarkers.forEach((m) => m.remove());
  planMarkers = [];
  planLine?.remove();
  planLine = null;
  planResult = null;
  planAbort?.abort();
  updatePlanStats();
}

/**
 * The line along the plan bar: the route's stats once it has been routed, a
 * prompt before there is anything to route, or `text` for a one-off message.
 * Exported because the walking-speed setting changes the time estimate under a
 * plan that is already on screen.
 */
export function updatePlanStats(text?: string): void {
  const el = $('planStats');
  if (text) {
    el.textContent = text;
  } else if (planResult) {
    const est = naismithHours(planResult.distanceM, planResult.ascentM, settings.speedKmh);
    el.textContent = `${formatDistance(planResult.distanceM)} · ${climbText(planResult.ascentM, planResult.descentM)} · ~${formatDuration(est)}`;
  } else if (planWaypoints.length < 2) {
    el.textContent = 'Tap the map to add points — the route follows real paths';
  } else {
    el.textContent = 'Routing…';
  }
}

function addWaypoint(p: LatLng): void {
  planWaypoints.push(p);
  planSnaps.push(snapMode);
  const marker = L.marker(p, { icon: wpIcon, draggable: true }).addTo(map);
  marker.on('dragend', () => {
    const i = planMarkers.indexOf(marker);
    const ll = marker.getLatLng();
    planWaypoints[i] = [ll.lat, ll.lng];
    scheduleRecompute();
  });
  planMarkers.push(marker);
  scheduleRecompute();
}

function scheduleRecompute(): void {
  updatePlanStats();
  window.clearTimeout(planTimer);
  planTimer = window.setTimeout(recomputePlan, RECOMPUTE_DELAY_MS);
}

async function recomputePlan(): Promise<void> {
  if (planWaypoints.length < 2) {
    planLine?.remove();
    planLine = null;
    planResult = null;
    updatePlanStats();
    return;
  }
  planAbort?.abort();
  planAbort = new AbortController();
  updatePlanStats('Routing…');
  try {
    const result = await routeMixed(planWaypoints, planSnaps, settings.profile, planAbort.signal);
    planResult = result;
    planLine?.remove();
    planLine = L.polyline(result.coords, { color: '#1a73e8', weight: 4 }).addTo(map);
    updatePlanStats();
    updateRouteCard();
  } catch (e) {
    if ((e as Error).name === 'AbortError') return;
    // Router unreachable (offline / bad segment): fall back to straight lines.
    planResult = {
      coords: [...planWaypoints],
      distanceM: planWaypoints.reduce(
        (acc, p, i) => (i ? acc + haversine(planWaypoints[i - 1], p) : 0),
        0
      ),
      ascentM: 0,
      descentM: 0
    };
    planLine?.remove();
    planLine = L.polyline(planResult.coords, {
      color: '#1a73e8',
      weight: 4,
      dashArray: '6 8'
    }).addTo(map);
    updatePlanStats();
    updateRouteCard();
    toast(`Router error — showing straight line. ${(e as Error).message}`, 5000);
  }
}

function planToRoute(name: string): SavedRoute | null {
  if (!planResult) return null;
  return {
    id: String(Date.now()),
    name,
    waypoints: [...planWaypoints],
    snaps: [...planSnaps],
    coords: planResult.coords,
    distanceM: planResult.distanceM,
    ascentM: planResult.ascentM,
    descentM: planResult.descentM,
    createdAt: Date.now()
  };
}

// ---------------------------------------------------------------- GPX import

async function importGpxFile(file: File): Promise<void> {
  try {
    const gpx = parseGpx(await file.text(), file.name.replace(/\.gpx$/i, ''));
    let dist = 0;
    for (let i = 1; i < gpx.coords.length; i++) dist += haversine(gpx.coords[i - 1], gpx.coords[i]);
    const r: SavedRoute = {
      id: String(Date.now()),
      name: gpx.name,
      waypoints: null,
      coords: gpx.coords,
      distanceM: dist,
      ...computeClimbs(gpx.coords),
      createdAt: Date.now()
    };
    saveRoute(r);
    setActiveRoute(r);
    hidePanel();
    toast(`Imported “${gpx.name}” (${formatDistance(dist)})`);
  } catch (err) {
    toast(`Import failed: ${(err as Error).message}`, 5000);
  }
}

// ---------------------------------------------------------------- wiring

/**
 * Wire up the Plan button, the plan bar and the GPX file input. A finished
 * route leaves through the callbacks rather than being kept here: the saved
 * list is reassigned when a route is deleted, and what "active" means is the
 * app's business, not the planner's.
 */
export function initPlanner(opts: {
  settings: Settings;
  /** Add a finished route to the saved list and persist it. */
  saveRoute: (r: SavedRoute) => void;
  /** Make a route (or none) the active one — same signature as the app's own. */
  setActiveRoute: (r: SavedRoute | null, fit?: boolean, persist?: boolean) => void;
  /** Dismiss the open panel: a GPX import is started from the Routes panel. */
  hidePanel: () => void;
}): void {
  settings = opts.settings;
  saveRoute = opts.saveRoute;
  setActiveRoute = opts.setActiveRoute;
  hidePanel = opts.hidePanel;

  map.on('click', (e: L.LeafletMouseEvent) => {
    if (planning) addWaypoint([e.latlng.lat, e.latlng.lng]);
  });

  $('btnPlan').addEventListener('click', () => setPlanning(!planning));
  $('planSnap').addEventListener('click', () => {
    snapMode = !snapMode;
    $('planSnap').classList.toggle('active', snapMode);
    toast(snapMode ? 'Snap to paths ON' : 'Freeform ON — next points connect in straight lines', 2500);
  });
  $('planUndo').addEventListener('click', () => {
    planWaypoints.pop();
    planSnaps.pop();
    planMarkers.pop()?.remove();
    scheduleRecompute();
  });
  $('planClear').addEventListener('click', clearPlan);
  $('planDone').addEventListener('click', () => {
    // Nothing drawn yet — just leave planning.
    if (!planResult || planWaypoints.length < 2) {
      setPlanning(false);
      clearPlan();
      return;
    }
    // Offer to keep it: naming the route saves it to your list; cancelling still
    // finishes with the route shown (but unsaved), so a plan is never lost by an
    // accidental tap. Either way, planning ends here.
    const name = prompt('Name this route to save it — or cancel to finish without saving:', 'My route');
    const r = planToRoute(name || 'Unsaved route')!;
    if (name) {
      saveRoute(r);
      toast(`Saved “${name}”`);
    }
    setPlanning(false);
    clearPlan();
    setActiveRoute(r, false);
  });

  $('gpxFile').addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) void importGpxFile(file);
  });
}
