// The bottom sheet and the three things that fill it: Map (base layer, nearby,
// overlay), Settings (theme, key, routing, pace, offline maps) and Routes
// (your saved routes and pins, and the ways of getting more in).
//
// This is the last module out of main.ts and the most cross-cutting by nature:
// a panel is where several features meet a single screen. It deliberately owns
// none of them — every row here calls into the feature that owns the behaviour,
// which is why this was extracted after all of them rather than before.
//
// The one thing it does own is the shell: showPanel() renders HTML into the
// sheet and raises the scrim behind it; hidePanel() puts both away. The sheet's
// own chrome — the grab handle and the close button — lives in index.html and
// is wired once in initPanels(), because it outlives any one panel.

import { BASE_LAYERS, BROUTER_PROFILES } from '../config';
import { catMeta, deletePin, getPins, hidePinCard, openSavedPin } from '../features/pins';
import { endPlanning, updatePlanStats } from '../features/planner';
import { startQrScan } from '../features/qr';
import { nearbyOn, toggleNearby } from '../features/search';
import { openSharePanel, pasteSharedRoute } from '../features/sharing';
import { clearOfflineTiles, formatBytes, offlineUsage } from '../features/storage';
import { pauseFollow } from '../features/tracking';
import { formatDistance } from '../geo';
import { toGpx } from '../gpx';
import { legendHtml } from '../legend';
import { applyLayers, map, setOverlayOpacity } from '../map/map';
import { POI_CATEGORIES, type PoiKind } from '../poi';
import { saveSettings, type SavedRoute, type Settings } from '../state';
import { $, downloadFile, hideToast, svgUse, toast } from './dom';
import { gridText } from './format';
import { climbText, updateRouteCard } from './routeCard';
import { initSheetDrag } from './sheet';

// Owned by the app and shared by reference; the panels are where most of the
// settings are actually changed.
let settings: Settings;
let getRoutes: () => SavedRoute[];
let deleteRoute: (r: SavedRoute) => boolean;
let setActiveRoute: (r: SavedRoute | null, fit?: boolean, persist?: boolean) => void;
let applyTheme: () => void;

// ---------------------------------------------------------------- the shell

// The tab buttons that open a sheet. Plan is deliberately not one of them: it
// enters a mode rather than opening a screen, and it is setPlanning() itself
// that calls hidePanel(), a moment after lighting the Plan tab — sweeping the
// Plan tab up with the others here would put it straight back out again.
const SHEET_TABS = ['btnMap', 'btnRoutes', 'btnSettings'];

/** Un-light whichever tab opened the sheet. */
function clearTabs(): void {
  for (const id of SHEET_TABS) $(id).classList.remove('active');
}

/** Put the drag gesture back to rest; set by initPanels(). */
let resetSheetDrag: () => void = () => {};

export function hidePanel(): void {
  $('panel').classList.add('hidden');
  $('panelScrim').classList.add('hidden');
  // Every way out of a sheet comes through here — the close button, the scrim,
  // the tab, a drag, and Plan — so this is the one place that has to leave
  // things square: no tab left lit, and no half-finished drag transform or
  // faded scrim for the next sheet to open into.
  clearTabs();
  resetSheetDrag();
}

/** Fill the panel with `html` and show it. */
export function showPanel(html: string, title = ''): HTMLElement {
  hidePinCard();
  // Only ever one of the four tabs is on, in both directions: Plan puts away an
  // open sheet, and a sheet opening steps out of Plan. Plan's sheet rests on
  // the tab bar in exactly the place this one does, so without this the two
  // would stack, with Plan still taking map taps behind the scrim. Nothing of
  // the sketch is lost; see endPlanning().
  endPlanning();
  const content = $('panelContent');
  content.innerHTML = html;
  // The tab's name, in the header strip. Panels that carry their own <h3>
  // (the map key, the share sheets) pass none, so they aren't titled twice.
  $('panelTitle').textContent = title;
  // Swapping one sheet for another (Map → Saved, or Map → the map key) leaves
  // the old tab lit unless we clear here too; whoever opened this one lights
  // its own tab afterwards.
  clearTabs();
  // A panel opened while the last one was still mid-spring would inherit its
  // transform and sit somewhere down the screen.
  resetSheetDrag();
  $('panel').classList.remove('hidden');
  $('panelScrim').classList.remove('hidden');
  // Back to the top: the sheet is reused, so a panel opened after a scrolled
  // one would otherwise start half way down its own content.
  $('panel').scrollTop = 0;
  return content;
}

// ---------------------------------------------------------------- map panel

export function openMapPanel(): void {
  const baseRows = BASE_LAYERS.map(
    (l) => `<div class="row">
      <input type="radio" name="base" id="base-${l.id}" value="${l.id}" ${settings.baseLayer === l.id ? 'checked' : ''}/>
      <label for="base-${l.id}">${l.name}${
        l.needsTfKey && !settings.tfKey ? ' <span class="warn">(needs key)</span>' : ''
      }${l.blurb ? `<span class="keyNote">${l.blurb}</span>` : ''}</label>
    </div>`
  ).join('');
  const overlayOpts = ['<option value="">None</option>']
    .concat(BASE_LAYERS.map((l) => `<option value="${l.id}" ${settings.overlayLayer === l.id ? 'selected' : ''}>${l.name}</option>`))
    .join('');
  showPanel(`
    <h4 class="secTitle">Base map</h4>
    <div class="cells">${baseRows}</div>
    <button id="keyBtn" class="secondary wide">Map key — what the symbols mean</button>
    <h4 class="secTitle">Nearby</h4>
    <div class="pc-chips nearbyChips">${POI_CATEGORIES.map(
      (c) => `<button class="pc-chip" data-kind="${c.id}">
        <span class="poiSwatch" style="background:${c.colour}">${svgUse(c.icon)}</span>${c.plural}
      </button>`
    ).join('')}</div>
    <p class="hint">Shows what OpenStreetMap has around the visible map. Needs signal, and the
    free servers are sometimes busy — tick it again if one fails.</p>
    <h4 class="secTitle">Overlay</h4>
    <select id="overlaySel">${overlayOpts}</select>
    <div class="cells">
      <div class="row"><label>Opacity</label>
        <input type="range" id="overlayOp" min="0.1" max="0.9" step="0.1" value="${settings.overlayOpacity}"/>
      </div>
    </div>
  `, 'Map');

  BASE_LAYERS.forEach((l) => {
    $(`base-${l.id}`).addEventListener('change', () => {
      settings.baseLayer = l.id;
      applyLayers();
    });
  });
  $('overlaySel').addEventListener('change', (e) => {
    settings.overlayLayer = (e.target as HTMLSelectElement).value;
    applyLayers();
  });
  $('overlayOp').addEventListener('input', (e) => {
    settings.overlayOpacity = parseFloat((e.target as HTMLInputElement).value);
    setOverlayOpacity(settings.overlayOpacity);
    saveSettings(settings);
  });
  $('keyBtn').addEventListener('click', () =>
    showPanel(legendHtml(settings.baseLayer))
  );
  // Each chip is its own layer. The sheet stays open so several can be ticked;
  // a chip whose search finds nothing or fails turns itself back off.
  document.querySelectorAll<HTMLButtonElement>('.nearbyChips .pc-chip').forEach((chip) => {
    const kind = chip.dataset.kind as PoiKind;
    const sync = () => {
      chip.classList.toggle('on', nearbyOn(kind));
      chip.setAttribute('aria-pressed', String(nearbyOn(kind)));
    };
    sync();
    chip.addEventListener('click', async () => {
      const done = toggleNearby(kind);
      sync();
      await done;
      sync();
    });
  });
}

// ---------------------------------------------------------------- settings panel

export function openSettingsPanel(): void {
  const profileOpts = BROUTER_PROFILES.map(
    (p) => `<option value="${p.id}" ${settings.profile === p.id ? 'selected' : ''}>${p.label}</option>`
  ).join('');
  const profileDesc = (id: string) =>
    BROUTER_PROFILES.find((p) => p.id === id)?.desc ?? '';

  showPanel(`
    <h4 class="secTitle">Appearance</h4>
    <div class="themeSeg" id="themeSeg">
      <button data-theme="light"><svg viewBox="0 0 24 24"><use href="#i-sun"/></svg>Light</button>
      <button data-theme="dark"><svg viewBox="0 0 24 24"><use href="#i-moon"/></svg>Dark</button>
      <button data-theme="system"><svg viewBox="0 0 24 24"><use href="#i-auto"/></svg>System</button>
    </div>
    <p class="hint">Dark keeps the map at full brightness. System follows your phone.</p>
    <h4 class="secTitle">Thunderforest API key</h4>
    <input type="password" id="tfKeyInput" value="${settings.tfKey}" placeholder="Thunderforest key"/>
    <p class="hint">Powers the Outdoors base map. Free "Hobby Project" plan at
    thunderforest.com — 150,000 tiles a month, far more than one walker uses.</p>
    <h4 class="secTitle">Routing profile</h4>
    <select id="profileSel">${profileOpts}</select>
    <p class="hint" id="profileHint">${profileDesc(settings.profile)}</p>
    <h4 class="secTitle">Walking speed</h4>
    <div class="cells">
      <div class="row">
        <input type="number" id="speedInput" class="narrow" min="1" max="8" step="0.5" value="${settings.speedKmh}"/>
        <label>km/h</label>
      </div>
    </div>
    <p class="hint">Your pace on the flat. Time estimates add 1 h per 600 m of climb (Naismith's rule).</p>
    <h4 class="secTitle">Offline maps</h4>
    <p class="hint" id="offlineUsage">Checking…</p>
    <button id="offlineClear" class="danger wide">Clear all offline maps</button>
    <p class="hint">Map saved on this phone: what you downloaded for a route, plus anything the
    app kept automatically as you looked around. Your routes, pins and settings are kept —
    this clears saved map only. Anything you still want offline needs downloading again from
    its route card.</p>
    <p class="hint">App version ${typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev'} (UTC).
    A new deploy loads by itself when you open the app, or offers an Update button if you are already using it.</p>
  `, 'Settings');

  const themeSeg = $('themeSeg');
  const themeBtns = Array.from(themeSeg.querySelectorAll('button')) as HTMLButtonElement[];
  const markTheme = () =>
    themeBtns.forEach((b) => b.classList.toggle('sel', b.dataset.theme === settings.theme));
  markTheme();
  themeBtns.forEach((b) =>
    b.addEventListener('click', () => {
      settings.theme = b.dataset.theme as Settings['theme'];
      saveSettings(settings);
      applyTheme();
      markTheme();
    })
  );

  $('tfKeyInput').addEventListener('change', (e) => {
    settings.tfKey = (e.target as HTMLInputElement).value.trim();
    saveSettings(settings);
    applyLayers();
    toast(settings.tfKey ? 'Thunderforest key saved — pick Outdoors in Map' : 'Thunderforest key cleared');
  });
  $('profileSel').addEventListener('change', (e) => {
    settings.profile = (e.target as HTMLSelectElement).value;
    saveSettings(settings);
    $('profileHint').textContent = profileDesc(settings.profile);
  });
  $('speedInput').addEventListener('change', (e) => {
    const v = parseFloat((e.target as HTMLInputElement).value);
    if (Number.isFinite(v) && v > 0) {
      settings.speedKmh = v;
      saveSettings(settings);
      updatePlanStats();
      updateRouteCard();
    }
  });

  // Read the storage figures now, and again after a clear. Both elements are
  // grabbed before the first await: the panel can be closed mid-read, and a
  // reference taken while it was open writes harmlessly into a detached node
  // rather than throwing on a missing id.
  const usageEl = $('offlineUsage');
  const clearBtn = $<HTMLButtonElement>('offlineClear');
  const showUsage = async () => {
    const { tiles, bytes } = await offlineUsage();
    // The byte figure covers everything the app has stored, not the tiles
    // alone, and it is the browser's own rough estimate — say so, rather than
    // implying a precision that isn't there.
    const total = bytes === null ? '' : ` · about ${formatBytes(bytes)} of app data in total`;
    usageEl.textContent = tiles
      ? `${tiles.toLocaleString()} map tiles saved${total}`
      : 'No map saved for offline use yet.';
  };
  void showUsage();

  clearBtn.addEventListener('click', async () => {
    const { tiles } = await offlineUsage();
    if (!tiles) return toast('There is no saved map to clear');
    if (!confirm(`Delete all ${tiles.toLocaleString()} saved map tiles? Your routes and pins are kept.`)) return;
    clearBtn.disabled = true;
    toast('Clearing offline maps…', 0);
    const removed = await clearOfflineTiles();
    hideToast();
    clearBtn.disabled = false;
    toast(`Cleared ${removed.toLocaleString()} map tiles`, 4000);
    void showUsage();
  });
}

// ---------------------------------------------------------------- routes panel

export function openRoutesPanel(): void {
  const routes = getRoutes();
  const items = routes.length
    ? routes
        .map(
          (r) => `<div class="routeItem" data-id="${r.id}">
        <div class="rowMain">
          <div class="meta">
            <div class="name">${r.name.replace(/</g, '&lt;')}</div>
            <div class="sub">${formatDistance(r.distanceM)}${r.ascentM ? ` · ${climbText(r.ascentM, r.descentM)}` : ''}</div>
          </div>
        </div>
        <div class="rowActs">
          <button data-act="load">Load</button>
          <button data-act="share" class="secondary">Share</button>
          <button data-act="gpx" class="secondary">GPX</button>
          <button data-act="del" class="danger" aria-label="Delete route" title="Delete route">${svgUse('i-trash')}</button>
        </div>
      </div>`
        )
        .join('')
    : '<p class="hint">No saved routes yet. Import a GPX or plan one with the pencil tool.</p>';

  const pins = getPins();
  const pinItems = pins.length
    ? pins
        .map(
          (p) => `<div class="routeItem" data-pin="${p.id}">
        <div class="rowMain">
          <span class="pinCat">${svgUse(catMeta(p.category).icon)}</span>
          <div class="meta">
            <div class="name">${p.name.replace(/</g, '&lt;')}</div>
            <div class="sub">${gridText(p.lat, p.lng)}${typeof p.ele === 'number' ? ` · ${Math.round(p.ele)} m` : ''}</div>
          </div>
        </div>
        <div class="rowActs">
          <button data-pact="go">Go</button>
          <button data-pact="del" class="danger" aria-label="Delete pin" title="Delete pin">${svgUse('i-trash')}</button>
        </div>
      </div>`
        )
        .join('')
    : '<p class="hint">No pins yet. Long-press the map to drop one.</p>';

  const content = showPanel(`
    <h4 class="secTitle">Routes</h4>
    ${items}
    <h4 class="secTitle">Pins</h4>
    ${pinItems}
    <h4 class="secTitle">Add a route</h4>
    <button id="scanQr" class="wide">Scan route QR</button>
    <button id="pasteRoute" class="secondary wide">Paste shared route</button>
    <button id="importBtn" class="secondary wide">Import GPX file</button>
    <p class="hint">Scan a route's QR straight off another screen, or paste a copied route link.</p>
  `, 'Saved');
  $('scanQr').addEventListener('click', startQrScan);

  content.querySelectorAll<HTMLButtonElement>('.routeItem[data-pin] button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = (btn.closest('.routeItem') as HTMLElement).dataset.pin!;
      const pin = pins.find((x) => x.id === id);
      if (!pin) return;
      if (btn.dataset.pact === 'go') {
        hidePanel();
        pauseFollow(); // the pin is the point of the tap; don't let a fix drag us off it
        map.setView([pin.lat, pin.lng], Math.max(map.getZoom(), 15));
        openSavedPin(pin.id);
      } else if (deletePin(pin.id)) {
        openRoutesPanel(); // redraw the list without it
      }
    });
  });
  $('importBtn').addEventListener('click', () => $('gpxFile').click());
  $('pasteRoute').addEventListener('click', pasteSharedRoute);

  content.querySelectorAll<HTMLButtonElement>('.routeItem[data-id] button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = (btn.closest('.routeItem') as HTMLElement).dataset.id!;
      const r = routes.find((x) => x.id === id);
      if (!r) return;
      const act = btn.dataset.act;
      if (act === 'load') {
        setActiveRoute(r);
        hidePanel();
      } else if (act === 'share') {
        openSharePanel(r);
      } else if (act === 'gpx') {
        downloadFile(`${r.name}.gpx`, toGpx(r.name, r.coords), 'application/gpx+xml');
      } else if (act === 'del' && deleteRoute(r)) {
        openRoutesPanel(); // redraw the list without it
      }
    });
  });
}

// ---------------------------------------------------------------- wiring

/**
 * Hand the panels what they need. Nothing to listen to here — main.ts wires the
 * three nav buttons, since which button opens which panel is app navigation
 * rather than panel content.
 */
export function initPanels(opts: {
  settings: Settings;
  /** The saved routes, read fresh each render — the list is reassigned on delete. */
  getRoutes: () => SavedRoute[];
  /** Confirm and delete a route; true if it went, so the list can redraw. */
  deleteRoute: (r: SavedRoute) => boolean;
  setActiveRoute: (r: SavedRoute | null, fit?: boolean, persist?: boolean) => void;
  /** Re-apply the theme after the Settings panel changes it. */
  applyTheme: () => void;
}): void {
  settings = opts.settings;
  getRoutes = opts.getRoutes;
  deleteRoute = opts.deleteRoute;
  setActiveRoute = opts.setActiveRoute;
  applyTheme = opts.applyTheme;
  // All wired once, here, rather than on every showPanel: the scrim and the
  // sheet's header are always in the document, only their visibility changes.
  $('panelScrim').addEventListener('click', hidePanel);
  $('panelClose').addEventListener('click', hidePanel);
  resetSheetDrag = initSheetDrag({
    sheet: $('panel'),
    handle: $('panelHead'),
    scrim: $('panelScrim'),
    close: hidePanel
  });
}
