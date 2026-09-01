// GPS: the blue dot and its accuracy circle, the "Me" button, and everything
// derived from a fix — where you are along the active route, the on/off-route
// banner, and how much walk is left.
//
// The watch runs for the life of the session; there is no off. What the button
// means depends on where the map is: sitting on your dot it toggles north-up
// against heading-up, and anywhere else it brings you back. See locateAction.
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
import { climbText, updateRouteCard } from '../ui/routeCard';

const gpsIcon = L.divIcon({ className: '', html: '<div class="gpsDot"></div>', iconSize: [22, 22], iconAnchor: [11, 11] });

// The "Me" button shows its state through the glyph as well as the colour: a
// hollow crosshair when the map is not on you (or has no fix to be on), a
// filled one while following you north-up, and a compass arrow in heading-up.
const LOCATE_ICON = { away: svgUse('i-locate'), follow: svgUse('i-locate-on'), heading: svgUse('i-compass') };

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
 * The rotation you last asked for, which outlives the compass itself. Pausing
 * squares the map up — a map turning with your body around somewhere you are
 * not standing is noise — but forgetting that you wanted heading-up would make
 * every glance at a pin cost two taps to undo. Kept separate from headingOn,
 * which is only whether the sensor is live right now.
 */
let headingWanted = false;
/**
 * Set when the watch has given up: permission refused, or an error we stopped
 * on. The button then reads as a retry rather than as a toggle, because with no
 * off step there has to be a deliberate way back in — otherwise one timeout
 * leaves the app dotless for the rest of the walk.
 */
let gpsFailed = false;
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

/** The latest live GPS fix — null before the first one lands, and again if the
    watch fails. */
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
  const { className, text } = bannerFor(lastFix, activeRoute, prog);
  banner.className = className;
  banner.textContent = text;
  updateRouteCard();
}

/**
 * What the banner should say about where you are relative to the active route.
 *
 * Split out from updateBanner because the interesting part is the precedence,
 * not the DOM underneath it, and precedence is worth being able to test: get it
 * wrong and someone standing at the tarn they asked for is told they are off
 * route. Everything above is the state a fix leaves behind; this is only a
 * reading of it, so it takes what it needs and touches nothing.
 */
export function bannerFor(
  fix: LatLng,
  route: SavedRoute,
  prog: RouteProgress | null
): { className: string; text: string } {
  // Arriving where a set of directions was leading outranks anything the line
  // has to say: at the lake you asked for, "OFF ROUTE" is technically true and
  // completely unhelpful. Measured to the destination rather than along the
  // route, because the router stops where the path does, not where you stand.
  if (route.detourTo && haversine(fix, route.coords[route.coords.length - 1]) <= ARRIVAL_M) {
    return { className: 'arrive', text: `Arrived at ${route.detourTo}` };
  }
  if (prog && prog.offRouteM <= OFF_ROUTE_THRESHOLD_M) {
    return { className: '', text: `On route · ${Math.round(prog.offRouteM)} m from line` };
  }
  return {
    className: 'off',
    text: `OFF ROUTE · ${formatDistance(prog?.offRouteM ?? Infinity)} away`
  };
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
    // The first fix is what turns "searching" into "the map is on you", and it
    // is the only fix that changes how the button looks — the rest just move
    // a dot that is already there.
    paintLocate();
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

// ---------------------------------------------------------------- the button

/**
 * Repaint the Me button from the state it is in. Every path that changes
 * following, rotation or the health of the watch ends here, so the glyph can
 * never drift from what the map is actually doing — which is exactly how a
 * drag used to leave a lit compass over a map that had stopped turning.
 */
function paintLocate(): void {
  const btn = $('btnLocate');
  const centred = follow && (headingOn || !!lastFix);
  btn.classList.toggle('active', centred && !gpsFailed);
  btn.classList.toggle('failed', gpsFailed);
  $('locateIco').innerHTML = gpsFailed
    ? LOCATE_ICON.away
    : follow && headingOn
      ? LOCATE_ICON.heading
      : centred
        ? LOCATE_ICON.follow
        : LOCATE_ICON.away;
}

/** What a tap of Me should do. See locateAction. */
export type LocateAction = 'retry' | 'recentre' | 'heading-up' | 'north-up';

/**
 * What a tap means in the state the button is in.
 *
 * Split out from the click handler for the same reason bannerFor was split out
 * of updateBanner: the precedence is the whole point and the DOM underneath it
 * is not. Getting it wrong is not cosmetic — a tap that toggled rotation when
 * the walker meant "take me back" leaves them looking at a spinning map of
 * somewhere they are not.
 *
 * The order is the rule: a broken watch outranks everything, then coming back
 * to your dot outranks rotating, because a rotation you cannot see the point of
 * is not what you tapped for. Note what is absent — no tap leads to GPS off.
 */
export function locateAction(state: {
  failed: boolean;
  follow: boolean;
  headingOn: boolean;
}): LocateAction {
  if (state.failed) return 'retry';
  if (!state.follow) return 'recentre';
  return state.headingOn ? 'north-up' : 'heading-up';
}

// ---------------------------------------------------------------- the watch's life

/**
 * Give up on GPS: clear the watch, drop the dot, and leave the button reading
 * as a retry. Only errors get here — there is no tap that switches Me off.
 */
function failWatch(): void {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  follow = false;
  gpsFailed = true;
  stopHeading();
  gpsMarker?.remove();
  accCircle?.remove();
  gpsMarker = null;
  accCircle = null;
  lastFix = null;
  // lastKnownPos deliberately kept: losing the watch shouldn't erase where you
  // last were, or pin distances vanish with it.
  paintLocate();
  updateBanner();
}

/**
 * Start (or restart) the GPS watch, following north-up. Called once at startup
 * and again by a tap of the button after a failure.
 */
function startWatch(): boolean {
  if (watchId !== null) return true;
  if (!('geolocation' in navigator)) {
    gpsFailed = true;
    paintLocate();
    toast('No geolocation on this device');
    return false;
  }
  gpsFailed = false;
  follow = true;
  paintLocate();
  watchId = navigator.geolocation.watchPosition(onFix, (err) => {
    toast(`GPS error: ${err.message} — tap Me to try again`, 5000);
    failWatch();
  }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
  return true;
}

/**
 * Re-centre on your dot and resume following, restoring heading-up if that is
 * the rotation you were in when the map was last on you. One tap puts you back
 * where you were rather than two.
 */
async function resumeFollow(): Promise<void> {
  follow = true;
  if (lastFix) map.setView(lastFix, Math.max(map.getZoom(), 15), { animate: false });
  // Restore the compass before painting, so the glyph lands on its final state
  // rather than flicking through north-up on the way.
  if (headingWanted && !headingOn) await startHeading();
  paintLocate();
}

/**
 * Stop auto-recentring, without giving up the fix. Opening a place — a search
 * hit, a pin, a route — means "show me this", and the next fix a second later
 * used to drag the map straight back to you, which is what made opening
 * anything with Me on feel broken. A map drag says the same thing.
 *
 * Everything that makes GPS worth having stays: the dot, the accuracy circle,
 * the on/off-route banner, the distance still to go. Only the centring stops,
 * so you can see the place you asked for and yourself at the same time.
 * Heading-up drops back to north-up, because a map that keeps turning with
 * your body around somewhere you are not standing is just noise — but the
 * wanting of it is remembered, so the tap that brings you back brings the
 * rotation back with it.
 */
export function pauseFollow(): void {
  if (watchId === null || !follow) return; // not following: nothing to pause
  const wasHeading = headingOn;
  follow = false;
  stopHeading(); // no-op when already north-up; squares the map back up otherwise
  paintLocate();
  // Silent for an ordinary pause — the dot is still there and the map simply
  // stays put. Losing heading-up is the one part that visibly changes the map
  // out from under you, so say that much and no more.
  if (wasHeading) toast('Back to north-up — tap Me to follow again', 3000);
}

/**
 * Wire up the Me button and the drag-to-pause rule, and start the watch. The
 * active route arrives as a getter rather than a value: it is reassigned
 * whenever one is planned, loaded or closed, and it belongs to the app rather
 * than to this feature.
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

  $('btnLocate').addEventListener('click', async () => {
    switch (locateAction({ failed: gpsFailed, follow, headingOn })) {
      case 'retry':
        startWatch();
        break;
      case 'recentre':
        await resumeFollow();
        break;
      case 'heading-up':
        headingWanted = true;
        if (await startHeading()) {
          toast('Heading-up — the map turns with you. Tap again for north-up.', 3000);
        } else {
          // The compass is the only thing that failed. Staying north-up costs
          // the walker nothing they had; taking the dot away would.
          headingWanted = false;
          toast('Compass not available — staying north-up', 3500);
        }
        paintLocate();
        break;
      case 'north-up':
        headingWanted = false;
        stopHeading();
        paintLocate();
        break;
    }
  });

  // A drag is the same "show me this instead" as opening a place, and goes
  // through the same door — which is what keeps the button honest about
  // whether the map is still turning with you.
  map.on('dragstart', pauseFollow);

  // No first tap to wait for: the map is on you from the moment it can be.
  // The startup one-shot in map/map.ts has already asked for permission, so
  // this adds no prompt of its own.
  startWatch();
}
