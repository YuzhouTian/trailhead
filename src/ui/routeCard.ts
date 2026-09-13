// The active-route card: the strip along the bottom that names the route,
// totals its distance and climb, says how much is left, and opens the
// elevation profile. It is shared — a saved, shared or detour route all show
// here, and tracking fills it with progress along the one you are walking — so
// it deliberately knows about none of them. (A route still being planned is not
// one of them: Plan's sheet carries its own stats and profile.) Callers describe what to show as a
// RouteCardView; this module turns that into DOM and owns nothing else.
//
// The one thing it draws on the map is the scrub marker: the dot that follows
// your finger along the elevation chart. It belongs to the chart, so it lives
// and dies with the card rather than with any feature.

import L from '../leaflet-setup';
import { moveHere, renderProfile, type Scrub } from '../elevation';
import { distanceParts, naismithHours, shortDuration, type LatLng } from '../geo';
import { map } from '../map/map';
import { $ } from './dom';

/** The minimum a thing needs to be shown on the card. */
export interface RouteCardSource {
  coords: LatLng[];
  distanceM: number;
  ascentM: number;
  descentM?: number;
}

/** How far along the route you are, as tracking measures it from the latest fix. */
export type WalkProgress =
  /** There is a fix, but it has never been on the line: how far off it is. */
  | { started: false; toRouteM: number }
  | {
      started: true;
      walkedM: number;
      totalM: number;
      remainingM: number;
      /** Climb and descent still ahead, not the route's totals. */
      ascentM: number;
      descentM: number;
    };

/** Everything the card draws, gathered by the caller at render time. */
export interface RouteCardView {
  /** The route-like thing to display, or null to hide the card entirely. */
  src: RouteCardSource | null;
  /** Title line — the route's name. */
  name: string;
  /** Where you are along it, or null when there is nothing believable to say. */
  progress: WalkProgress | null;
  /** Metres along the route to mark as "you are here" on the profile, if known. */
  hereM: number | null;
  /** Walking pace for the time estimate. */
  speedKmh: number;
}

/** "↑ 180 m · ↓ 120 m" — the climb half of a route's stats line. */
export function climbText(ascentM: number, descentM?: number): string {
  let s = `↑ ${Math.round(ascentM)} m`;
  if (descentM !== undefined && Math.round(descentM) > 0) s += ` · ↓ ${Math.round(descentM)} m`;
  return s;
}

let getView: () => RouteCardView;
let chartOpen = false;
let scrubMarker: L.CircleMarker | null = null;
// Where the chart's scrubber was left, in metres along the route. Held here
// rather than in the chart because the chart is thrown away and redrawn now and
// then — a turned phone, a new route — and a marker that vanished whenever that
// happened would be no use for reading the map.
let scrubM: number | null = null;
// The coords the chart currently shows. A new route — or an edited plan — is a
// different walk, so the scrubber from the old one is dropped rather than
// reappearing at the same distance along something else.
let scrubCoords: LatLng[] | null = null;
// The route whose chart came back empty: no elevation to draw. Remembered so a
// route without heights does not try, and fail, all over again on every fix.
let noProfileFor: LatLng[] | null = null;

function onProfileScrub(scrub: Scrub | null): void {
  scrubM = scrub?.alongM ?? null;
  if (!scrub) {
    scrubCoords = null;
    scrubMarker?.remove();
    scrubMarker = null;
    return;
  }
  const pos = scrub.pos;
  if (!scrubMarker) {
    scrubMarker = L.circleMarker(pos, {
      radius: 7,
      color: '#d8303c',
      weight: 3,
      fillColor: '#fff',
      fillOpacity: 1,
      interactive: false
    }).addTo(map);
  } else {
    scrubMarker.setLatLng(pos);
  }
}

/**
 * How much more than the card's own height the furniture above it has to rise.
 * The card no longer starts at the top of the tab bar: it floats 8px above a
 * 56px bar, while the scale bar's resting offset is 50px, so 14px of the
 * margin simply buys back the difference and the remaining 10px is the gap you
 * actually see between the card's top edge and the scale bar.
 * Was 12 when the card was an edge-to-edge strip sitting directly on the bar.
 */
const LIFT_MARGIN = 24;

/**
 * Publish the active-route card's height so the bottom-anchored map furniture
 * can clear it (see --card-lift in style.css). The card is not a fixed size —
 * it grows with the elevation chart and the progress bar, and reflows on
 * rotation — so a hard-coded offset left the scale bar and the locate button
 * buried under a tall card. Measuring is the only thing that tracks all three.
 */
function publishCardLift(): void {
  const card = $('routeCard');
  const h = card.classList.contains('hidden') ? 0 : card.getBoundingClientRect().height;
  document.documentElement.style.setProperty('--card-lift', h ? `${Math.round(h) + LIFT_MARGIN}px` : '0px');
}

/** Refresh the card from the plan in progress or the active route. */
export function updateRouteCard(): void {
  const view = getView();
  const src = view.src;
  const card = $('routeCard');
  if (!src) {
    card.classList.add('hidden');
    publishCardLift(); // hidden, so this measures nothing
    forgetChart();
    return;
  }
  card.classList.remove('hidden');
  setText('rcName', view.name);
  renderStats(src, view.progress, view.speedKmh);
  $('rcChart').classList.toggle('active', chartOpen);
  const chart = $('elevChart');
  if (chartOpen) {
    chart.classList.remove('hidden');
    if (scrubCoords && scrubCoords !== src.coords) onProfileScrub(null);
    // Only mark a position we actually believe: hereM is null until a fix lands
    // near the line, so the dot never appears at a guessed place.
    //
    // Most calls are a GPS fix on a chart already drawn for this route, and all
    // that changes is where you are, so only the mark moves. The full draw is
    // for a new route, a new width, or a chart just opened.
    if (noProfileFor === src.coords || moveHere(chart, src.coords, view.hereM)) {
      // Nothing to draw, or nothing more to draw.
    } else if (renderProfile(chart, src.coords, onProfileScrub, view.hereM, scrubM)) {
      scrubCoords = src.coords;
    } else {
      chart.innerHTML = '<p class="hint">No elevation data for this route.</p>';
      noProfileFor = src.coords;
      onProfileScrub(null);
    }
  } else {
    chart.classList.add('hidden');
    forgetChart();
  }
  // No publishCardLift() here: the ResizeObserver in initRouteCard publishes
  // whenever the card's height changes, and a call here on every fix forced a
  // layout to measure a height that had not changed.
}

/**
 * Write text only when it differs. The card is redrawn on every fix, and on
 * most of them no figure on it has moved; an unchanged write still dirties
 * the layout.
 */
function setText(id: string, text: string): void {
  const el = $(id);
  if (el.textContent !== text) el.textContent = text;
}

const metric = (m: number): string => distanceParts(m)[0];
const upText = (m: number): string => `↑ ${Math.round(m)} m`;
const downText = (m = 0): string => (Math.round(m) > 0 ? `↓ ${Math.round(m)} m` : '');

function setCell(n: 'Dist' | 'Up' | 'Time', label: string, value: string, sub: string): void {
  const subId = { Dist: 'rcDistSub', Up: 'rcDown', Time: 'rcTimeSub' }[n];
  setText(`rc${n}K`, label);
  setText(`rc${n}`, value);
  setText(subId, sub);
}

/**
 * The progress bar and the three cells. With nothing to measure from they are
 * the route's totals, exactly as Plan's sheet showed them; once you are on the
 * line they turn to what is left, and the bar says how far you have come.
 * Before the walk starts the bar is already there, empty, so the card does not
 * jump taller at the moment you reach the path.
 */
function renderStats(src: RouteCardSource, progress: WalkProgress | null, speedKmh: number): void {
  const totalHours = naismithHours(src.distanceM, src.ascentM, speedKmh);
  const walk = progress?.started ? progress : null;

  $('rcProgress').classList.toggle('hidden', !progress);
  if (progress) {
    const pct = walk && walk.totalM > 0 ? Math.min(100, Math.round((walk.walkedM / walk.totalM) * 100)) : 0;
    const fill = $('rcTrackFill');
    if (fill.style.width !== `${pct}%`) fill.style.width = `${pct}%`;
    const track = $('rcTrack');
    if (track.getAttribute('aria-valuenow') !== String(pct)) track.setAttribute('aria-valuenow', String(pct));
    setText('rcWalked', progress.started ? `${metric(progress.walkedM)} walked` : 'Not started');
    setText('rcOf', progress.started ? `${pct}% of ${metric(progress.totalM)}` : `${metric(progress.toRouteM)} to the route`);
  }

  if (walk) {
    const [km, mi] = distanceParts(walk.remainingM);
    setCell('Dist', 'To go', km, mi);
    setCell('Up', 'Climb left', upText(walk.ascentM), downText(walk.descentM));
    const leftHours = naismithHours(walk.remainingM, walk.ascentM, speedKmh);
    setCell('Time', 'Time left', shortDuration(leftHours), `of ${shortDuration(totalHours)}`);
  } else {
    const [km, mi] = distanceParts(src.distanceM);
    setCell('Dist', 'Distance', km, mi);
    setCell('Up', 'Climb', upText(src.ascentM), downText(src.descentM));
    setCell('Time', 'Time', shortDuration(totalHours), `at ${speedKmh} km/h`);
  }
}

/**
 * Drop the chart and its scrubber together, whenever the chart goes out of
 * sight — closed, or the card hidden. The scrubber is forgotten either way, so
 * a chart left in place would come back (the same saved route loaded again, the
 * profile reopened) still showing a red mark with no dot on the map to match.
 * Emptied, it is drawn afresh the next time it is shown.
 */
function forgetChart(): void {
  const chart = $('elevChart');
  if (chart.firstChild) chart.replaceChildren();
  noProfileFor = null;
  onProfileScrub(null);
}

/**
 * Wire the card up. `getView` is read on every render rather than captured
 * once, because everything it describes — the plan, the active route, the
 * latest fix — changes underneath us between renders.
 */
export function initRouteCard(opts: {
  getView: () => RouteCardView;
  /** The × button: the app decides what closing a route means. */
  onClose: () => void;
}): void {
  getView = opts.getView;

  new ResizeObserver(publishCardLift).observe($('routeCard'));

  $('rcChart').addEventListener('click', () => {
    chartOpen = !chartOpen;
    updateRouteCard();
  });
  $('rcClose').addEventListener('click', opts.onClose);
}
