// The active-route card: the strip along the bottom that names the route,
// totals its distance and climb, says how much is left, and opens the
// elevation profile. It is shared — a saved, shared or detour route all show
// here, and tracking fills it with progress along the one you are walking — so
// it deliberately knows about none of them. (A route still being planned is not
// one of them: Plan's sheet carries its own stats and profile.) Callers describe what to show as a
// RouteCardView; this module turns that into DOM and owns nothing else.
//
// It can be minimised to a chip in the bottom-left corner — one figure and a
// progress ring — for when the map matters more than the numbers. That is the
// card's own state, not the app's: nothing else needs to know which form it
// is in, beyond the locate button reading where it now has to sit.
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
  /** How far off the line you are while the banner says you are off route, else null. */
  offRouteM: number | null;
  /** The route line's colour, which the scrubber's ring on the map matches. */
  routeColour: string;
}

/** "↑ 180 m · ↓ 120 m" — the climb half of a route's stats line. */
export function climbText(ascentM: number, descentM?: number): string {
  let s = `↑ ${Math.round(ascentM)} m`;
  if (descentM !== undefined && Math.round(descentM) > 0) s += ` · ↓ ${Math.round(descentM)} m`;
  return s;
}

let getView: () => RouteCardView;
let chartOpen = false;
let minimised = false;
// The route the card was minimised on. A different route opens in full, so its
// name and totals are seen at least once; the same one shown again — after a
// spell in Plan, say — stays as it was left.
let minimisedFor: LatLng[] | null = null;
// True for the length of a minimise or expand. The card's height is animated
// frame by frame then, and none of those in-between heights is one the locate
// button should chase.
let morphing = false;
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
      color: getView().routeColour,
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
 * The gap between the card's top edge and the locate button above it. The
 * button rests at the card's own offset from the tab bar, so this is all the
 * lift adds beyond the card's height.
 * Was 24 while the scale bar sat between the two and needed room of its own.
 */
const LIFT_MARGIN = 12;

/**
 * Publish the active-route card's height so the locate button can clear it
 * (see --card-lift in style.css). The card is not a fixed size — it grows with
 * the elevation chart and the progress bar, and reflows on rotation — so a
 * hard-coded offset left the button buried under a tall card. Measuring is the
 * only thing that tracks all three. Minimised, the card is beside the button
 * rather than under it, so there is nothing to clear.
 */
function publishCardLift(): void {
  const card = $('routeCard');
  const under = !card.classList.contains('hidden') && !card.classList.contains('min');
  const h = under ? card.getBoundingClientRect().height : 0;
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
  if (minimised && src.coords !== minimisedFor) minimised = false;
  card.classList.toggle('min', minimised);
  setAttr('rcMin', 'aria-expanded', String(!minimised));
  setAttr('rcChip', 'aria-expanded', String(!minimised));
  setText('rcName', view.name);
  renderStats(src, view.progress, view.speedKmh);
  renderChip(src, view.progress, view.speedKmh, view.offRouteM);
  $('rcChart').classList.toggle('active', chartOpen);
  const chart = $('elevChart');
  // Minimised, the chart is out of sight, so it goes the way a closed one does
  // — its scrubber off the map with it — and is drawn afresh on the way back.
  if (chartOpen && !minimised) {
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

/** The same, for an attribute. */
function setAttr(id: string, name: string, value: string): void {
  const el = $(id);
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
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

/** Length of the ring's circle (r = 17 in index.html), for its dash pattern. */
const RING_C = 2 * Math.PI * 17;

/**
 * The minimised chip: one headline figure, a line under it, and progress as a
 * ring. Which figure leads follows the card's own cells — what is left once
 * you are walking, the route's totals before — except off the line mid-walk,
 * where the one thing worth saying is that you have left it.
 */
function renderChip(src: RouteCardSource, progress: WalkProgress | null, speedKmh: number, offRouteM: number | null): void {
  const walk = progress?.started ? progress : null;
  const off = walk !== null && offRouteM !== null;
  const pct = walk && walk.totalM > 0 ? Math.min(100, Math.round((walk.walkedM / walk.totalM) * 100)) : 0;

  let value: string;
  let sub: string;
  if (off) {
    value = 'Off route';
    // Kilometres alone: the banner above already gives the miles, and the
    // chip has a thumb's width to say it in.
    sub = Number.isFinite(offRouteM) ? `${metric(offRouteM)} away` : '';
  } else if (walk) {
    value = metric(walk.remainingM);
    sub = `to go · ${shortDuration(naismithHours(walk.remainingM, walk.ascentM, speedKmh))}`;
  } else if (progress && !progress.started) {
    value = metric(src.distanceM);
    sub = `${metric(progress.toRouteM)} to the route`;
  } else {
    value = metric(src.distanceM);
    sub = `${upText(src.ascentM)} · ${shortDuration(naismithHours(src.distanceM, src.ascentM, speedKmh))}`;
  }
  setText('rcChipV', value);
  setText('rcChipS', sub);
  setText('rcRingMark', off ? '!' : `${pct}%`);
  $('rcRing').classList.toggle('noProgress', !progress);
  $('routeCard').classList.toggle('off', off);
  const dash = `${((pct / 100) * RING_C).toFixed(1)} ${RING_C.toFixed(1)}`;
  const arc = $('rcRingArc');
  if (arc.style.strokeDasharray !== dash) arc.style.strokeDasharray = dash;
  setAttr('rcChip', 'aria-label', `Expand route card: ${value}${sub ? `, ${sub}` : ''}`);
}

/** How long the outgoing contents take to fade before the box starts to move. */
const FADE_MS = 110;
/** How long the box takes to change shape. Matches #btnLocate's transition. */
const MORPH_MS = 280;
const EASE = 'cubic-bezier(.2,.8,.2,1)';

/**
 * Minimise the card to its chip, or bring it back.
 *
 * Swapping the two outright would make the card blink from one shape to the
 * other, which reads as something going wrong rather than something put away.
 * So it is done in three beats: what is showing fades out, the box changes
 * shape between where it was and where it is going (measured, since the card's
 * height depends on the chart and the progress bar), and the new contents fade
 * in as it lands. The locate button moves at the same time, on the same curve,
 * since it rides on the card's height. With reduced motion asked for, or no
 * Web Animations in the browser, the swap is immediate.
 */
async function setMinimised(min: boolean): Promise<void> {
  if (min === minimised || morphing) return;
  const card = $('routeCard');
  const outgoing = $(min ? 'rcFull' : 'rcChip');
  const incoming = $(min ? 'rcChip' : 'rcFull');
  // Keep a keyboard user's place: the button they pressed is about to vanish.
  const refocus = document.activeElement === (min ? $('rcMin') : $('rcChip'));
  const animate = typeof card.animate === 'function' &&
    !(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);

  morphing = true;
  try {
    // Held at nothing once faded, so it cannot flash back for a frame before
    // the swap; let go of once it is out of sight.
    const fade = animate ? outgoing.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, fill: 'forwards' }) : null;
    if (fade) await fade.finished; // not `await fade?.finished`: that waits even with no fade
    const from = card.getBoundingClientRect();
    const fromRadius = getComputedStyle(card).borderRadius;
    minimised = min;
    minimisedFor = min ? getView().src?.coords ?? null : null;
    updateRouteCard();
    fade?.cancel();
    publishCardLift();
    if (animate && !card.classList.contains('hidden')) {
      const to = card.getBoundingClientRect();
      // Pinned to the left edge with an explicit width for the length of the
      // run: the full card is centred by its margins and the chip is not, and
      // neither of those is something a box can be animated between.
      const box = (r: DOMRect, radius: string): Keyframe => ({
        left: `${r.left}px`, right: 'auto', marginLeft: '0px', marginRight: '0px',
        width: `${r.width}px`, height: `${r.height}px`, borderRadius: radius, overflow: 'hidden'
      });
      card.animate([box(from, fromRadius), box(to, getComputedStyle(card).borderRadius)], { duration: MORPH_MS, easing: EASE });
      if (min) {
        // The bar's fill, bent round into the ring: it sweeps out from empty.
        const arc = $('rcRingArc');
        arc.animate([{ strokeDasharray: `0 ${RING_C.toFixed(1)}` }, { strokeDasharray: arc.style.strokeDasharray }],
          { duration: 420, delay: MORPH_MS / 2, easing: EASE, fill: 'backwards' });
      }
      await incoming.animate([{ opacity: 0 }, { opacity: 0, offset: 0.45 }, { opacity: 1 }], { duration: MORPH_MS }).finished;
    }
  } finally {
    morphing = false;
  }
  publishCardLift();
  if (refocus) (min ? $('rcChip') : $('rcMin')).focus();
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

  new ResizeObserver(() => {
    if (!morphing) publishCardLift();
  }).observe($('routeCard'));

  $('rcChart').addEventListener('click', () => {
    chartOpen = !chartOpen;
    updateRouteCard();
  });
  $('rcMin').addEventListener('click', () => void setMinimised(true));
  $('rcChip').addEventListener('click', () => void setMinimised(false));
  $('rcClose').addEventListener('click', opts.onClose);
}
