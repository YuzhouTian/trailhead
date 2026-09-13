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
  haversine,
  projectOnPolyline,
  type LatLng,
  type RouteProgress
} from '../geo';
import { map } from '../map/map';
import { type SavedRoute } from '../state';
import { $, svgUse, toast } from '../ui/dom';
import { positionText } from '../ui/format';
import { updateRouteCard, type WalkProgress } from '../ui/routeCard';

const gpsIcon = L.divIcon({ className: '', html: '<div class="gpsDot"></div>', iconSize: [22, 22], iconAnchor: [11, 11] });

// The "Me" button carries two facts in two channels, because they now vary
// independently: the glyph says which way the map is pointing (crosshair for
// north-up, compass arrow while it turns with you) and the colour says whether
// the map is on you (lit while following, muted once you have moved it off).
// A muted arrow — where a drag in heading-up leaves you — is then readable as
// the thing it is: still turning with you, no longer on you, tap to come back.
// The crosshair's filled centre says the same as the colour and predates it;
// kept as the redundancy it is, since one glyph is no worse for having two.
const LOCATE_ICON = { away: svgUse('i-locate'), follow: svgUse('i-locate-on'), heading: svgUse('i-compass') };

// How far in coming back to your dot zooms, when you were further out than
// this. Close enough to see which path you are on; matched by the startup
// recentre in map/map.ts so both landings sit at the same scale.
const FOLLOW_ZOOM = 15;

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
 * Set when following (re)starts and spent by the first fix that acts on it:
 * the recentre that brings you back may zoom in, and the ones that merely keep
 * up with you may not.
 *
 * Zooming on every fix was the bug. Coming back to your dot from a whole-UK
 * view has to close the distance or "Me" lands you on a scale that shows you
 * nothing — but re-applying that floor a second later, and every second
 * after, meant a walker who zoomed out while being followed had the wider view
 * taken off them before they could read it.
 */
let zoomInOnNextFix = false;
/**
 * Set when the watch has given up, which only a refused permission does. The
 * button then reads as a retry rather than as a toggle, because with no off
 * step there has to be a deliberate way back in.
 */
let gpsFailed = false;
/**
 * Set by a timeout or an unavailable position, and cleared by the next fix.
 * Those are a lost signal, not a refusal — under trees, indoors, or a desktop
 * whose location service is slow to answer — so the watch keeps going and the
 * dot stays where you last were. Tracked only so a long outage says so once
 * rather than every thirty seconds.
 */
let signalLost = false;
/** The pending restart after a lost signal, so a retry or a failure can cancel it. */
let restartTimer: ReturnType<typeof setTimeout> | null = null;

/** How long to wait after a lost signal before asking the device again. */
const RESTART_MS = 5000;
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
  // route card's progress so both stay consistent and continuous.
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

// ---------------------------------------------------------------- per-route sums
//
// The readout below runs on every fix, about once a second, but neither the
// route's length nor the climb beyond a given point changes while you walk. So
// both are kept for the route they were worked out for, and reused until it is
// a different route. Keyed by the coords array itself: a planned, loaded or
// shared route always arrives as a new one, so identity is exactly "the same
// walk", and nothing has to remember to clear these.

let lengthFor: LatLng[] | null = null;
let lengthM = 0;

/** The route's whole length, measured once per route. */
function routeLengthM(coords: LatLng[]): number {
  if (coords !== lengthFor) {
    const cum = cumulativeDistances(coords);
    lengthM = cum[cum.length - 1];
    lengthFor = coords;
  }
  return lengthM;
}

let climbsFor: LatLng[] | null = null;
let climbsFrom = -1;
let climbs = { ascentM: 0, descentM: 0 };

/**
 * Climb and descent from point `from` to the end. Worked out again only when
 * you pass a point of the route — every ten metres or so rather than every
 * fix. Not a table built up front: the 5 m noise rule means the climb beyond a
 * point is not simply the total minus the climb before it, and getting it
 * exactly right for every point would cost the whole route per point.
 */
function climbsAhead(coords: LatLng[], from: number): { ascentM: number; descentM: number } {
  if (coords !== climbsFor || from !== climbsFrom) {
    climbs = computeClimbs(coords, from);
    climbsFor = coords;
    climbsFrom = from;
  }
  return climbs;
}

/**
 * How far along the active route you are, for the route card to lay out: the
 * figures rather than a sentence, since the card shows them in separate cells.
 */
export function walkProgress(): WalkProgress | null {
  const activeRoute = getActiveRoute();
  if (!lastFix || !activeRoute || !lastProg) return null;
  const coords = activeRoute.coords;

  // Away from the line, the projection is not progress. Before the walk has
  // started there is nothing to report but how far off the route is; once it
  // has, hold the last position we believed rather than jumping about.
  const prog = lastProg.offRouteM <= EN_ROUTE_THRESHOLD_M ? lastProg : lastOnRouteProg;
  if (!prog) return { started: false, toRouteM: lastProg.offRouteM };

  const totalM = routeLengthM(coords);
  // Remaining climb and descent: only the part of the profile still ahead.
  const { ascentM, descentM } = climbsAhead(coords, prog.index + 1);
  return {
    started: true,
    walkedM: Math.min(prog.alongM, totalM),
    totalM,
    remainingM: Math.max(0, totalM - prog.alongM),
    ascentM,
    descentM
  };
}

// ---------------------------------------------------------------- the watch

function onFix(pos: GeolocationPosition): void {
  const p: LatLng = [pos.coords.latitude, pos.coords.longitude];
  signalLost = false;
  lastFix = p;
  lastKnownPos = p;
  lastAccuracy = pos.coords.accuracy;
  if (!gpsMarker) {
    gpsMarker = L.marker(p, { icon: gpsIcon }).addTo(map);
    // Tap your own dot for the grid reference to read out to mountain rescue.
    // Built lazily on open (from the latest fix) rather than rebuilt every
    // second, which is wasted work you never see unless the popup is showing.
    gpsMarker.bindPopup(() =>
      `<div class="mapPop">${lastFix ? positionText(lastFix) : ''}<br>
       <span class="sub">±${Math.round(lastAccuracy)} m</span></div>`
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
  // The zoom is the map's own except on the fix that follows a resume, which
  // is the one allowed to bring you in.
  if (follow) {
    const zoom = zoomInOnNextFix ? Math.max(map.getZoom(), FOLLOW_ZOOM) : map.getZoom();
    zoomInOnNextFix = false;
    map.setView(p, zoom, { animate: false });
  }
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
 * following, rotation or the health of the watch ends here, so neither channel
 * can drift from what the map is actually doing.
 *
 * The glyph follows the rotation alone. It deliberately does not ask whether
 * the map is on you: a map panned off you in heading-up is still turning with
 * your body, and a crosshair there would deny something the walker can watch
 * happening. Centring is the colour's to say.
 */
function paintLocate(): void {
  const btn = $('btnLocate');
  const centred = follow && (headingOn || !!lastFix);
  btn.classList.toggle('active', centred && !gpsFailed);
  btn.classList.toggle('failed', gpsFailed);
  $('locateIco').innerHTML = gpsFailed
    ? LOCATE_ICON.away
    : headingOn
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

/** Ask the device for positions, replacing any watch already running. */
function openWatch(): void {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = navigator.geolocation.watchPosition(onFix, onWatchError, {
    enableHighAccuracy: true,
    maximumAge: 2000,
    timeout: 30000
  });
}

/**
 * Only a refused permission is final. A timeout or an unavailable position
 * used to be treated the same way, which took the dot away and left Me doing
 * nothing visible until a fix came back — on a desktop, whose location answers
 * slowly, that could be a minute of a map that seemed to have lost you.
 *
 * So a lost signal keeps everything the walker had: the dot at the last fix,
 * following, the banner. The watch is reopened after a pause rather than
 * trusted to carry on by itself, since browsers disagree on whether a watch
 * survives its own timeout.
 */
function onWatchError(err: GeolocationPositionError): void {
  if (err.code === 1 /* PERMISSION_DENIED */) {
    toast(`GPS error: ${err.message} — tap Me to try again`, 5000);
    failWatch();
    return;
  }
  if (!signalLost) toast('GPS signal lost — still trying', 3500);
  signalLost = true;
  if (restartTimer !== null) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (watchId !== null) openWatch();
  }, RESTART_MS);
}

/**
 * Give up on GPS: clear the watch, drop the dot, and leave the button reading
 * as a retry. Only a refused permission gets here — there is no tap that
 * switches Me off.
 */
function failWatch(): void {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  if (restartTimer !== null) clearTimeout(restartTimer);
  restartTimer = null;
  signalLost = false;
  watchId = null;
  follow = false;
  zoomInOnNextFix = false;
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
  zoomInOnNextFix = true;
  paintLocate();
  openWatch();
  return true;
}

/**
 * Re-centre on your dot and resume following. The rotation needs no restoring:
 * it was never taken away, so a tap that comes back in heading-up comes back
 * heading-up, and the tap after it is the one that squares the map to north.
 */
function resumeFollow(): void {
  follow = true;
  // Zoom in now if there is somewhere to zoom in on, and otherwise on the fix
  // that arrives next — either way once, not once a second.
  if (lastFix) map.setView(lastFix, Math.max(map.getZoom(), FOLLOW_ZOOM), { animate: false });
  else zoomInOnNextFix = true;
  paintLocate();
}

/**
 * Stop auto-recentring, without giving up the fix. Opening a place — a search
 * hit, a pin, a route — means "show me this", and the next fix a second later
 * used to drag the map straight back to you, which is what made opening
 * anything with Me on feel broken. A drag of the map says the same thing, and
 * so does a zoom of it — see the two rules wired up in initTracking.
 *
 * Centring is the whole of what stops. The dot, the accuracy circle, the
 * on/off-route banner, the distance still to go and the rotation all stay, so
 * you can see the place you asked for and yourself at the same time.
 *
 * The rotation staying is the point. Dragging up the valley to see what is
 * ahead is still looking at the ground you are standing on, from the direction
 * you are facing, and up-is-forward is worth most exactly then — squaring the
 * map to north under your thumb took away the one thing that made the look
 * worth taking. It costs nothing to keep: the map turning while you are panned
 * off yourself is still turning with your body, which is true wherever the map
 * happens to be pointed. So this is silent — nothing has changed that the
 * walker cannot see, and the button says the rest.
 */
export function pauseFollow(): void {
  if (watchId === null || !follow) return; // not following: nothing to pause
  follow = false;
  zoomInOnNextFix = false;
  paintLocate();
}

/**
 * How long after a hand lands on the map a zoom still counts as that hand's.
 * Long enough to cover the slowest of them — a tap of the +/- control zooms
 * on the click, a frame or two after the finger went down — and short enough
 * that a zoom arriving later is plainly not what the hand was for.
 */
const GESTURE_MS = 700;

/** When a finger, a pointer or a wheel was last on the map itself. */
let handOnMapAt = 0;

/**
 * Wire up the Me button and the two look-around-to-pause rules, and start the
 * watch. The active route arrives as a getter rather than a value: it is
 * reassigned whenever one is planned, loaded or closed, and it belongs to the
 * app rather than to this feature.
 */
export function initTracking(opts: {
  getActiveRoute: () => SavedRoute | null;
  /**
   * Called after each fix. Anything that shows a distance from you goes stale
   * as you walk, and this is the only place that knows a fix landed — but who
   * cares about that is not tracking's business, so it arrives as a callback
   * rather than as an import of the features that do.
   */
  onPosition?: () => void;
}): void {
  getActiveRoute = opts.getActiveRoute;
  onPosition = opts.onPosition ?? null;

  $('btnLocate').addEventListener('click', async () => {
    switch (locateAction({ failed: gpsFailed, follow, headingOn })) {
      case 'retry':
        startWatch();
        break;
      case 'recentre':
        resumeFollow();
        break;
      case 'heading-up':
        if (await startHeading()) {
          toast('Heading-up — the map turns with you. Tap again for north-up.', 3000);
        } else {
          // The compass is the only thing that failed. Staying north-up costs
          // the walker nothing they had; taking the dot away would.
          toast('Compass not available — staying north-up', 3500);
        }
        paintLocate();
        break;
      case 'north-up':
        stopHeading();
        paintLocate();
        break;
    }
  });

  // A drag is the same "show me this instead" as opening a place, and goes
  // through the same door — which is what keeps the button honest about
  // whether the map is still turning with you.
  map.on('dragstart', pauseFollow);

  // A zoom says it too. Pinching out to see where the ridge goes is looking
  // away from yourself exactly as a drag is, and leaving follow on there was
  // the worse of the two: the next fix a second later hauled the map back to
  // the dot *and* threw the zoom away with it — following used to re-assert
  // its minimum zoom on every fix — so a wider view was not something you
  // could get at all. See zoomInOnNextFix for the other half of that.
  //
  // Zoom is harder to read than a drag, because dragstart is only ever a
  // thumb while zoomstart is fired by the app's own zooms too — the startup
  // jump to your area, the clamp after a base layer with a shallower maximum
  // is chosen, and following's own recentre from a wide view in to 15. Pausing
  // on those would drop follow with nothing on screen to explain it.
  //
  // A hand tells them apart. Every zoom the walker can start — pinch, the
  // double-tap-drag gesture, the +/- control, a wheel on a desktop — begins
  // with a touch, pointer or wheel on the map itself, and none of the app's
  // own zooms do: the Me button, the panels and Settings all sit outside the
  // map element, and the startup recentre already stands down the moment you
  // touch the map. So a zoom is yours if your hand was just on the map.
  //
  // Getting it wrong is cheap in one direction only. A gesture missed leaves
  // the map following you, which is where it already was; a recentre mistaken
  // for a gesture turns Me off for no reason the walker can see. Hence the
  // short window, and hence reading the hand rather than guessing from the
  // zoom. Capture and passive: this only ever watches, and must not be
  // stoppable by a handler closer to the target.
  const container = map.getContainer();
  const handOnMap = (): void => { handOnMapAt = Date.now(); };
  for (const type of ['touchstart', 'pointerdown', 'wheel']) {
    container.addEventListener(type, handOnMap, { capture: true, passive: true });
  }
  map.on('zoomstart', () => {
    if (Date.now() - handOnMapAt <= GESTURE_MS) pauseFollow();
  });

  // No first tap to wait for: the map is on you from the moment it can be.
  // The startup one-shot in map/map.ts has already asked for permission, so
  // this adds no prompt of its own.
  startWatch();
}
