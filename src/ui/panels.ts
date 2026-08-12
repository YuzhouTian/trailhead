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
import { pauseFollow } from '../features/tracking';
import { formatDistance } from '../geo';
import { toGpx } from '../gpx';
import { legendHtml } from '../legend';
import { applyLayers, map, setOverlayOpacity } from '../map/map';
import { DEFAULT_POI_KINDS, POI_CATEGORIES } from '../poi';
import { saveSettings, type SavedRoute, type Settings } from '../state';
import { $, downloadFile, svgUse, toast } from './dom';
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
  content.innerHTML = `<button class="closeX" id="panelClose">&times;</button>${html}`;
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
        l.needsTfKey && !settings.tfKey ? ' <span style="color:var(--danger)">(needs key)</span>' : ''
      }${l.blurb ? `<span class="keyNote">${l.blurb}</span>` : ''}</label>
    </div>`
  ).join('');
  const overlayOpts = ['<option value="">None</option>']
    .concat(BASE_LAYERS.map((l) => `<option value="${l.id}" ${settings.overlayLayer === l.id ? 'selected' : ''}>${l.name}</option>`))
    .join('');
  showPanel(`
    <h3>Base map</h3>
    ${baseRows}
    <div class="row"><button id="keyBtn" class="secondary" style="flex:1">Map key — what the symbols mean</button></div>
    <hr/>
    <h3>Nearby</h3>
    <p class="hint">${
      settings.poiKinds.length
        ? `Looks for ${nearbyKindsShort()} from OpenStreetMap, around what you can see —
           change what it looks for in Settings.`
        : 'No categories are ticked — choose what to look for in Settings.'
    }
    Needs signal, and the free map-data servers are sometimes busy — retry if it fails. Tap again to hide.</p>
    <div class="row"><button id="poiBtn" style="flex:1" ${
      settings.poiKinds.length ? '' : 'disabled'
    }>${nearbyShown() ? 'Hide nearby points' : "What's nearby"}</button></div>
    <hr/>
    <h3>Overlay</h3>
    <div class="row"><select id="overlaySel" style="flex:1">${overlayOpts}</select></div>
    <div class="row"><label>Opacity</label>
      <input type="range" id="overlayOp" min="0.1" max="0.9" step="0.1" value="${settings.overlayOpacity}"/>
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
    <h3>Appearance</h3>
    <div class="themeSeg" id="themeSeg">
      <button data-theme="light"><svg viewBox="0 0 24 24"><use href="#i-sun"/></svg>Light</button>
      <button data-theme="dark"><svg viewBox="0 0 24 24"><use href="#i-moon"/></svg>Dark</button>
      <button data-theme="system"><svg viewBox="0 0 24 24"><use href="#i-auto"/></svg>System</button>
    </div>
    <p class="hint">Dark dims the map as well as the app. System follows your phone.</p>
    <hr/>
    <h3>Thunderforest API key</h3>
    <p class="hint">Powers the Outdoors base map. Free "Hobby Project" plan at
    thunderforest.com — 150,000 tiles a month, far more than one walker uses.</p>
    <div class="row"><input type="password" id="tfKeyInput" value="${settings.tfKey}" placeholder="Thunderforest key"/></div>
    <hr/>
    <h3>Routing profile</h3>
    <div class="row"><select id="profileSel" style="flex:1">${profileOpts}</select></div>
    <p class="hint" id="profileHint">${profileDesc(settings.profile)}</p>
    <hr/>
    <h3>Walking speed</h3>
    <p class="hint">Your pace on the flat. Time estimates add 1 h per 600 m of climb (Naismith's rule).</p>
    <div class="row">
      <input type="number" id="speedInput" min="1" max="8" step="0.5" value="${settings.speedKmh}" style="width:70px"/>
      <label>km/h</label>
    </div>
    <hr/>
    <h3>What's nearby</h3>
    <p class="hint">What the Map tab's "What's nearby" looks for. Only the ticked categories are
    asked for, so a short list is a faster, more reliable search.</p>
    ${POI_CATEGORIES.map(
      (c) => `<div class="row">
        <input type="checkbox" id="poiKind-${c.id}" ${settings.poiKinds.includes(c.id) ? 'checked' : ''}/>
        <span class="poiSwatch" style="border-color:${c.colour}">${c.icon}</span>
        <label for="poiKind-${c.id}" style="flex:1">${c.plural}</label>
      </div>`
    ).join('')}
    <p class="hint" id="poiKindsNote">${poiKindsNote()}</p>
    <div class="row"><button id="poiKindsReset" class="secondary" style="flex:1">Back to the usual three</button></div>
    <hr/>
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
          <button data-act="del" class="danger">✕</button>
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
          <button data-pact="del" class="danger">✕</button>
        </div>
      </div>`
        )
        .join('')
    : '<p class="hint">No pins yet. Long-press the map to drop one.</p>';

  const content = showPanel(`
    <h3>Routes</h3>
    ${items}
    <hr/>
    <h3>Pins</h3>
    ${pinItems}
    <hr/>
    <div class="row"><button id="scanQr" style="flex:1">Scan route QR</button></div>
    <div class="row"><button id="pasteRoute" class="secondary" style="flex:1">Paste shared route</button></div>
    <div class="row"><button id="importBtn" class="secondary" style="flex:1">Import GPX file</button></div>
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
