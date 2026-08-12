import L from './leaflet-setup';
import './style.css';
import { BASE_LAYERS, BROUTER_PROFILES } from './config';
import { initOffline } from './features/offline';
import {
  catMeta,
  deletePin,
  dismissPinCard,
  getPins,
  hidePinCard,
  initPins,
  openSavedPin,
  openSharedPin
} from './features/pins';
import { getPlan, initPlanner, isPlanning, updatePlanStats } from './features/planner';
import { initQr, startQrScan } from './features/qr';
import {
  clearNearby,
  hideSearchResults,
  initSearch,
  nearbyKindsShort,
  nearbyShown,
  poiKindsNote,
  showNearbyPois
} from './features/search';
import {
  importSharedRoute,
  initSharing,
  openSharePanel,
  pasteSharedRoute
} from './features/sharing';
import {
  beginFollow,
  hereAlongM,
  initTracking,
  isTracking,
  pauseFollow,
  remainingText,
  resetRouteProgress,
  resumeFollow,
  setKnownPosition,
  updateBanner
} from './features/tracking';
import { legendHtml } from './legend';
import { formatDistance } from './geo';
import { toGpx } from './gpx';
import { applyLayers, initMap, map, setOverlayOpacity } from './map/map';
import { DEFAULT_POI_KINDS, POI_CATEGORIES } from './poi';
import {
  loadActiveRoute,
  loadRoutes,
  loadSettings,
  saveActiveRoute,
  saveRoutes,
  saveSettings,
  type SavedRoute,
  type Settings
} from './state';
import { $, downloadFile, svgUse, toast } from './ui/dom';
import { gridText } from './ui/format';
import { climbText, initRouteCard, updateRouteCard } from './ui/routeCard';

// ---------------------------------------------------------------- stored state

const settings = loadSettings();
let routes = loadRoutes();

// ---------------------------------------------------------------- theme
// A pre-paint script in index.html already set data-theme from the saved
// choice; this keeps it in sync when the setting changes, and drives the
// browser-chrome colour and live OS-theme following.
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

/** Whether the effective theme resolves to dark (setting + OS preference). */
function themeIsDark(): boolean {
  return settings.theme === 'dark' || (settings.theme === 'system' && darkQuery.matches);
}

function applyTheme(): void {
  const root = document.documentElement;
  if (settings.theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', settings.theme);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', themeIsDark() ? '#0e1310' : '#ffffff');
}

// Following the OS: react live when it flips between light and dark.
darkQuery.addEventListener('change', () => { if (settings.theme === 'system') applyTheme(); });
applyTheme();

// Tiles, viewport and the startup recentre live in map/map.ts; the one-shot
// startup fix goes to tracking, which owns "where we last were".
initMap({ settings, onStartupPosition: setKnownPosition });

// ---------------------------------------------------------------- active route

let activeRoute: SavedRoute | null = null;
let activeLine: L.Polyline | null = null;

function setActiveRoute(r: SavedRoute | null, fit = true, persist = true): void {
  activeRoute = r;
  resetRouteProgress(); // a freshly loaded route reads from its start
  activeLine?.remove();
  activeLine = null;
  if (r) {
    activeLine = L.polyline(r.coords, {
      color: '#c1121f',
      weight: 4,
      opacity: 0.85
    }).addTo(map);
    if (fit) map.fitBounds(activeLine.getBounds(), { padding: [40, 40] });
    // Opening a route means "show me this route". With Me following, the next
    // fix — a second away — recentres on you and the route you just opened
    // slides off the screen, which is what made loading one feel broken. Pause
    // the centring instead: the dot and the off-route banner stay live, which
    // is exactly what you want while sizing up a route you are not on yet.
    if (fit) pauseFollow();
  }
  if (persist) saveActiveRoute(r); // remember it so a hike survives an app reload
  updateRouteCard();
  updateBanner();
}

// ------------------------------------------------- active-route card

// The card itself lives in ui/routeCard.ts and knows nothing about the planner
// or GPS; this gathers what it should show from the two modules that do, plus
// the active route, which is the app's. A sketch in progress wins over the
// active route, and silences the progress readouts — there is no walking a
// route you are still drawing. The "you are here" mark is deliberately
// conservative: hereAlongM() stays null until a fix lands near the line, so the
// dot never appears at a guessed place.
initRouteCard({
  getView: () => {
    const planning = isPlanning();
    return {
      src: planning ? getPlan() : activeRoute,
      name: planning ? 'New route' : activeRoute?.name ?? '',
      planning,
      remaining: planning ? null : remainingText(),
      hereM: planning ? null : hereAlongM(),
      following: isTracking(),
      speedKmh: settings.speedKmh
    };
  },
  onClose: () => setActiveRoute(null),
  onStart: () => {
    // Begin following this route, or re-centre if GPS is already live.
    if (!isTracking()) beginFollow();
    else resumeFollow();
  }
});

// ---------------------------------------------------------------- route planner

// Sketching a route and importing a GPX file both live in features/planner.ts.
// Neither keeps what it makes: a finished route comes back out through these
// callbacks, because the saved list and the active route are the app's.
initPlanner({
  settings,
  saveRoute: (r) => {
    routes.push(r);
    saveRoutes(routes);
  },
  setActiveRoute,
  hidePanel
});

// ---------------------------------------------------------------- location + on/off route

// The GPS dot, the Me button's follow/heading-up cycle, the on/off-route banner
// and everything derived from a fix live in features/tracking.ts. The route it
// measures progress against is the app's, so it reads it through a getter.
initTracking({ settings, getActiveRoute: () => activeRoute });

// ---------------------------------------------------------------- saved pins

// The pin cards, the long-press that drops one, and the #p= link that shares
// one all live in features/pins.ts. It needs nothing from here: it reads where
// you are through tracking's accessors and asks the planner whether a
// long-press means "identify this spot" or "you are drawing a route".
initPins();

// ---------------------------------------------------------------- search + nearby

// The search box and "What's nearby" share a module: both start from the same
// "where are we looking?" (the live fix, else the map centre), both drop
// markers with the same popup, and both pause following. The Map and Settings
// panels drive nearby, so it exposes state rather than owning a control.
initSearch({ settings });

// ---------------------------------------------------------------- sharing + QR

// Both ends of the #r= link live in features/sharing.ts — writing one as a QR
// and a URL, and reading one back from a paste, a scan or the address bar. Like
// the planner, a received route leaves through these callbacks rather than
// being kept there. features/qr.ts is the camera half, split off because it is
// a different job with different failures and a decoder chunk most people never
// download; it knows only enough to recognise a link and hand it over.
initSharing({
  settings,
  saveRoute: (r) => {
    routes.push(r);
    saveRoutes(routes);
  },
  setActiveRoute,
  showPanel,
  hidePanel
});
initQr({ hidePanel });

// ---------------------------------------------------------------- panels

function hidePanel(): void {
  $('panel').classList.add('hidden');
}

function showPanel(html: string): HTMLElement {
  hidePinCard();
  const content = $('panelContent');
  content.innerHTML = `<button class="closeX" id="panelClose">&times;</button>${html}`;
  $('panel').classList.remove('hidden');
  $('panelClose').addEventListener('click', hidePanel);
  return content;
}

function openMapPanel(): void {
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

function openSettingsPanel(): void {
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

function openRoutesPanel(): void {
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
      } else if (act === 'del') {
        if (!confirm(`Delete “${r.name}”?`)) return;
        routes = routes.filter((x) => x.id !== id);
        saveRoutes(routes);
        if (activeRoute?.id === id) setActiveRoute(null);
        openRoutesPanel();
      }
    });
  });
}

$('btnMap').addEventListener('click', openMapPanel);
$('btnSettings').addEventListener('click', openSettingsPanel);
$('btnRoutes').addEventListener('click', openRoutesPanel);
map.on('click', () => {
  hidePanel();
  hideSearchResults();
  dismissPinCard(); // a no-op when a long-press only just opened it
});

// Bring back the route we were on before a reload (drawn, not re-zoomed — the
// startup geolocation centres you near it). A shared link below overrides it.
const restoredRoute = loadActiveRoute();
if (restoredRoute) setActiveRoute(restoredRoute, false);

importSharedRoute();
openSharedPin();

// ---------------------------------------------------------------- offline tiles

initOffline({ settings, getActiveRoute: () => activeRoute });

// ---------------------------------------------------------------- service worker

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}
