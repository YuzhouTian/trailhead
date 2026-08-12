// Finding somewhere. Two ways of asking: type a name, a grid ref or a lat/lng
// into the search box, or ask what is mapped around you.
//
// They are one module because they are the same question with the answer
// arriving differently. Both start from "where are we looking?" — the live GPS
// fix if there is one, otherwise the middle of the screen — both put markers on
// the map with the same kind of popup, and both are ways of saying "show me
// that", which is why both pause following.
//
// The search box's answers are a list you pick from; nearby's are a layer you
// toggle. That is the only real difference, and it is not enough to justify two
// files that would share a position lookup, a popup format and a pause rule.

import L from '../leaflet-setup';
import { getKnownPosition, getLastFix, pauseFollow } from './tracking';
import { formatDistance, haversine, type LatLng } from '../geo';
import { map } from '../map/map';
import { POI_KINDS_ADVISORY, describeKinds, fetchPois, poiCategory, type Poi } from '../poi';
import { search, type SearchHit } from '../search';
import { type Settings } from '../state';
import { $, hideToast, svgUse, toast } from '../ui/dom';
import { positionText } from '../ui/format';

/** How long to wait after the last keystroke before asking. */
const SEARCH_DELAY_MS = 400;
/** Shortest query worth sending. */
const MIN_QUERY_LENGTH = 2;
/** Nearby covers roughly the visible map, clamped to what Overpass answers quickly. */
const NEARBY_MIN_RADIUS_M = 800;
const NEARBY_MAX_RADIUS_M = 12000;

// Owned by the app, shared by reference: which categories nearby looks for.
let settings: Settings;

let searchAbort: AbortController | null = null;
let searchTimer: number | undefined;
let searchMarker: L.Marker | null = null;
let poiLayer: L.LayerGroup | null = null;

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
      // A divIcon, like every other marker here — Leaflet's default icon needs
      // PNG assets that don't survive bundling and render as a broken box.
      searchMarker = L.marker(hit.pos, {
        icon: L.divIcon({
          className: '',
          html: `<div class="searchPin">${svgUse('i-pin')}</div>`,
          iconSize: [32, 32],
          iconAnchor: [16, 32]
        })
      }).addTo(map);
      // Centre first and without animation, so the popup's auto-pan can't
      // animate over the top of it and leave the map where it started. Pause
      // following before the move, or the next fix pulls the map back off the
      // place that was just asked for.
      pauseFollow();
      map.setView(hit.pos, Math.max(map.getZoom(), 15), { animate: false });
      searchMarker
        .bindPopup(
          `<div style="font-size:13px;line-height:1.5"><b>${hit.name.replace(/</g, '&lt;')}</b><br>${positionText(hit.pos)}</div>`,
          { autoPan: false }
        )
        .openPopup();
      hideSearchResults();
      ($('searchInput') as HTMLInputElement).blur();
    });
  });
}

// ---------------------------------------------------------------- nearby POIs

/** Whether the nearby layer is currently on the map — the Map panel's button label. */
export function nearbyShown(): boolean {
  return poiLayer !== null;
}

/**
 * Drop the nearby markers without a toast. The Settings panel calls this when
 * the category ticks change: markers already drawn would no longer match the
 * list, and the Map tab's button asks again with the new selection.
 */
export function clearNearby(): void {
  poiLayer?.remove();
  poiLayer = null;
}

/** Naming a few reads better than a generic count; a long list does not. */
export function nearbyKindsShort(): string {
  const n = settings.poiKinds.length;
  return n <= 4 ? describeKinds(settings.poiKinds) : `${n} categories`;
}

/** The line under the nearby tick list: what it will search, and any warning. */
export function poiKindsNote(): string {
  const n = settings.poiKinds.length;
  if (!n) return 'Nothing ticked — "What\'s nearby" has nothing to look for.';
  if (n > POI_KINDS_ADVISORY) {
    return `${n} categories — a big ask of a free shared server. It should still take seconds, but expect the odd retry.`;
  }
  return `Searching for ${describeKinds(settings.poiKinds)}.`;
}

export async function showNearbyPois(): Promise<void> {
  if (poiLayer) {
    poiLayer.remove();
    poiLayer = null;
    toast('Nearby points hidden');
    return;
  }
  const kinds = settings.poiKinds;
  if (!kinds.length) {
    return toast('No nearby categories are ticked — choose some in Settings', 4500);
  }
  const centre: LatLng = getLastFix() ?? [map.getCenter().lat, map.getCenter().lng];
  // Cover roughly the visible map, clamped to something Overpass answers quickly.
  const bounds = map.getBounds();
  const radius = Math.min(
    Math.max(
      haversine([bounds.getNorth(), bounds.getWest()], [bounds.getSouth(), bounds.getEast()]) / 2,
      NEARBY_MIN_RADIUS_M
    ),
    NEARBY_MAX_RADIUS_M
  );
  toast(`Looking for ${nearbyKindsShort()}…`, 0);
  try {
    const pois = await fetchPois(centre, radius, kinds);
    hideToast();
    if (!pois.length) return toast('Nothing mapped nearby', 3000);
    poiLayer = L.layerGroup(pois.map(poiMarker)).addTo(map);
    toast(`${pois.length} nearby — tap a marker for detail`, 3500);
  } catch (e) {
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
      className: '',
      html: `<div class="poiMarker" style="border-color:${cat?.colour ?? '#2d6a4f'}">${cat?.icon ?? '•'}</div>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13]
    })
  });
  const height = p.ele !== undefined ? ` · ${Math.round(p.ele)} m` : '';
  const here = getKnownPosition();
  const away = here ? ` · ${formatDistance(haversine(here, p.pos))} away` : '';
  // An unnamed feature is titled with its category, so don't repeat it beneath.
  const type = p.name === cat?.label ? '' : (cat?.label ?? 'Point');
  marker.bindPopup(
    `<div style="font-size:13px;line-height:1.5">
      <b>${p.name.replace(/</g, '&lt;')}</b><br>
      ${(type + height + away).replace(/^ · /, '')}<br>${positionText(p.pos)}
    </div>`
  );
  return marker;
}

// ---------------------------------------------------------------- wiring

/** Wire up the search box. Nearby has no control of its own — the Map panel
 *  calls showNearbyPois() — so only the box needs listeners. */
export function initSearch(opts: { settings: Settings }): void {
  settings = opts.settings;

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
