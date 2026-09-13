// Saved pins: the places you drop on the map and keep. A long-press opens the
// "what's here" card — grid ref, height, how far away it is — and naming it
// saves it; tapping a saved pin's marker opens it again to share or delete it.
// A search hit or a nearby point opens the same card, with its name filled in.
//
// Almost self-contained. It reads where you are through tracking's accessors
// rather than owning any GPS state of its own, and asks the planner whether a
// long-press means "identify this spot" or "you are drawing a route". The one
// thing it lends out is the pin list itself, for the Routes panel to show.
//
// The #p= link lives here too, both ends of it: sharePin() builds the link and
// openSharedPin() consumes it. It is a pin format, not a route one, so it stays
// with the pins rather than moving to sharing.

import L from '../leaflet-setup';
import { fetchElevation } from '../elevation';
import { directionsTo, type DetourTarget } from './detour';
import { isPlanning } from './planner';
import { getKnownPosition, pauseFollow, setKnownPosition } from './tracking';
import { compassDir, formatDistance, haversine, type LatLng } from '../geo';
import { map } from '../map/map';
import { formatGridRef } from '../osgb';
import { loadPins, savePins, type Pin, type PinCategory } from '../state';
import { $, svgUse, toast } from '../ui/dom';
import { gridText } from '../ui/format';

/**
 * The class on a place marker — a saved pin, a search pin, a nearby point —
 * that lets a tap fall through it to the map while planning (see style.css).
 * A marker catches its taps, and while you are drawing a route, a tap on a
 * summit means "go via here", not "tell me about it"; the card is hidden while
 * planning anyway. The plan's own waypoint markers don't carry it: those are
 * dragged.
 */
export const PLAN_PASS_THROUGH = 'planPassThrough';

/** How long a long-press keeps swallowing clicks — see flagOpened(). */
const JUST_OPENED_MS = 350;

const PIN_CATS: { id: PinCategory; label: string; icon: string }[] = [
  { id: 'summit', label: 'Summit', icon: 'c-summit' },
  { id: 'viewpoint', label: 'Viewpoint', icon: 'c-viewpoint' },
  { id: 'water', label: 'Water', icon: 'c-water' },
  { id: 'camp', label: 'Camp', icon: 'c-camp' },
  { id: 'parking', label: 'Parking', icon: 'c-parking' },
  { id: 'other', label: 'Other', icon: 'c-other' }
];

/** A category's label and icon, falling back to "Other" for anything unknown. */
export const catMeta = (id: PinCategory) => PIN_CATS.find((c) => c.id === id) ?? PIN_CATS[5];

/** Not read from storage until something asks — see getPins(). */
let pins: Pin[] | null = null;
const pinMarkers = new Map<string, L.Marker>();
let dropMarker: L.Marker | null = null; // the temporary pin for an unsaved point
let eleAbort: AbortController | null = null; // in-flight elevation lookup
let pinCardJustOpened = false; // swallow the click that can trail a long-press
/** Where the open card's place is, so its distance can be kept up to date. */
let cardPoint: LatLng | null = null;

// ---------------------------------------------------------------- the list

/**
 * The saved pins, read from storage on first use. The Routes panel lists them
 * through this, and everything in this module reaches them through it too, so a
 * pin saved or deleted before the markers have been drawn (see initPins) still
 * lands in the real list rather than an empty one. Treat as read-only.
 */
export function getPins(): Pin[] {
  return (pins ??= loadPins());
}

/**
 * Confirm and delete a pin, updating storage and the map. Returns whether it
 * actually went, so the caller can decide what to do next — the card hides
 * itself and toasts, the Routes panel just redraws its list.
 */
export function deletePin(id: string): boolean {
  const pin = getPins().find((p) => p.id === id);
  if (!pin) return false;
  if (!confirm(`Delete “${pin.name}”?`)) return false;
  pins = getPins().filter((p) => p.id !== id);
  savePins(pins);
  renderPinMarkers();
  return true;
}

function renderPinMarkers(): void {
  for (const m of pinMarkers.values()) m.remove();
  pinMarkers.clear();
  for (const pin of getPins()) {
    const m = L.marker([pin.lat, pin.lng], {
      icon: L.divIcon({
        className: PLAN_PASS_THROUGH,
        html: `<div class="savedPin">${svgUse(catMeta(pin.category).icon)}</div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14]
      })
    }).addTo(map);
    m.on('click', () => openSavedPin(pin.id));
    pinMarkers.set(pin.id, m);
  }
}

// ---------------------------------------------------------------- formatting

function distFactInner(lat: number, lng: number, from: LatLng): string {
  const d = formatDistance(haversine(from, [lat, lng]));
  return `${svgUse('i-compass')}${d} ${compassDir(from, [lat, lng])}`;
}

/** Distance + compass bearing from the user. Renders a placeholder when we
 *  don't know where we are yet; hydrateDistance fills it or removes it. */
function distFactHtml(lat: number, lng: number): string {
  const known = getKnownPosition();
  return known
    ? `<span class="pc-fact" id="pcDist">${distFactInner(lat, lng, known)}</span>`
    : `<span class="pc-fact loading" id="pcDist">${svgUse('i-compass')}…</span>`;
}

/**
 * Keep an open card's distance honest as you walk. The card is built once and
 * then just sits there, so without this a pin you are walking towards holds the
 * distance it had when you opened it — which is the number you are least likely
 * to notice is wrong, and most likely to act on. Only the distance row is
 * touched; everything else on the card is as true as it was.
 *
 * Skips a row still waiting on its first position: that one belongs to
 * hydrateDistance, which will either fill it or take it away.
 */
export function refreshCardDistance(): void {
  if (!cardPoint) return;
  const here = getKnownPosition();
  if (!here) return;
  const el = document.getElementById('pcDist');
  if (!el || el.classList.contains('loading')) return;
  el.innerHTML = distFactInner(cardPoint[0], cardPoint[1], here);
}

/**
 * Fill in the distance for a card that opened before we had a position, asking
 * for a one-shot fix. Drops the row if the fix never arrives, so a card that
 * can't answer doesn't sit there loading forever. The element is captured by
 * reference and checked with isConnected, so a late answer can't reach into
 * whatever card replaced this one.
 */
function hydrateDistance(card: HTMLElement, lat: number, lng: number): void {
  const el = card.querySelector<HTMLElement>('#pcDist');
  if (!el || !el.classList.contains('loading')) return;
  if (!('geolocation' in navigator)) {
    el.remove();
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const here: LatLng = [pos.coords.latitude, pos.coords.longitude];
      setKnownPosition(here); // worth keeping even if this card has gone
      if (!el.isConnected) return;
      el.classList.remove('loading');
      el.innerHTML = distFactInner(lat, lng, here);
    },
    () => { if (el.isConnected) el.remove(); },
    { enableHighAccuracy: false, maximumAge: 600_000, timeout: 10_000 }
  );
}

// ---------------------------------------------------------------- share

/**
 * Share a place through the phone's share sheet: the place written out (name,
 * grid ref, lat/lng, height) for whoever reads it without the app, and a #p=
 * link that opens it in Trailhead for whoever has it.
 *
 * With no share sheet, or one that fails for any reason other than you backing
 * out of it, both go on the clipboard instead, with prompt() as the last
 * resort. `name` is optional because a spot you have only just long-pressed
 * may not have one yet; the link then carries the grid reference.
 */
export async function sharePin(p: { name?: string; lat: number; lng: number; ele?: number | null }): Promise<void> {
  const grid = formatGridRef(p.lat, p.lng, 4);
  const lines = [];
  if (p.name) lines.push(p.name);
  if (grid) lines.push(grid);
  lines.push(`${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`);
  if (typeof p.ele === 'number') lines.push(`${Math.round(p.ele)} m`);
  const text = lines.join('\n');
  const label = p.name || gridText(p.lat, p.lng);
  const url = `${location.origin}${location.pathname}#p=${p.lat.toFixed(5)},${p.lng.toFixed(5)},${encodeURIComponent(label)}`;

  if (navigator.share) {
    try {
      await navigator.share({ title: label, text, url });
      return;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return; // you closed the sheet
    }
  }
  const both = `${text}\n${url}`;
  try {
    await navigator.clipboard.writeText(both);
    toast('Copied');
  } catch {
    prompt('Copy:', both);
  }
}

// ---------------------------------------------------------------- directions

/**
 * The "Directions" row. It sits above the housekeeping buttons on both cards,
 * but only leads on the saved one: on a pin you have kept, routing to it is the
 * thing you came for, whereas on a spot you have only just long-pressed, naming
 * and saving it still is.
 */
function directionsRow(id: string, primary: boolean): string {
  return `<div class="pc-actions">
      <button class="${primary ? 'pc-primary' : 'pc-neutral'}" id="${id}">${svgUse('i-routes')}Directions</button>
    </div>`;
}

/**
 * Wire a Directions button up. `target` is read at tap time rather than
 * captured, because on the unsaved card the name is whatever has been typed
 * into the box by then — or, if nothing has, the grid reference.
 */
function wireDirections(id: string, target: () => DetourTarget): void {
  const btn = document.getElementById(id) as HTMLButtonElement | null;
  if (!btn) return;
  const idle = `${svgUse('i-routes')}Directions`;
  btn.addEventListener('click', () => {
    void directionsTo(target(), (text) => {
      // The card can be gone by the time an answer arrives — a slow router
      // outlives a tap on the map — so never reach into a detached button.
      if (!btn.isConnected) return;
      btn.disabled = text !== null;
      btn.classList.toggle('busy', text !== null);
      btn.innerHTML = text ?? idle;
    }).then((started) => {
      // The route card is about to appear along the bottom; two cards stacked
      // there is one too many, and the question the pin card was answering has
      // just been answered.
      if (started) hidePinCard();
    });
  });
}

// ---------------------------------------------------------------- the card

/** Close the pin card now. Opening a panel over it counts. */
export function hidePinCard(): void {
  eleAbort?.abort();
  eleAbort = null;
  dropMarker?.remove();
  dropMarker = null;
  cardPoint = null;
  const card = $('pinCard');
  card.classList.add('hidden');
  card.innerHTML = '';
}

/**
 * Close the pin card on a map tap — unless a long-press just opened it. A
 * long-press can be followed by a click on the same spot, which would otherwise
 * shut the card the press had only just opened.
 */
export function dismissPinCard(): void {
  if (!pinCardJustOpened) hidePinCard();
}

function flagOpened(): void {
  pinCardJustOpened = true;
  setTimeout(() => { pinCardJustOpened = false; }, JUST_OPENED_MS);
}

/** What a caller already knows about a place, to start its card with. */
export interface NewPinOptions {
  /** Put in the name box: a search hit's name, a mapped feature's, a shared pin's. */
  name?: string;
  /** The chip lit to begin with; "Other" if not given. */
  category?: PinCategory;
  /** A height already known (OpenStreetMap's), so there is nothing to look up. */
  ele?: number;
  /**
   * Whether to drop the red pin. Off for a place that already has a marker of
   * its own — the search pin, a nearby point's disc — which a second pin on top
   * would only hide.
   */
  marker?: boolean;
}

/** The card for a fresh point: identify, name, tag, and save it. */
export function openNewPin(lat: number, lng: number, opts: NewPinOptions = {}): void {
  hidePinCard();
  flagOpened();
  cardPoint = [lat, lng];
  if (opts.marker !== false) {
    dropMarker = L.marker([lat, lng], {
      icon: L.divIcon({
        className: '',
        html: `<div class="dropPin">${svgUse('i-pin')}</div>`,
        iconSize: [32, 32],
        iconAnchor: [16, 32]
      })
    }).addTo(map);
  }

  let category: PinCategory = opts.category ?? 'other';
  let ele: number | null | undefined = opts.ele; // undefined = still loading
  const eleHtml =
    typeof ele === 'number'
      ? `<span class="pc-fact">${svgUse('i-ele')}${Math.round(ele)} m</span>`
      : `<span class="pc-fact loading" id="pcEle">${svgUse('i-ele')}…</span>`;

  const chips = PIN_CATS.map(
    (c) => `<button class="pc-chip${c.id === category ? ' on' : ''}" data-cat="${c.id}">${svgUse(c.icon)}${c.label}</button>`
  ).join('');
  const card = $('pinCard');
  card.innerHTML = `
    <button class="pc-close" aria-label="Close">${svgUse('i-close')}</button>
    <p class="pc-eyebrow">What's here</p>
    <div class="pc-grid">${gridText(lat, lng)}</div>
    <div class="pc-ll">${lat.toFixed(5)}, ${lng.toFixed(5)}</div>
    <div class="pc-facts">${eleHtml}${distFactHtml(lat, lng)}</div>
    <div class="pc-sep"></div>
    <input class="pc-name" id="pcName" placeholder="Name this spot" autocomplete="off" />
    <div class="pc-chips">${chips}</div>
    ${directionsRow('pcDirections', false)}
    <div class="pc-actions">
      <button class="pc-primary" id="pcSave">${svgUse('i-save')}Save pin</button>
      <button class="pc-neutral" id="pcShare">${svgUse('i-share')}Share</button>
    </div>`;
  card.classList.remove('hidden');
  const nameEl = $<HTMLInputElement>('pcName');
  if (opts.name) nameEl.value = opts.name;

  // Routing to a spot shouldn't make you name it first — but if you have
  // started to, that name is better than the grid reference.
  wireDirections('pcDirections', () => ({
    name: nameEl.value.trim() || gridText(lat, lng),
    lat,
    lng
  }));

  card.querySelector('.pc-close')!.addEventListener('click', hidePinCard);
  card.querySelectorAll<HTMLButtonElement>('.pc-chip').forEach((b) =>
    b.addEventListener('click', () => {
      category = b.dataset.cat as PinCategory;
      card.querySelectorAll('.pc-chip').forEach((x) => x.classList.toggle('on', x === b));
    })
  );
  $('pcShare').addEventListener('click', () =>
    sharePin({ name: nameEl.value.trim(), lat, lng, ele: ele ?? null })
  );
  $('pcSave').addEventListener('click', () => {
    const name = nameEl.value.trim() || catMeta(category).label;
    const pin: Pin = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name, category, lat, lng, ele: ele ?? null, createdAt: Date.now()
    };
    const list = getPins();
    list.push(pin);
    savePins(list);
    renderPinMarkers();
    openSavedPin(pin.id);
    toast('Pin saved');
  });

  // Elevation arrives a moment later; fill it in, or drop the line if it fails.
  // Captured by reference (not re-queried by id) so a stale, aborted lookup
  // can't reach into whatever card replaced this one in the meantime.
  hydrateDistance(card, lat, lng);

  const eleEl = card.querySelector<HTMLElement>('#pcEle');
  if (!eleEl) return; // the place came with its height
  eleAbort = new AbortController();
  fetchElevation(lat, lng, eleAbort.signal).then((m) => {
    ele = m;
    if (!eleEl.isConnected) return;
    if (typeof m === 'number') {
      eleEl.classList.remove('loading');
      eleEl.innerHTML = `${svgUse('i-ele')}${Math.round(m)} m`;
    } else {
      eleEl.remove();
    }
  });
}

/** The card for an already-saved pin: reopened by tapping its marker. */
export function openSavedPin(id: string): void {
  const pin = getPins().find((p) => p.id === id);
  if (!pin) return;
  hidePinCard();
  flagOpened();
  cardPoint = [pin.lat, pin.lng];
  const eleHtml =
    typeof pin.ele === 'number' ? `<span class="pc-fact">${svgUse('i-ele')}${Math.round(pin.ele)} m</span>` : '';
  const card = $('pinCard');
  card.innerHTML = `
    <button class="pc-close" aria-label="Close">${svgUse('i-close')}</button>
    <p class="pc-eyebrow">Saved pin</p>
    <div class="pc-title"><span class="ci">${svgUse(catMeta(pin.category).icon)}</span><span class="nm">${pin.name.replace(/</g, '&lt;')}</span></div>
    <div class="pc-grid">${gridText(pin.lat, pin.lng)}</div>
    <div class="pc-ll">${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}</div>
    <div class="pc-facts">${eleHtml}${distFactHtml(pin.lat, pin.lng)}</div>
    ${directionsRow('pcDirections', true)}
    <div class="pc-actions">
      <button class="pc-neutral" id="pcShare">${svgUse('i-share')}Share</button>
      <button class="pc-danger" id="pcDel" aria-label="Delete pin">${svgUse('i-trash')}</button>
    </div>`;
  card.classList.remove('hidden');

  wireDirections('pcDirections', () => ({ name: pin.name, lat: pin.lat, lng: pin.lng }));
  hydrateDistance(card, pin.lat, pin.lng);

  card.querySelector('.pc-close')!.addEventListener('click', hidePinCard);
  $('pcShare').addEventListener('click', () => sharePin(pin));
  $('pcDel').addEventListener('click', () => {
    if (!deletePin(pin.id)) return;
    hidePinCard();
    toast('Pin deleted');
  });
}

/** A #p=lat,lng,name link centres here and offers to save the pin. */
export function openSharedPin(): boolean {
  const m = location.hash.match(/^#p=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,(.*))?$/);
  if (!m) return false;
  const lat = parseFloat(m[1]);
  const lng = parseFloat(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  history.replaceState(null, '', location.pathname + location.search);
  pauseFollow(); // a shared pin is somewhere else by definition
  map.setView([lat, lng], Math.max(map.getZoom(), 15));
  openNewPin(lat, lng, { name: m[3] ? decodeURIComponent(m[3]) : undefined });
  return true;
}

/** Draw the saved pins and wire up the long-press that drops a new one. */
export function initPins(): void {
  // The markers wait until the browser is idle, so reading the pins and building
  // one marker each is not part of the work that stands between launch and the
  // map's first tiles; they appear a moment after the map does. Safari has long
  // gone without requestIdleCallback, hence the plain timeout, which still moves
  // the work out of the startup script. The one-second cap is so a busy launch
  // cannot hold them back for long. Anything that needs the list sooner — a tap on Saved, a
  // save — reads it through getPins() and redraws, so nothing depends on this
  // having run.
  if ('requestIdleCallback' in window) requestIdleCallback(renderPinMarkers, { timeout: 1000 });
  else setTimeout(renderPinMarkers, 0);

  // Long-press (or right-click) anywhere to identify and optionally save a spot.
  map.on('contextmenu', (e: L.LeafletMouseEvent) => {
    if (isPlanning()) return;
    openNewPin(e.latlng.lat, e.latlng.lng);
  });
}
