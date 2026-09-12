// The sliding panel and the three things that fill it: Map (base layer, nearby,
// overlay), Settings (theme, key, routing, pace, nearby categories) and Routes
// (your saved routes and pins, and the ways of getting more in).
//
// This is the last module out of main.ts and the most cross-cutting by nature:
// a panel is where several features meet a single screen. It deliberately owns
// none of them — every row here calls into the feature that owns the behaviour,
// which is why this was extracted after all of them rather than before.
//
// The one thing it does own is the shell: showPanel() renders HTML into the
// panel and wires its close button, hidePanel() puts it away.

import { BASE_LAYERS, BROUTER_PROFILES } from '../config';
import { catMeta, deletePin, getPins, hidePinCard, openSavedPin } from '../features/pins';
import { updatePlanStats } from '../features/planner';
import { startQrScan } from '../features/qr';
import {
  clearNearby,
  nearbyKindsShort,
  nearbyShown,
  poiKindsNote,
  showNearbyPois
} from '../features/search';
import { openSharePanel, pasteSharedRoute } from '../features/sharing';
import { clearOfflineTiles, formatBytes, offlineUsage } from '../features/storage';
import { pauseFollow } from '../features/tracking';
import { formatDistance } from '../geo';
import { toGpx } from '../gpx';
import { legendHtml } from '../legend';
import { applyLayers, map, setOverlayOpacity } from '../map/map';
import { DEFAULT_POI_KINDS, POI_CATEGORIES } from '../poi';
import { saveSettings, type SavedRoute, type Settings } from '../state';
import { $, downloadFile, hideToast, svgUse, toast } from './dom';
import { gridText } from './format';
import { climbText, updateRouteCard } from './routeCard';

// Owned by the app and shared by reference; the panels are where most of the
// settings are actually changed.
let settings: Settings;
let getRoutes: () => SavedRoute[];
let deleteRoute: (r: SavedRoute) => boolean;
let setActiveRoute: (r: SavedRoute | null, fit?: boolean, persist?: boolean) => void;
let applyTheme: () => void;

// ---------------------------------------------------------------- the shell

export function hidePanel(): void {
  $('panel').classList.add('hidden');
}

/** Fill the panel with `html`, wire its close button, and show it. */
export function showPanel(html: string): HTMLElement {
  hidePinCard();
  const content = $('panelContent');
  content.innerHTML = `<button class="closeX" id="panelClose" aria-label="Close">${svgUse('i-close')}</button>${html}`;
  $('panel').classList.remove('hidden');
  $('panelClose').addEventListener('click', hidePanel);
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
    <p class="hint">${
      settings.poiKinds.length
        ? `Looks for ${nearbyKindsShort()} from OpenStreetMap, around what you can see —
           change what it looks for in Settings.`
        : 'No categories are ticked — choose what to look for in Settings.'
    }
    Needs signal, and the free map-data servers are sometimes busy — retry if it fails. Tap again to hide.</p>
    <button id="poiBtn" class="wide" ${
      settings.poiKinds.length ? '' : 'disabled'
    }>${nearbyShown() ? 'Hide nearby points' : "What's nearby"}</button>
    <h4 class="secTitle">Overlay</h4>
    <select id="overlaySel">${overlayOpts}</select>
    <div class="cells">
      <div class="row"><label>Opacity</label>
        <input type="range" id="overlayOp" min="0.1" max="0.9" step="0.1" value="${settings.overlayOpacity}"/>
      </div>
    </div>
  `);

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
    showPanel(legendHtml(settings.baseLayer, settings.poiKinds))
  );
  $('poiBtn').addEventListener('click', () => {
    hidePanel();
    showNearbyPois();
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
    <h4 class="secTitle">What's nearby</h4>
    <div class="cells">${POI_CATEGORIES.map(
      (c) => `<div class="row">
        <input type="checkbox" id="poiKind-${c.id}" ${settings.poiKinds.includes(c.id) ? 'checked' : ''}/>
        <span class="poiSwatch" style="background:${c.colour}">${svgUse(c.icon)}</span>
        <label for="poiKind-${c.id}">${c.plural}</label>
      </div>`
    ).join('')}</div>
    <p class="hint" id="poiKindsNote">${poiKindsNote()}</p>
    <button id="poiKindsReset" class="secondary wide">Back to the usual three</button>
    <p class="hint">What the Map tab's "What's nearby" looks for. Only the ticked categories are
    asked for, so a short list is a faster, more reliable search.</p>
    <h4 class="secTitle">Offline maps</h4>
    <p class="hint" id="offlineUsage">Checking…</p>
    <button id="offlineClear" class="danger wide">Clear all offline maps</button>
    <p class="hint">Map saved on this phone: what you downloaded for a route, plus anything the
    app kept automatically as you looked around. Your routes, pins and settings are kept —
    this clears saved map only. Anything you still want offline needs downloading again from
    its route card.</p>
    <p class="hint">App version ${typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev'} (UTC).
    If this looks old after a deploy, fully close the app from the app switcher and reopen it.</p>
  `);

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

  const syncPoiKinds = () => {
    POI_CATEGORIES.forEach((c) => {
      ($(`poiKind-${c.id}`) as HTMLInputElement).checked = settings.poiKinds.includes(c.id);
    });
    $('poiKindsNote').textContent = poiKindsNote();
    // Markers already on the map would no longer match the tick list, so drop
    // them; the Map tab's button asks again with the new selection.
    clearNearby();
    saveSettings(settings);
  };
  POI_CATEGORIES.forEach((c) => {
    $(`poiKind-${c.id}`).addEventListener('change', (e) => {
      const on = (e.target as HTMLInputElement).checked;
      settings.poiKinds = on
        ? // Keep table order, so the toast and the map key read the same way.
          POI_CATEGORIES.filter((x) => x.id === c.id || settings.poiKinds.includes(x.id)).map((x) => x.id)
        : settings.poiKinds.filter((id) => id !== c.id);
      syncPoiKinds();
    });
  });
  $('poiKindsReset').addEventListener('click', () => {
    settings.poiKinds = [...DEFAULT_POI_KINDS];
    syncPoiKinds();
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
  `);
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
}
