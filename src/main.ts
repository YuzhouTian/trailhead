import L from './leaflet-setup';
import './style.css';
import { BASE_LAYERS, BROUTER_PROFILES } from './config';
import qrcode from 'qrcode-generator';
import { initOffline } from './features/offline';
import {
  catMeta,
  deletePin,
  dismissPinCard,
  getPins,
  gridText,
  hidePinCard,
  initPins,
  openSavedPin,
  openSharedPin
} from './features/pins';
import { getPlan, initPlanner, isPlanning, updatePlanStats } from './features/planner';
import {
  beginFollow,
  getKnownPosition,
  getLastFix,
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
import { computeClimbs, formatDistance, haversine, type LatLng } from './geo';
import { toGpx } from './gpx';
import { applyLayers, initMap, map, setOverlayOpacity } from './map/map';
import { formatGridRef } from './osgb';
import {
  DEFAULT_POI_KINDS,
  POI_CATEGORIES,
  POI_KINDS_ADVISORY,
  describeKinds,
  fetchPois,
  poiCategory,
  type Poi
} from './poi';
import { routeMixed } from './routing';
import { search, type SearchHit } from './search';
import { buildShareUrl, parseShareHash, type ParsedShare } from './share';
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
import { $, downloadFile, hideToast, svgUse, toast } from './ui/dom';
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
initTracking({ settings, getActiveRoute: () => activeRoute, positionText });

// ---------------------------------------------------------------- grid references

/** Human-readable position line: grid ref where we have one, plus lat/lng. */
function positionText(p: LatLng): string {
  const grid = formatGridRef(p[0], p[1], 4);
  const ll = `${p[0].toFixed(5)}, ${p[1].toFixed(5)}`;
  return grid ? `<b>${grid}</b><br>${ll}` : ll;
}

// ---------------------------------------------------------------- saved pins

// The pin cards, the long-press that drops one, and the #p= link that shares
// one all live in features/pins.ts. It needs nothing from here: it reads where
// you are through tracking's accessors and asks the planner whether a
// long-press means "identify this spot" or "you are drawing a route".
initPins();

// ---------------------------------------------------------------- search

let searchAbort: AbortController | null = null;
let searchTimer: number | undefined;
let searchMarker: L.Marker | null = null;

function hideSearchResults(): void {
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

$('searchInput').addEventListener('input', () => {
  const q = ($('searchInput') as HTMLInputElement).value;
  $('searchClear').classList.toggle('hidden', !q);
  window.clearTimeout(searchTimer);
  searchAbort?.abort();
  if (q.trim().length < 2) return hideSearchResults();
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
  }, 400);
});

$('searchClear').addEventListener('click', () => {
  ($('searchInput') as HTMLInputElement).value = '';
  $('searchClear').classList.add('hidden');
  hideSearchResults();
  searchMarker?.remove();
  searchMarker = null;
});

// ---------------------------------------------------------------- nearby POIs

let poiLayer: L.LayerGroup | null = null;

async function showNearbyPois(): Promise<void> {
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
    Math.max(haversine([bounds.getNorth(), bounds.getWest()], [bounds.getSouth(), bounds.getEast()]) / 2, 800),
    12000
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
    }>${poiLayer ? 'Hide nearby points' : "What's nearby"}</button></div>
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
    poiLayer?.remove();
    poiLayer = null;
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

/** Naming a few reads better than a generic count; a long list does not. */
function nearbyKindsShort(): string {
  const n = settings.poiKinds.length;
  return n <= 4 ? describeKinds(settings.poiKinds) : `${n} categories`;
}

/** The line under the nearby tick list: what it will search, and any warning. */
function poiKindsNote(): string {
  const n = settings.poiKinds.length;
  if (!n) return 'Nothing ticked — "What\'s nearby" has nothing to look for.';
  if (n > POI_KINDS_ADVISORY) {
    return `${n} categories — a big ask of a free shared server. It should still take seconds, but expect the odd retry.`;
  }
  return `Searching for ${describeKinds(settings.poiKinds)}.`;
}

// ---------------------------------------------------------------- QR import (camera)

let qrStream: MediaStream | null = null;
let qrRAF: number | null = null;

function stopQrScan(): void {
  if (qrRAF !== null) cancelAnimationFrame(qrRAF);
  qrRAF = null;
  qrStream?.getTracks().forEach((t) => t.stop());
  qrStream = null;
  ($('qrVideo') as HTMLVideoElement).srcObject = null;
  $('qrScan').classList.add('hidden');
}

/** Open the camera and watch for a Trailhead route QR, importing the first one
 *  seen. Other QR codes are ignored so it keeps looking. */
async function startQrScan(): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) {
    return toast('No camera access in this app', 4000);
  }
  const video = $('qrVideo') as HTMLVideoElement;
  // The decoder is a chunk of its own, fetched only the first time you scan, so
  // it never weighs down the app for people who don't. Cached after first use.
  let jsQR: typeof import('jsqr').default;
  try {
    jsQR = (await import('jsqr')).default;
  } catch {
    return toast('Could not load the scanner — connect to the internet once and retry', 5000);
  }
  try {
    // Ask for a high-resolution rear stream — the default is often 640×480,
    // too coarse to resolve a QR across the room on a monitor. `ideal` degrades
    // gracefully on cameras that can't hit it.
    qrStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'environment',
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      }
    });
  } catch {
    return toast('Camera blocked — allow it for this site in Settings', 5000);
  }
  hidePanel();
  video.srcObject = qrStream;
  await video.play().catch(() => {});
  $('qrScan').classList.remove('hidden');

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return stopQrScan();

  // Decode a centred square crop at full resolution (the QR sits in the middle
  // reticle), capped so a big frame doesn't stall the decode loop. This spends
  // the sensor's pixels where the code actually is.
  const DECODE_MAX = 1024;
  // A QR code doesn't change between frames, so decoding at the full 60fps
  // rAF rate is wasted CPU/battery for a getImageData readback this size.
  const DECODE_INTERVAL_MS = 120;
  let lastDecode = 0;
  const tick = () => {
    qrRAF = requestAnimationFrame(tick);
    const now = performance.now();
    if (now - lastDecode < DECODE_INTERVAL_MS) return;
    lastDecode = now;
    if (video.readyState !== video.HAVE_ENOUGH_DATA) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;
    const side = Math.min(vw, vh);
    const dim = Math.min(side, DECODE_MAX);
    canvas.width = dim;
    canvas.height = dim;
    ctx.drawImage(video, (vw - side) / 2, (vh - side) / 2, side, side, 0, 0, dim, dim);
    const img = ctx.getImageData(0, 0, dim, dim);
    const code = jsQR(img.data, dim, dim, { inversionAttempts: 'dontInvert' });
    if (!code) return;
    const m = code.data.match(/#r=[A-Za-z0-9_-]+/);
    let parsed: ParsedShare | null = null;
    try {
      parsed = m && parseShareHash(m[0]);
    } catch { /* not a valid route link — keep scanning */ }
    if (!parsed) return; // some other QR, ignore and keep looking
    stopQrScan();
    void importParsed(parsed);
  };
  qrRAF = requestAnimationFrame(tick);
}

$('qrCancel').addEventListener('click', stopQrScan);

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
  $('pasteRoute').addEventListener('click', async () => {
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch {
      text = prompt('Paste the route link:') ?? '';
    }
    const m = text.match(/#r=[A-Za-z0-9_-]+/);
    let parsed: ParsedShare | null = null;
    try {
      parsed = m && parseShareHash(m[0]);
    } catch { /* fall through to toast */ }
    if (!parsed) return toast('No route link found on the clipboard', 4000);
    hidePanel();
    await importParsed(parsed);
  });

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

function openSharePanel(r: SavedRoute): void {
  const url = buildShareUrl(r, settings.profile);
  let qrHtml: string;
  try {
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    qrHtml = `<div class="qrBox">${qr.createSvgTag({ cellSize: 4, margin: 2 })}</div>`;
  } catch {
    qrHtml = '<p class="hint">Route too detailed for a QR code — use the link instead.</p>';
  }
  showPanel(`
    <h3>Share “${r.name.replace(/</g, '&lt;')}”</h3>
    <p class="hint">Scan with your phone's camera to open this route in Trailhead on the phone
    (it saves itself automatically), or copy the link and send it any way you like.</p>
    ${qrHtml}
    <div class="row"><button id="copyLink" style="flex:1">Copy link</button></div>
  `);
  $('copyLink').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied');
    } catch {
      prompt('Copy the link:', url);
    }
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

// ---------------------------------------------------------------- shared-link import

/** Import a parsed share payload: re-route (waypoint shares), save, activate. */
async function importParsed(parsed: ParsedShare): Promise<void> {
  try {
    let r: SavedRoute;
    if (parsed.waypoints) {
      toast('Loading shared route…', 0);
      const res = await routeMixed(
        parsed.waypoints,
        parsed.snaps,
        parsed.profile || settings.profile
      );
      r = {
        id: String(Date.now()),
        name: parsed.name,
        waypoints: parsed.waypoints,
        snaps: parsed.snaps ?? null,
        coords: res.coords,
        distanceM: res.distanceM,
        ascentM: res.ascentM,
        descentM: res.descentM,
        createdAt: Date.now()
      };
    } else {
      const coords = parsed.coords!;
      let dist = 0;
      for (let i = 1; i < coords.length; i++) dist += haversine(coords[i - 1], coords[i]);
      r = {
        id: String(Date.now()),
        name: parsed.name,
        waypoints: null,
        coords,
        distanceM: dist,
        ...computeClimbs(coords),
        createdAt: Date.now()
      };
    }
    hideToast();
    routes.push(r);
    saveRoutes(routes);
    setActiveRoute(r);
    toast(`Loaded “${r.name}” (${formatDistance(r.distanceM)})`);
  } catch (e) {
    hideToast();
    toast(`Shared route failed to load: ${(e as Error).message}`, 6000);
  }
}

const isStandalone =
  window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as unknown as { standalone?: boolean }).standalone === true;

/** iOS opens scanned QR links in Safari, whose storage is separate from the
    home-screen app's — walk the user through the clipboard hand-off. */
function openHandoffPanel(url: string, name: string): void {
  showPanel(`
    <h3>Get this route into the app</h3>
    <p class="hint">The route loaded here in the browser, but the home-screen app keeps
    its own separate storage. To hand “${name.replace(/</g, '&lt;')}” over:</p>
    <ol style="font-size:14px; padding-left:20px; line-height:1.5">
      <li>Tap <b>Copy route link</b> below</li>
      <li>Open <b>Trailhead</b> from your home screen</li>
      <li>Tap <svg class="inlineIco" viewBox="0 0 24 24"><use href="#i-routes"/></svg> <b>Routes</b> → <b>Paste shared route</b></li>
    </ol>
    <div class="row"><button id="handoffCopy" style="flex:1">Copy route link</button></div>
  `);
  $('handoffCopy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast('Copied — now open the Trailhead app');
    } catch {
      prompt('Copy the link:', url);
    }
  });
}

async function importSharedRoute(): Promise<void> {
  let parsed: ParsedShare | null;
  const originalUrl = location.href;
  try {
    parsed = parseShareHash(location.hash);
  } catch {
    return toast('Could not read the shared route link', 5000);
  }
  if (!parsed) return;
  history.replaceState(null, '', location.pathname + location.search);
  await importParsed(parsed);
  if (!isStandalone && /iPhone|iPad|iPod/.test(navigator.userAgent)) {
    openHandoffPanel(originalUrl, parsed.name);
  }
}

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
