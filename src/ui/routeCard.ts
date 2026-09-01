// The active-route card: the strip along the bottom that names the route,
// totals its distance and climb, says how much is left, and opens the
// elevation profile. It is shared — the planner fills it with the route being
// sketched, tracking fills it with progress along the one you are walking — so
// it deliberately knows about neither. Callers describe what to show as a
// RouteCardView; this module turns that into DOM and owns nothing else.
//
// The one thing it draws on the map is the scrub marker: the dot that follows
// your finger along the elevation chart. It belongs to the chart, so it lives
// and dies with the card rather than with any feature.

import L from '../leaflet-setup';
import { renderProfile, type Scrub } from '../elevation';
import { formatDistance, formatDuration, naismithHours, type LatLng } from '../geo';
import { map } from '../map/map';
import { $ } from './dom';

/** The minimum a thing needs to be shown on the card: a planned route or a saved one. */
export interface RouteCardSource {
  coords: LatLng[];
  distanceM: number;
  ascentM: number;
  descentM?: number;
}

/** Everything the card draws, gathered by the caller at render time. */
export interface RouteCardView {
  /** The route-like thing to display, or null to hide the card entirely. */
  src: RouteCardSource | null;
  /** Title line — the route's name, or "New route" while planning. */
  name: string;
  /** Planning hides the close/offline controls and the remaining line. */
  planning: boolean;
  /** Progress readout, or null when there is nothing believable to say. */
  remaining: string | null;
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
// rather than in the chart because the chart is thrown away and redrawn on
// every GPS fix, and a marker you have to keep re-placing every few seconds is
// no use for reading the map.
let scrubM: number | null = null;
// The coords the chart currently shows. A new route — or an edited plan — is a
// different walk, so the scrubber from the old one is dropped rather than
// reappearing at the same distance along something else.
let scrubCoords: LatLng[] | null = null;

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
      color: '#c1121f',
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
 * Publish the active-route card's height so the bottom-anchored map furniture
 * can clear it (see --card-lift in style.css). The card is not a fixed size —
 * it grows with the elevation chart and the remaining line, and reflows on
 * rotation — so a hard-coded offset left the scale bar and the locate button
 * buried under a tall card. Measuring is the only thing that tracks all three.
 */
function publishCardLift(): void {
  const card = $('routeCard');
  const h = card.classList.contains('hidden') ? 0 : card.getBoundingClientRect().height;
  document.documentElement.style.setProperty('--card-lift', h ? `${Math.round(h) + 12}px` : '0px');
}

/** Refresh the card from the plan in progress or the active route. */
export function updateRouteCard(): void {
  const view = getView();
  const src = view.src;
  const card = $('routeCard');
  if (!src) {
    card.classList.add('hidden');
    publishCardLift();
    onProfileScrub(null);
    return;
  }
  card.classList.remove('hidden');
  card.classList.toggle('abovePlan', view.planning);
  $('rcName').textContent = view.name;
  const est = naismithHours(src.distanceM, src.ascentM, view.speedKmh);
  $('rcStats').textContent =
    `${formatDistance(src.distanceM)} · ${climbText(src.ascentM, src.descentM)} · ~${formatDuration(est)}`;
  $('rcRemaining').textContent = view.remaining ?? '';
  $('rcRemaining').classList.toggle('hidden', !view.remaining);
  $('rcOffline').classList.toggle('hidden', view.planning);
  $('rcClose').classList.toggle('hidden', view.planning);
  $('rcChart').classList.toggle('active', chartOpen);
  const chart = $('elevChart');
  if (chartOpen) {
    chart.classList.remove('hidden');
    if (scrubCoords && scrubCoords !== src.coords) onProfileScrub(null);
    // Only mark a position we actually believe: hereM is null until a fix lands
    // near the line, so the dot never appears at a guessed place.
    if (renderProfile(chart, src.coords, onProfileScrub, view.hereM, scrubM)) {
      scrubCoords = src.coords;
    } else {
      chart.innerHTML = '<p class="hint">No elevation data for this route.</p>';
      onProfileScrub(null);
    }
  } else {
    chart.classList.add('hidden');
    onProfileScrub(null);
  }
  publishCardLift();
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
