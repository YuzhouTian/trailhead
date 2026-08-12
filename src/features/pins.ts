// Saved pins: the places you drop on the map and keep. A long-press opens the
// "what's here" card — grid ref, height, how far away it is — and naming it
// saves it; tapping a saved pin's marker opens it again to copy, share or
// delete.
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
import { isPlanning } from './planner';
import { getKnownPosition, pauseFollow, setKnownPosition } from './tracking';
import { compassDir, formatDistance, haversine, type LatLng } from '../geo';
import { map } from '../map/map';
import { formatGridRef } from '../osgb';
import { loadPins, savePins, type Pin, type PinCategory } from '../state';
import { $, svgUse, toast } from '../ui/dom';
import { gridText } from '../ui/format';

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

let pins = loadPins();
const pinMarkers = new Map<string, L.Marker>();
let dropMarker: L.Marker | null = null; // the temporary pin for an unsaved point
let eleAbort: AbortController | null = null; // in-flight elevation lookup
let pinCardJustOpened = false; // swallow the click that can trail a long-press

// ---------------------------------------------------------------- the list

/** The saved pins, for the Routes panel to list. Treat as read-only. */
export function getPins(): Pin[] {
  return pins;
}

/**
 * Confirm and delete a pin, updating storage and the map. Returns whether it
 * actually went, so the caller can decide what to do next — the card hides
 * itself and toasts, the Routes panel just redraws its list.
 */
export function deletePin(id: string): boolean {
  const pin = pins.find((p) => p.id === id);
  if (!pin) return false;
  if (!confirm(`Delete “${pin.name}”?`)) return false;
  pins = pins.filter((p) => p.id !== id);
  savePins(pins);
  renderPinMarkers();
  return true;
}

function renderPinMarkers(): void {
  for (const m of pinMarkers.values()) m.remove();
  pinMarkers.clear();
  for (const pin of pins) {
    const m = L.marker([pin.lat, pin.lng], {
      icon: L.divIcon({
        className: '',
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

// ---------------------------------------------------------------- copy / share

async function copyPin(p: { name?: string; lat: number; lng: number; ele?: number | null }): Promise<void> {
  const grid = formatGridRef(p.lat, p.lng, 4);
  const lines = [];
  if (p.name) lines.push(p.name);
  if (grid) lines.push(grid);
  lines.push(`${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`);
  if (typeof p.ele === 'number') lines.push(`${Math.round(p.ele)} m`);
  const text = lines.join('\n');
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  } catch {
    prompt('Copy:', text);
  }
}

async function sharePin(p: Pin): Promise<void> {
  const url = `${location.origin}${location.pathname}#p=${p.lat.toFixed(5)},${p.lng.toFixed(5)},${encodeURIComponent(p.name)}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('Pin link copied');
  } catch {
    prompt('Copy the link:', url);
  }
}

// ---------------------------------------------------------------- the card

/** Close the pin card now. Opening a panel over it counts. */
export function hidePinCard(): void {
  eleAbort?.abort();
  eleAbort = null;
  dropMarker?.remove();
  dropMarker = null;
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

/** The card for a fresh point: identify, name, tag, and save it. */
export function openNewPin(lat: number, lng: number): void {
  hidePinCard();
  flagOpened();
  dropMarker = L.marker([lat, lng], {
    icon: L.divIcon({
      className: '',
      html: `<div class="dropPin">${svgUse('i-pin')}</div>`,
      iconSize: [32, 32],
      iconAnchor: [16, 32]
    })
  }).addTo(map);

  let category: PinCategory = 'other';
  let ele: number | null | undefined; // undefined = still loading

  const chips = PIN_CATS.map(
    (c) => `<button class="pc-chip${c.id === category ? ' on' : ''}" data-cat="${c.id}">${svgUse(c.icon)}${c.label}</button>`
  ).join('');
  const card = $('pinCard');
  card.innerHTML = `
    <button class="pc-close" aria-label="Close">&times;</button>
    <p class="pc-eyebrow">What's here</p>
    <div class="pc-grid">${gridText(lat, lng)}</div>
    <div class="pc-ll">${lat.toFixed(5)}, ${lng.toFixed(5)}</div>
    <div class="pc-facts"><span class="pc-fact loading" id="pcEle">${svgUse('i-ele')}…</span>${distFactHtml(lat, lng)}</div>
    <div class="pc-sep"></div>
    <input class="pc-name" id="pcName" placeholder="Name this spot" autocomplete="off" />
    <div class="pc-chips">${chips}</div>
    <div class="pc-actions">
      <button class="pc-primary" id="pcSave">${svgUse('i-save')}Save pin</button>
      <button class="pc-neutral" id="pcCopy">${svgUse('i-copy')}Copy</button>
    </div>`;
  card.classList.remove('hidden');

  card.querySelector('.pc-close')!.addEventListener('click', hidePinCard);
  card.querySelectorAll<HTMLButtonElement>('.pc-chip').forEach((b) =>
    b.addEventListener('click', () => {
      category = b.dataset.cat as PinCategory;
      card.querySelectorAll('.pc-chip').forEach((x) => x.classList.toggle('on', x === b));
    })
  );
  $('pcCopy').addEventListener('click', () => copyPin({ lat, lng, ele: ele ?? null }));
  $('pcSave').addEventListener('click', () => {
    const name = ($('pcName') as HTMLInputElement).value.trim() || catMeta(category).label;
    const pin: Pin = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name, category, lat, lng, ele: ele ?? null, createdAt: Date.now()
    };
    pins.push(pin);
    savePins(pins);
    renderPinMarkers();
    openSavedPin(pin.id);
    toast('Pin saved');
  });

  // Elevation arrives a moment later; fill it in, or drop the line if it fails.
  // Captured by reference (not re-queried by id) so a stale, aborted lookup
  // can't reach into whatever card replaced this one in the meantime.
  hydrateDistance(card, lat, lng);

  const eleEl = card.querySelector<HTMLElement>('#pcEle');
  eleAbort = new AbortController();
  fetchElevation(lat, lng, eleAbort.signal).then((m) => {
    ele = m;
    if (!eleEl || !eleEl.isConnected) return;
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
  const pin = pins.find((p) => p.id === id);
  if (!pin) return;
  hidePinCard();
  flagOpened();
  const eleHtml =
    typeof pin.ele === 'number' ? `<span class="pc-fact">${svgUse('i-ele')}${Math.round(pin.ele)} m</span>` : '';
  const card = $('pinCard');
  card.innerHTML = `
    <button class="pc-close" aria-label="Close">&times;</button>
    <p class="pc-eyebrow">Saved pin</p>
    <div class="pc-title"><span class="ci">${svgUse(catMeta(pin.category).icon)}</span><span class="nm">${pin.name.replace(/</g, '&lt;')}</span></div>
    <div class="pc-grid">${gridText(pin.lat, pin.lng)}</div>
    <div class="pc-ll">${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}</div>
    <div class="pc-facts">${eleHtml}${distFactHtml(pin.lat, pin.lng)}</div>
    <div class="pc-actions">
      <button class="pc-neutral" id="pcCopy">${svgUse('i-copy')}Copy</button>
      <button class="pc-neutral" id="pcShare">${svgUse('i-share')}Share</button>
      <button class="pc-danger" id="pcDel" aria-label="Delete pin">${svgUse('i-trash')}</button>
    </div>`;
  card.classList.remove('hidden');

  hydrateDistance(card, pin.lat, pin.lng);

  card.querySelector('.pc-close')!.addEventListener('click', hidePinCard);
  $('pcCopy').addEventListener('click', () => copyPin(pin));
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
  openNewPin(lat, lng);
  const nameEl = document.getElementById('pcName') as HTMLInputElement | null;
  if (nameEl && m[3]) nameEl.value = decodeURIComponent(m[3]);
  return true;
}

/** Draw the saved pins and wire up the long-press that drops a new one. */
export function initPins(): void {
  renderPinMarkers();

  // Long-press (or right-click) anywhere to identify and optionally save a spot.
  map.on('contextmenu', (e: L.LeafletMouseEvent) => {
    if (isPlanning()) return;
    openNewPin(e.latlng.lat, e.latlng.lng);
  });
}
