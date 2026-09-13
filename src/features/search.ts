// Finding somewhere. Two ways of asking: type a name, a grid ref or a lat/lng
// into the search box, or ask what is mapped around you.
//
// They are one module because they are the same question with the answer
// arriving differently. Both start from "where are we looking?" — the live GPS
// fix if there is one, otherwise the middle of the screen — both put markers on
// the map and open the pin card when tapped, and both are ways of saying "show
// me that", which is why both pause following.
//
// The search box's answers are a list you pick from; nearby's are layers you
// toggle. That is the only real difference, and it is not enough to justify two
// files that would share a position lookup, a card and a pause rule.

import L from '../leaflet-setup';
import { PLAN_PASS_THROUGH, openNewPin } from './pins';
import { getLastFix, pauseFollow } from './tracking';
import { haversine, type LatLng } from '../geo';
import { map } from '../map/map';
import { fetchPois, poiCategory, type Poi, type PoiKind } from '../poi';
import { search, type SearchHit } from '../search';
import { $, hideToast, svgUse, toast } from '../ui/dom';

/** How long to wait after the last keystroke before asking. */
const SEARCH_DELAY_MS = 400;
/** Shortest query worth sending. */
const MIN_QUERY_LENGTH = 2;
/** Nearby covers roughly the visible map, clamped to what Overpass answers quickly. */
const NEARBY_MIN_RADIUS_M = 800;
const NEARBY_MAX_RADIUS_M = 12000;

let searchAbort: AbortController | null = null;
let searchTimer: number | undefined;
let searchMarker: L.Marker | null = null;

// ---------------------------------------------------------------- search box

/** Hide the results list — a map tap dismisses it like everything else. */
export function hideSearchResults(): void {
  $('searchResults').classList.add('hidden');
}

function showSearchHits(hits: SearchHit[]): void {
  const box = $('searchResults');
  if (!hits.length) {
    box.innerHTML = '<div class="hit"><div class="d">No matches</div></div>';
    box.classList.remove('hidden');
    return;
  }
  box.innerHTML = hits
    .map(
      (h, i) => `<div class="hit" data-i="${i}">
        <div class="n">${h.name.replace(/</g, '&lt;')}</div>
        <div class="d">${h.detail.replace(/</g, '&lt;')}</div>
      </div>`
    )
    .join('');
  box.classList.remove('hidden');
  box.querySelectorAll<HTMLElement>('.hit').forEach((el) => {
    el.addEventListener('click', () => {
      const hit = hits[Number(el.dataset.i)];
      searchMarker?.remove();
      const open = () => openNewPin(hit.pos[0], hit.pos[1], { name: hit.name, marker: false });
      // A divIcon, like every other marker here — Leaflet's default icon needs
      // PNG assets that don't survive bundling and render as a broken box.
      searchMarker = L.marker(hit.pos, {
        icon: L.divIcon({
          className: PLAN_PASS_THROUGH,
          html: `<div class="searchPin">${svgUse('i-pin')}</div>`,
          iconSize: [32, 32],
          iconAnchor: [16, 32]
        })
      }).addTo(map);
      // Tapping the pin again brings its card back, once it has been closed.
      searchMarker.on('click', open);
      // Pause following before the move, or the next fix pulls the map back off
      // the place that was just asked for.
      pauseFollow();
      map.setView(hit.pos, Math.max(map.getZoom(), 15), { animate: false });
      open();
      // Something covers the bottom of the map — the plan sheet while planning,
      // the card that just opened otherwise — so centre the place in what is
      // left above it rather than in the whole screen, where it could be hidden.
      // --plan-lift is 0 when not planning; the card is hidden while planning.
      const lift = parseFloat(document.documentElement.style.getPropertyValue('--plan-lift')) || 0;
      const cardTop = $('pinCard').getBoundingClientRect().top;
      const mapBox = map.getContainer().getBoundingClientRect();
      const covered = lift || (cardTop > 0 ? mapBox.bottom - cardTop : 0);
      if (covered > 0) map.panBy([0, covered / 2], { animate: false });
      hideSearchResults();
      ($('searchInput') as HTMLInputElement).blur();
    });
  });
}

// ---------------------------------------------------------------- nearby POIs

// One layer per category, keyed by its id. A category is in here from the
// moment its chip is ticked — `null` while the query is still out — so the
// chip reads as on straight away, and unticking mid-search can cancel it.
const nearby = new Map<PoiKind, { layer: L.LayerGroup | null; abort: AbortController }>();

/** Whether a category is on the map, or on its way — the Map sheet's chips. */
export function nearbyOn(kind: PoiKind): boolean {
  return nearby.has(kind);
}

/**
 * Tick or untick one category. Ticking searches roughly the visible map for
 * it; unticking drops its markers, and asks nothing. Resolves once the search
 * is done, by which time the category may have turned itself back off (nothing
 * found, or the servers were busy) — read `nearbyOn` again afterwards.
 */
export async function toggleNearby(kind: PoiKind): Promise<void> {
  const current = nearby.get(kind);
  if (current) {
    current.abort.abort();
    // Still searching: its "Looking for…" toast has no timeout of its own.
    if (!current.layer) hideToast();
    current.layer?.remove();
    nearby.delete(kind);
    return;
  }
  const cat = poiCategory(kind);
  if (!cat) return;
  const entry = { layer: null as L.LayerGroup | null, abort: new AbortController() };
  nearby.set(kind, entry);

  const centre: LatLng = getLastFix() ?? [map.getCenter().lat, map.getCenter().lng];
  const bounds = map.getBounds();
  const radius = Math.min(
    Math.max(
      haversine([bounds.getNorth(), bounds.getWest()], [bounds.getSouth(), bounds.getEast()]) / 2,
      NEARBY_MIN_RADIUS_M
    ),
    NEARBY_MAX_RADIUS_M
  );
  const name = cat.plural.toLowerCase();
  toast(`Looking for ${name}…`, 0);
  try {
    const pois = await fetchPois(centre, radius, kind, entry.abort.signal);
    // Unticked while the query was out: it has already been forgotten.
    if (nearby.get(kind) !== entry) return;
    hideToast();
    if (!pois.length) {
      nearby.delete(kind);
      toast(`No ${name} mapped around here`, 3000);
      return;
    }
    entry.layer = L.layerGroup(pois.map(poiMarker)).addTo(map);
    toast(`${cat.plural}: ${pois.length} found — tap a marker for detail`, 3500);
  } catch (e) {
    if (nearby.get(kind) !== entry) return;
    nearby.delete(kind);
    hideToast();
    // OpenStreetMap's free query servers are shared and often rate-limit or
    // time out; a retry a moment later usually succeeds.
    toast(`Map data servers busy (${(e as Error).message}) — try again in a moment`, 5000);
  }
}

function poiMarker(p: Poi): L.Marker {
  const cat = poiCategory(p.kind);
  const marker = L.marker(p.pos, {
    icon: L.divIcon({
      className: PLAN_PASS_THROUGH,
      // The disc is filled with the category colour and the glyph is white, so
      // a nearby point can never be mistaken for a pin you saved yourself
      // (white disc, green ring, green glyph).
      html: `<div class="poiMarker" style="background:${cat?.colour ?? '#2d6a4f'}">${svgUse(cat?.icon ?? 'c-other')}</div>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13]
    })
  });
  // OpenStreetMap's height, where it has one, is the surveyed figure for the
  // feature itself; it beats a terrain-model lookup at the same spot.
  marker.on('click', () =>
    openNewPin(p.pos[0], p.pos[1], {
      name: p.name,
      // Nearby ids are pin category ids, so the point saves as its own kind.
      category: p.kind,
      ele: p.ele,
      marker: false
    })
  );
  return marker;
}

// ---------------------------------------------------------------- wiring

/** Wire up the search box. Nearby has no control of its own — the Map sheet's
 *  chips call toggleNearby() — so only the box needs listeners. */
export function initSearch(): void {
  $('searchInput').addEventListener('input', () => {
    const q = ($('searchInput') as HTMLInputElement).value;
    $('searchClear').classList.toggle('hidden', !q);
    window.clearTimeout(searchTimer);
    searchAbort?.abort();
    if (q.trim().length < MIN_QUERY_LENGTH) return hideSearchResults();
    searchTimer = window.setTimeout(async () => {
      const ctrl = (searchAbort = new AbortController());
      const near: LatLng = getLastFix() ?? [map.getCenter().lat, map.getCenter().lng];
      try {
        // The second callback lands later, if a background lookup finds a better
        // order or something worth saying about a result. It may never come, and
        // by the time it does the results may be stale or already dismissed —
        // redrawing then would pop the list back open over a chosen place.
        showSearchHits(
          await search(q, near, ctrl.signal, (refined) => {
            const open = !$('searchResults').classList.contains('hidden');
            if (open && !ctrl.signal.aborted) showSearchHits(refined);
          })
        );
      } catch (e) {
        if ((e as Error).name !== 'AbortError') toast(`Search failed: ${(e as Error).message}`, 4000);
      }
    }, SEARCH_DELAY_MS);
  });

  $('searchClear').addEventListener('click', () => {
    ($('searchInput') as HTMLInputElement).value = '';
    $('searchClear').classList.add('hidden');
    hideSearchResults();
    searchMarker?.remove();
    searchMarker = null;
  });
}
