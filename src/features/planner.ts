// Making a route. Two ways in, one way out: sketch one on the map tap by tap
// and let the router snap it to real paths, or read one in from a GPX file.
// Both end the same way — a SavedRoute handed back to the app to save and show.
//
// Everything in here is scratch work. The waypoints, the blue line, the Plan
// sheet and what it shows: all of it exists only while you are planning and is
// thrown away once the route is saved, shown or cleared. The finished route is
// not this module's to keep, so saving it and making it active are both
// callbacks — the saved list and the active route belong to the app.

import L from '../leaflet-setup';
import { renderProfile } from '../elevation';
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
import { updateRouteCard } from '../ui/routeCard';
import { initSheetDrag } from '../ui/sheet';

/** How long to wait after the last tap or drag before asking the router. */
const RECOMPUTE_DELAY_MS = 350;

/** What the sheet says before there is a route to show. */
const HINT_START = 'Tap the map to add points. The route follows real paths; switch to Straight for open ground.';
const HINT_NEXT = 'Tap the map to add the next point.';

/** The name a route is saved under when the name box is left empty. */
const DEFAULT_NAME = 'My route';

const wpIcon = L.divIcon({ className: '', html: '<div class="wpMarker"></div>', iconSize: [20, 20], iconAnchor: [10, 10] });

// Owned by the app, shared by reference: the routing profile and the walking
// pace behind the sheet's time estimate.
let settings: Settings;
let saveRoute: (r: SavedRoute) => void;
let setActiveRoute: (r: SavedRoute | null, fit?: boolean, persist?: boolean) => void;
let hidePanel: () => void;

let planning = false;
/** The sheet is on its naming step — Save route was tapped, the map is not taking points. */
let naming = false;
/** A router request is due or in flight, so the numbers on screen may be stale. */
let routing = false;
let planWaypoints: LatLng[] = [];
/** planSnaps[i]: the leg arriving at waypoint i follows paths (Paths on). */
let planSnaps: boolean[] = [];
let snapMode = true;
let planMarkers: L.Marker[] = [];
let planLine: L.Polyline | null = null;
let planResult: RouteResult | null = null;
let planAbort: AbortController | null = null;
let planTimer: number | undefined;
/** Put the sheet's drag gesture back to rest; set by initPlanner(). */
let resetSheetDrag: () => void = () => {};

// ---------------------------------------------------------------- accessors

/** Whether a route is being sketched — the map's taps mean waypoints, not places. */
export function isPlanning(): boolean {
  return planning;
}

/**
 * Step out of planning, for a sheet that is about to open over the map.
 *
 * Nothing is thrown away: the waypoints, their markers and the line all stay
 * exactly where they are, and tapping Plan again picks the sketch straight back
 * up. That is not a concession made for this — it is what leaving Plan by its
 * tab, its close button or a drag has always done. Only saving, showing or
 * clearing a plan ends it.
 */
export function endPlanning(): void {
  if (planning) setPlanning(false);
}

// ---------------------------------------------------------------- the sheet

function setPlanning(on: boolean): void {
  planning = on;
  document.body.classList.toggle('planning', on);
  $('btnPlan').classList.toggle('active', on);
  $('planSheet').classList.toggle('hidden', !on);
  map.getContainer().style.cursor = on ? 'crosshair' : '';
  // Whichever way the sheet went, it comes back on the drawing step and with
  // no half-finished drag left on it.
  setNaming(false);
  resetSheetDrag();
  if (on) {
    // Put away the sheet one of the other tabs left open. This is one half of
    // the rule that only ever one of the four tabs is on; showPanel() calls
    // endPlanning() above for the other half. Both sheets rest on the tab bar
    // in the same place, so leaving the other one up would stack them.
    // hidePanel() only un-lights the three sheet tabs, so the Plan tab lit
    // just above stays lit.
    hidePanel();
    // Hides the active route line/stats while sketching, but doesn't touch
    // localStorage: entering Plan shouldn't erase a hike that's still live.
    setActiveRoute(null, true, false);
  }
  publishPlanLift();
  updateRouteCard();
}

/** Swap the sheet between drawing the route and naming it. */
function setNaming(on: boolean): void {
  naming = on;
  $('planDraw').classList.toggle('hidden', on);
  $('planName').classList.toggle('hidden', !on);
  if (on) {
    $<HTMLInputElement>('planNameInput').value = '';
    drawChart();
  }
  updatePlanStats();
}

/**
 * The elevation profile on the naming step. Drawn only once that step is on
 * screen, because the chart sizes itself from its container's width.
 */
function drawChart(): void {
  const chart = $('planChart');
  const drawn = !!planResult && renderProfile(chart, planResult.coords);
  chart.classList.toggle('hidden', !drawn);
}

/**
 * Publish the sheet's height for the toast to clear (see
 * --plan-lift in style.css). The sheet has no fixed height — the hint comes
 * and goes, the naming step is taller, a narrow phone wraps — so it is
 * measured rather than assumed.
 */
function publishPlanLift(): void {
  const sheet = $('planSheet');
  const h = sheet.classList.contains('hidden') ? 0 : sheet.getBoundingClientRect().height;
  document.documentElement.style.setProperty('--plan-lift', `${Math.round(h)}px`);
}

/** "3 h 05" — the time cell has room for the figure, not the unit spelled out. */
function shortDuration(hours: number): string {
  return formatDuration(hours).replace(/ h (\d\d) min$/, ' h $1');
}

/**
 * Bring the sheet up to date with the plan: the three stats cells, the hint
 * under them, and which buttons can be pressed. Exported because the
 * walking-speed setting changes the time estimate under a plan that is already
 * on screen.
 */
export function updatePlanStats(): void {
  const set = (id: string, text: string) => { $(id).textContent = text; };
  if (planResult) {
    const [km, mi = ''] = formatDistance(planResult.distanceM).split(' / ');
    const est = naismithHours(planResult.distanceM, planResult.ascentM, settings.speedKmh);
    set('planDist', km);
    set('planDistSub', mi);
    set('planUp', `↑ ${Math.round(planResult.ascentM)} m`);
    set('planDown', Math.round(planResult.descentM) > 0 ? `↓ ${Math.round(planResult.descentM)} m` : '');
    set('planTime', shortDuration(est));
    set('planPace', `at ${settings.speedKmh} km/h`);
  } else {
    for (const id of ['planDist', 'planUp', 'planTime']) set(id, '—');
    for (const id of ['planDistSub', 'planDown', 'planPace']) set(id, '');
  }
  // Greyed while there is nothing to read, and while a reroute is on its way:
  // the numbers left on screen are the last route's, not this one's.
  $('planSheet').classList.toggle('empty', !planResult || routing);

  let hint = '';
  if (!naming && !planResult) {
    if (planWaypoints.length === 0) hint = HINT_START;
    else if (planWaypoints.length === 1) hint = HINT_NEXT;
    else hint = 'Routing…';
  }
  const hintEl = $('planHint');
  hintEl.textContent = hint;
  hintEl.classList.toggle('hidden', !hint);

  const none = planWaypoints.length === 0;
  $<HTMLButtonElement>('planUndo').disabled = none;
  $<HTMLButtonElement>('planClear').disabled = none;
  $<HTMLButtonElement>('planSave').disabled = !planResult || planWaypoints.length < 2;
}

function setSnap(on: boolean): void {
  snapMode = on;
  for (const [id, sel] of [['planSnapPaths', on], ['planSnapStraight', !on]] as const) {
    $(id).classList.toggle('sel', sel);
    $(id).setAttribute('aria-pressed', String(sel));
  }
}

// ---------------------------------------------------------------- sketching

function clearPlan(): void {
  planWaypoints = [];
  planSnaps = [];
  planMarkers.forEach((m) => m.remove());
  planMarkers = [];
  planLine?.remove();
  planLine = null;
  planResult = null;
  routing = false;
  window.clearTimeout(planTimer);
  planAbort?.abort();
  updatePlanStats();
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
  routing = planWaypoints.length >= 2;
  updatePlanStats();
  window.clearTimeout(planTimer);
  planTimer = window.setTimeout(recomputePlan, RECOMPUTE_DELAY_MS);
}

/** A new route (or none) is in: show it, and redraw the profile if it is up. */
function planRouted(): void {
  routing = false;
  updatePlanStats();
  if (naming) drawChart();
}

async function recomputePlan(): Promise<void> {
  if (planWaypoints.length < 2) {
    planLine?.remove();
    planLine = null;
    planResult = null;
    planRouted();
    return;
  }
  planAbort?.abort();
  planAbort = new AbortController();
  try {
    const result = await routeMixed(planWaypoints, planSnaps, settings.profile, planAbort.signal);
    planResult = result;
    planLine?.remove();
    planLine = L.polyline(result.coords, { color: '#1a73e8', weight: 4 }).addTo(map);
    planRouted();
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
    planRouted();
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

/**
 * Finish planning with the route on the map: saved under `name`, or with no
 * name, shown but kept out of the saved list. Either way the sketch is done.
 */
function finishPlan(name: string | null): void {
  const r = planToRoute(name ?? 'Unsaved route');
  if (!r) return;
  if (name) {
    saveRoute(r);
    toast(`Saved “${name}”`);
  }
  setPlanning(false);
  clearPlan();
  setActiveRoute(r, false);
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
 * Wire up the Plan tab, its sheet and the GPX file input. A finished route
 * leaves through the callbacks rather than being kept here: the saved list is
 * reassigned when a route is deleted, and what "active" means is the app's
 * business, not the planner's.
 */
export function initPlanner(opts: {
  settings: Settings;
  /** Add a finished route to the saved list and persist it. */
  saveRoute: (r: SavedRoute) => void;
  /** Make a route (or none) the active one — same signature as the app's own. */
  setActiveRoute: (r: SavedRoute | null, fit?: boolean, persist?: boolean) => void;
  /**
   * Dismiss the open sheet — entering Plan closes whatever was up, and a GPX
   * import is started from the Routes panel and shouldn't leave it open.
   */
  hidePanel: () => void;
}): void {
  settings = opts.settings;
  saveRoute = opts.saveRoute;
  setActiveRoute = opts.setActiveRoute;
  hidePanel = opts.hidePanel;

  map.on('click', (e: L.LeafletMouseEvent) => {
    // Not while naming: the route being named should be the one you get. Nor
    // while search results are up: that tap is to put the list away (main.ts
    // does), not to add a point somewhere you weren't looking. This handler is
    // wired before main.ts's, so the list is still showing when it runs.
    const resultsOpen = !$('searchResults').classList.contains('hidden');
    if (planning && !naming && !resultsOpen) addWaypoint([e.latlng.lat, e.latlng.lng]);
  });

  // Four ways out, as for every other sheet: the tab, the close button, a drag
  // on the handle — and here, finishing the route. The first three keep the
  // sketch (see endPlanning).
  $('btnPlan').addEventListener('click', () => setPlanning(!planning));
  $('planClose').addEventListener('click', () => setPlanning(false));
  resetSheetDrag = initSheetDrag({
    sheet: $('planSheet'),
    handle: $('planHead'),
    close: () => setPlanning(false)
  });
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(publishPlanLift).observe($('planSheet'));

  $('planSnapPaths').addEventListener('click', () => setSnap(true));
  $('planSnapStraight').addEventListener('click', () => {
    setSnap(false);
    // Only the points still to come change. With a route already drawn that is
    // not what the switch suggests at a glance, so say it once.
    if (planWaypoints.length) toast('Next points join in straight lines', 2500);
  });
  $('planUndo').addEventListener('click', () => {
    planWaypoints.pop();
    planSnaps.pop();
    planMarkers.pop()?.remove();
    scheduleRecompute();
  });
  $('planClear').addEventListener('click', clearPlan);

  // Save route opens the naming step in the sheet, in place of the browser's
  // prompt(). The step is where the route is kept, shown without keeping, or
  // taken back to for more drawing.
  $('planSave').addEventListener('click', () => {
    if (planResult && planWaypoints.length >= 2) setNaming(true);
  });
  $('planBack').addEventListener('click', () => setNaming(false));
  // Save and the keyboard's return key both arrive as the form's submit.
  $('planName').addEventListener('submit', (e) => {
    e.preventDefault();
    finishPlan($<HTMLInputElement>('planNameInput').value.trim() || DEFAULT_NAME);
  });
  $('planShowOnly').addEventListener('click', () => finishPlan(null));

  $('gpxFile').addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) void importGpxFile(file);
  });
}
