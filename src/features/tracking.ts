// GPS: the blue dot and its accuracy circle, the "Me" button's off → follow →
// heading-up cycle, and everything derived from a fix — where you are along the
// active route, the on/off-route banner, and how much walk is left.
//
// The route itself belongs to the app (it is planned, loaded and deleted
// elsewhere), so it arrives as a getter. What this module owns privately is the
// GPS state: the watch, the latest fix, the last position we know of at all,
// and the route projection derived from them. Everything else reads those
// through the accessors below rather than reaching into the closure.

import L from '../leaflet-setup';
import { ARRIVAL_M, EN_ROUTE_THRESHOLD_M, OFF_ROUTE_THRESHOLD_M } from '../config';
import {
  computeClimbs,
  cumulativeDistances,
  formatDistance,
  formatDuration,
  haversine,
  naismithHours,
  projectOnPolyline,
  type LatLng,
  type RouteProgress
} from '../geo';
import { map } from '../map/map';
import { type SavedRoute, type Settings } from '../state';
import { $, svgUse, toast } from '../ui/dom';
import { positionText } from '../ui/format';
import { climbText, updateRouteCard, updateRouteStart } from '../ui/routeCard';

const gpsIcon = L.divIcon({ className: '', html: '<div class="gpsDot"></div>', iconSize: [22, 22], iconAnchor: [11, 11] });

// The "Me" button shows its state through the glyph as well as the colour:
// a hollow crosshair when off, a filled one while following you north-up, and
// a compass arrow in heading-up mode.
const LOCATE_ICON = { off: svgUse('i-locate'), follow: svgUse('i-locate-on'), heading: svgUse('i-compass') };

// Owned by the app and shared by reference; only read here (the walking pace
// for the time estimate).
let settings: Settings;
let getActiveRoute: () => SavedRoute | null;
/** Told about every fix, for anything that shows a distance from you. */
let onPosition: (() => void) | null = null;

let watchId: number | null = null;
let gpsMarker: L.Marker | null = null;
let accCircle: L.Circle | null = null;
let lastFix: LatLng | null = null;
let lastAccuracy = 0;
let follow = false;
/**
 * Best position we know of, whether or not Me is following. Deliberately
 * separate from lastFix: route progress and the on/off-route banner should only
 * speak while GPS is genuinely live, but "how far away is that pin" is still
 * worth answering from the last position we had. Survives stopWatch().
 */
let lastKnownPos: LatLng | null = null;

// How far along the active route we last were, and the latest projection —
// used to keep progress continuous where the line passes close to itself.
let routeHint: number | null = null;
let lastProg: RouteProgress | null = null;
// The newest projection near enough to the line to be believed as progress.
// Stays put while you are away from the route, so the readout holds the last
// real position instead of following a meaningless nearest-point guess.
let lastOnRouteProg: RouteProgress | null = null;

// ---------------------------------------------------------------- accessors

/** The latest live GPS fix, or null when Me is off. */
export function getLastFix(): LatLng | null {
  return lastFix;
}

/** The last position we know of at all, live or not — see lastKnownPos. */
export function getKnownPosition(): LatLng | null {
  return lastKnownPos;
}

/** Remember a position found outside the watch (startup recentre, one-shot fix). */
export function setKnownPosition(p: LatLng): void {
  lastKnownPos = p;
}

/** Whether the GPS watch is live — not whether the map is auto-recentring. */
export function isTracking(): boolean {
  return watchId !== null;
}

/** Metres along the route to mark as "you are here", or null if not believable. */
export function hereAlongM(): number | null {
  return lastOnRouteProg?.alongM ?? null;
}

/**
 * Forget where we were along the route. Called when the active route changes:
 * a freshly loaded route reads from its start rather than from the last one's
 * progress.
 */
export function resetRouteProgress(): void {
  routeHint = null;
  lastProg = null;
  lastOnRouteProg = null;
}

// ---------------------------------------------------------------- on/off route

export function updateBanner(): void {
  const activeRoute = getActiveRoute();
  const banner = $('statusBanner');
  if (!lastFix || !activeRoute) {
    lastProg = null;
    lastOnRouteProg = null;
    banner.classList.add('hidden');
    updateRouteCard();
    return;
  }
  // One projection per fix, seeded with where we were, then shared with the
  // remaining-distance readout so both stay consistent and continuous.
  const prog = projectOnPolyline(lastFix, activeRoute.coords, routeHint);
  lastProg = prog;
  // Only let a fix near the line move the hint. From miles away the nearest
  // point can be anywhere on the route, and seeding the hint with that would
  // drag every later projection towards the wrong part of the walk.
  if (prog && prog.offRouteM <= EN_ROUTE_THRESHOLD_M) {
    routeHint = prog.alongM;
    lastOnRouteProg = prog;
  }
  banner.classList.remove('hidden');
  // Arriving where a set of directions was leading outranks anything the line
  // has to say: at the lake you asked for, "OFF ROUTE" is technically true and
  // completely unhelpful. Measured to the destination rather than along the
  // route, because the router stops where the path does, not where you stand.
  if (activeRoute.detourTo && haversine(lastFix, activeRoute.coords[activeRoute.coords.length - 1]) <= ARRIVAL_M) {
    banner.className = 'arrive';
    banner.textContent = `Arrived at ${activeRoute.detourTo}`;
    updateRouteCard();
    return;
  }
  if (prog && prog.offRouteM <= OFF_ROUTE_THRESHOLD_M) {
    banner.className = '';
    banner.textContent = `On route · ${Math.round(prog.offRouteM)} m from line`;
  } else {
    banner.className = 'off';
    banner.textContent = `OFF ROUTE · ${formatDistance(prog?.offRouteM ?? Infinity)} away`;
  }
  updateRouteCard();
}

/**
 * What's left of the active route from the current position: distance,
 * remaining climb, and a time estimate at the user's pace.
 */
export function remainingText(): string | null {
  const activeRoute = getActiveRoute();
  if (!lastFix || !activeRoute || !lastProg) return null;
  const coords = activeRoute.coords;

  // Away from the line, the projection is not progress. Before the walk has
  // started there is nothing to report but how far off the route is; once it
  // has, hold the last position we believed rather than jumping about.
  const prog = lastProg.offRouteM <= EN_ROUTE_THRESHOLD_M ? lastProg : lastOnRouteProg;
  if (!prog) return `Not started · ${formatDistance(lastProg.offRouteM)} to the route`;

  const cum = cumulativeDistances(coords);
  const total = cum[cum.length - 1];
  const remainingM = Math.max(0, total - prog.alongM);

  // Remaining climb and descent: only the part of the profile still ahead.
  const ahead = coords.slice(prog.index + 1);
  const { ascentM, descentM } = computeClimbs(ahead);
  const est = naismithHours(remainingM, ascentM, settings.speedKmh);

  const pct = total > 0 ? Math.round((prog.alongM / total) * 100) : 0;
  return `${formatDistance(remainingM)} to go · ${climbText(ascentM, descentM)} · ~${formatDuration(est)} · ${pct}% done`;
}

// ---------------------------------------------------------------- the watch

function onFix(pos: GeolocationPosition): void {
  const p: LatLng = [pos.coords.latitude, pos.coords.longitude];
  lastFix = p;
  lastKnownPos = p;
  lastAccuracy = pos.coords.accuracy;
  if (!gpsMarker) {
    gpsMarker = L.marker(p, { icon: gpsIcon }).addTo(map);
    // Tap your own dot for the grid reference to read out to mountain rescue.
    // Built lazily on open (from the latest fix) rather than rebuilt every
    // second, which is wasted work you never see unless the popup is showing.
    gpsMarker.bindPopup(() =>
      `<div style="font-size:13px;line-height:1.5">${lastFix ? positionText(lastFix) : ''}<br>
       <span style="color:var(--muted)">±${Math.round(lastAccuracy)} m</span></div>`
    );
    accCircle = L.circle(p, {
      radius: pos.coords.accuracy,
      color: '#1a73e8',
      weight: 1,
      fillOpacity: 0.12,
      interactive: false
    }).addTo(map);
  } else {
    gpsMarker.setLatLng(p);
    accCircle!.setLatLng(p).setRadius(pos.coords.accuracy);
  }
  // Recentre instantly: fixes arrive every second or so, and queueing a pan
  // animation per fix looks jittery and stalls entirely while backgrounded.
  if (follow) map.setView(p, Math.max(map.getZoom(), 15), { animate: false });
  updateBanner();
  onPosition?.();
}

// --- compass (heading-up) mode ---------------------------------------

let headingOn = false;
let headingHandler: ((e: DeviceOrientationEvent) => void) | null = null;
/** Newest compass reading, degrees clockwise from north. */
let targetHeading: number | null = null;
/** Smoothed heading currently drawn, chased towards the target each frame. */
let shownHeading: number | null = null;
let appliedHeading: number | null = null;
let headingFrame: number | null = null;

/** Shortest signed turn from a to b, in (-180, 180] — handles the 359°→0° wrap. */
function angleDelta(a: number, b: number): number {
  return ((b - a + 540) % 360) - 180;
}

/**
 * Redraw the bearing once per animation frame rather than once per compass
 * event, easing towards the latest reading. Following the raw sensor looks
 * jittery (it is noisy and fires irregularly); easing at display rate looks
 * like the map is simply turning with you.
 */
function headingTick(): void {
  if (targetHeading === null) {
    headingFrame = null;
    return;
  }

  if (shownHeading === null) shownHeading = targetHeading;
  else shownHeading = (shownHeading + angleDelta(shownHeading, targetHeading) * 0.25 + 360) % 360;

  if (appliedHeading === null || Math.abs(angleDelta(appliedHeading, shownHeading)) >= 0.25) {
    appliedHeading = shownHeading;
    map.setBearing(-shownHeading);
  }

  // Keep animating only while the shown heading is still catching up. Once it
  // has settled, stop the loop entirely so a still phone wakes nothing — the
  // compass handler restarts it when you actually turn.
  if (Math.abs(angleDelta(shownHeading, targetHeading)) >= 0.25) {
    headingFrame = requestAnimationFrame(headingTick);
  } else {
    shownHeading = targetHeading;
    headingFrame = null;
  }
}

async function startHeading(): Promise<boolean> {
  type DOEStatic = { requestPermission?: () => Promise<string> };
  const doe = DeviceOrientationEvent as unknown as DOEStatic;
  try {
    if (typeof doe.requestPermission === 'function') {
      if ((await doe.requestPermission()) !== 'granted') return false;
    }
  } catch {
    return false;
  }
  // Record every reading; headingTick decides how often to redraw. Restart the
  // animation loop only when it's asleep and the reading actually moved, so a
  // motionless phone keeps it idle.
  headingHandler = (e: DeviceOrientationEvent) => {
    const webkit = (e as DeviceOrientationEvent & { webkitCompassHeading?: number })
      .webkitCompassHeading;
    let reading: number | null = null;
    if (typeof webkit === 'number' && !Number.isNaN(webkit)) reading = webkit;
    else if (e.absolute && typeof e.alpha === 'number') reading = 360 - e.alpha;
    if (reading === null) return;
    targetHeading = reading;
    if (
      headingOn &&
      headingFrame === null &&
      (shownHeading === null || Math.abs(angleDelta(shownHeading, reading)) >= 0.25)
    ) {
      headingFrame = requestAnimationFrame(headingTick);
    }
  };
  window.addEventListener('deviceorientation', headingHandler);
  headingFrame = requestAnimationFrame(headingTick);
  headingOn = true;
  return true;
}

function stopHeading(): void {
  if (headingHandler) window.removeEventListener('deviceorientation', headingHandler);
  if (headingFrame !== null) cancelAnimationFrame(headingFrame);
  headingHandler = null;
  headingFrame = null;
  targetHeading = shownHeading = appliedHeading = null;
  headingOn = false;
  map.setBearing(0);
}

function stopWatch(): void {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  follow = false;
  stopHeading();
  gpsMarker?.remove();
  accCircle?.remove();
  gpsMarker = null;
  accCircle = null;
  lastFix = null;
  // lastKnownPos deliberately kept: switching following off shouldn't erase
  // where you last were, or pin distances vanish with it.
  $('btnLocate').classList.remove('active');
  $('locateIco').innerHTML = LOCATE_ICON.off;
  updateRouteStart(watchId !== null);
  updateBanner();
}

/** Start GPS following (north-up). Shared by the Me button and the card Start. */
export function beginFollow(): boolean {
  if (!('geolocation' in navigator)) {
    toast('No geolocation on this device');
    return false;
  }
  follow = true;
  $('btnLocate').classList.add('active');
  $('locateIco').innerHTML = LOCATE_ICON.follow;
  watchId = navigator.geolocation.watchPosition(onFix, (err) => {
    toast(`GPS error: ${err.message}`, 5000);
    stopWatch();
  }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
  updateRouteStart(watchId !== null);
  return true;
}

// Re-centre on the last fix and resume following, keeping the heading-up/
// north-up icon in sync with whether heading mode is currently on.
export function resumeFollow(): void {
  follow = true;
  $('locateIco').innerHTML = headingOn ? LOCATE_ICON.heading : LOCATE_ICON.follow;
  if (lastFix) map.setView(lastFix, Math.max(map.getZoom(), 15), { animate: false });
}

/**
 * Stop auto-recentring, without giving up the fix. Opening a place — a search
 * hit, a pin, a route — means "show me this", and the next fix a second later
 * used to drag the map straight back to you, which is what made opening
 * anything with Me on feel broken.
 *
 * Everything that makes GPS worth having stays: the dot, the accuracy circle,
 * the on/off-route banner, the distance still to go. Only the centring stops,
 * so you can see the place you asked for and yourself at the same time.
 * Heading-up drops back to north-up, because a map that keeps turning with
 * your body around somewhere you are not standing is just noise. The next tap
 * of Me re-centres and follows again, as it does after a drag.
 */
export function pauseFollow(): void {
  if (watchId === null) return; // not following: nothing to pause
  const wasHeading = headingOn;
  follow = false;
  stopHeading(); // no-op when already north-up; squares the map back up otherwise
  $('locateIco').innerHTML = LOCATE_ICON.follow;
  // Silent for an ordinary pause — the dot is still there and the map simply
  // stays put. Losing heading-up is the one part that visibly changes the map
  // out from under you, so say that much and no more.
  if (wasHeading) toast('Back to north-up — tap Me to follow again', 3000);
}

/**
 * Wire up the Me button and the drag-to-pause rule. The active route arrives as
 * a getter rather than a value: it is reassigned whenever one is planned, loaded
 * or closed, and it belongs to the app rather than to this feature.
 */
export function initTracking(opts: {
  settings: Settings;
  getActiveRoute: () => SavedRoute | null;
  /**
   * Called after each fix. Anything that shows a distance from you goes stale
   * as you walk, and this is the only place that knows a fix landed — but who
   * cares about that is not tracking's business, so it arrives as a callback
   * rather than as an import of the features that do.
   */
  onPosition?: () => void;
}): void {
  settings = opts.settings;
  getActiveRoute = opts.getActiveRoute;
  onPosition = opts.onPosition ?? null;

  // Tap cycle: off → follow north-up → follow heading-up → off.
  // A map drag, or opening a place, pauses following; the next tap re-centres.
  $('btnLocate').addEventListener('click', async () => {
    if (watchId === null) {
      if (beginFollow()) toast('Following you — tap again to rotate with your heading', 3000);
    } else if (!follow) {
      resumeFollow();
    } else if (!headingOn) {
      if (await startHeading()) {
        $('locateIco').innerHTML = LOCATE_ICON.heading;
        toast('Heading-up — the map turns with you. Tap again to stop.', 3000);
      } else {
        toast('Compass not available — staying north-up. Tap again to stop.', 3500);
        stopWatch();
      }
    } else {
      stopWatch();
    }
  });

  map.on('dragstart', () => {
    follow = false;
  });
}
