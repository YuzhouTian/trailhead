import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './style.css';
import {
  BASE_LAYERS,
  BROUTER_PROFILES,
  OFF_ROUTE_THRESHOLD_M,
  OFFLINE_MAX_TILES,
  OFFLINE_TILE_BUFFER,
  OFFLINE_ZOOMS,
  type BaseLayerDef
} from './config';
import qrcode from 'qrcode-generator';
import { renderProfile } from './elevation';
import {
  computeAscent,
  distanceToPolyline,
  formatDistance,
  formatDuration,
  haversine,
  latLngToTile,
  naismithHours,
  type LatLng
} from './geo';
import { parseGpx, toGpx } from './gpx';
import { routeMixed } from './routing';
import { buildShareUrl, parseShareHash, type ParsedShare } from './share';
import {
  loadRoutes,
  loadSettings,
  saveRoutes,
  saveSettings,
  type SavedRoute
} from './state';

// ---------------------------------------------------------------- helpers

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

let toastTimer: number | undefined;
function toast(msg: string, ms = 3000): void {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  window.clearTimeout(toastTimer);
  if (ms > 0) toastTimer = window.setTimeout(() => el.classList.add('hidden'), ms);
}
function hideToast(): void {
  $('toast').classList.add('hidden');
}

function downloadFile(name: string, content: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------------------------------------------------------------- map + layers

const settings = loadSettings();
let routes = loadRoutes();

const map = L.map('map', { zoomControl: true }).setView([54.5, -3.0], 6);

let baseTiles: L.TileLayer | null = null;
let overlayTiles: L.TileLayer | null = null;

function layerDef(id: string): BaseLayerDef | undefined {
  return BASE_LAYERS.find((l) => l.id === id);
}

function makeTileLayer(def: BaseLayerDef): L.TileLayer {
  const opts: L.TileLayerOptions = {
    attribution: def.attribution,
    maxZoom: def.maxZoom,
    maxNativeZoom: def.maxNativeZoom
  };
  if (def.minNativeZoom !== undefined) opts.minNativeZoom = def.minNativeZoom;
  return L.tileLayer(def.url.replace('{osKey}', settings.osKey), opts);
}

function applyLayers(): void {
  let base = layerDef(settings.baseLayer) ?? BASE_LAYERS[0];
  if (base.needsOsKey && !settings.osKey) {
    toast('Ordnance Survey layer needs an API key — add it in the layers panel');
    base = BASE_LAYERS[0];
    settings.baseLayer = base.id;
  }
  baseTiles?.remove();
  baseTiles = makeTileLayer(base).addTo(map);

  overlayTiles?.remove();
  overlayTiles = null;
  const over = settings.overlayLayer ? layerDef(settings.overlayLayer) : undefined;
  if (over && over.id !== base.id && !(over.needsOsKey && !settings.osKey)) {
    overlayTiles = makeTileLayer(over).addTo(map);
    overlayTiles.setOpacity(settings.overlayOpacity);
  }
  saveSettings(settings);
}

applyLayers();

// ---------------------------------------------------------------- active route

let activeRoute: SavedRoute | null = null;
let activeLine: L.Polyline | null = null;

function setActiveRoute(r: SavedRoute | null, fit = true): void {
  activeRoute = r;
  activeLine?.remove();
  activeLine = null;
  if (r) {
    activeLine = L.polyline(r.coords, {
      color: '#c1121f',
      weight: 4,
      opacity: 0.85
    }).addTo(map);
    if (fit) map.fitBounds(activeLine.getBounds(), { padding: [40, 40] });
  }
  elevVisible = !!r;
  updateElevPanel();
  updateBanner();
}

// ------------------------------------------------- elevation / stats panel

let elevVisible = false;

/** Refresh the bottom stats+profile panel from the plan in progress or the active route. */
function updateElevPanel(): void {
  const src = planning ? planResult : activeRoute;
  const panel = $('elevPanel');
  if (!src || !elevVisible) {
    panel.classList.add('hidden');
    $('btnElev').classList.remove('active');
    return;
  }
  panel.classList.remove('hidden');
  panel.classList.toggle('abovePlan', planning);
  $('btnElev').classList.add('active');
  const est = naismithHours(src.distanceM, src.ascentM, settings.speedKmh);
  $('elevStats').textContent =
    `${formatDistance(src.distanceM)} · ${Math.round(src.ascentM)} m ↑ · ~${formatDuration(est)}`;
  if (!renderProfile($('elevChart'), src.coords)) {
    $('elevChart').innerHTML = '<p class="hint">No elevation data for this route.</p>';
  }
}

$('btnElev').addEventListener('click', () => {
  if (!activeRoute && !(planning && planResult)) return toast('Load or plan a route first');
  elevVisible = !elevVisible;
  updateElevPanel();
});
$('elevClose').addEventListener('click', () => {
  elevVisible = false;
  updateElevPanel();
});

// ---------------------------------------------------------------- route planner

const wpIcon = L.divIcon({ className: '', html: '<div class="wpMarker"></div>', iconSize: [20, 20], iconAnchor: [10, 10] });

let planning = false;
let planWaypoints: LatLng[] = [];
/** planSnaps[i]: the leg arriving at waypoint i follows paths (magnet on). */
let planSnaps: boolean[] = [];
let snapMode = true;
let planMarkers: L.Marker[] = [];
let planLine: L.Polyline | null = null;
let planResult: { coords: LatLng[]; distanceM: number; ascentM: number } | null = null;
let planAbort: AbortController | null = null;
let planTimer: number | undefined;

function setPlanning(on: boolean): void {
  planning = on;
  $('btnPlan').classList.toggle('active', on);
  $('planBar').classList.toggle('hidden', !on);
  map.getContainer().style.cursor = on ? 'crosshair' : '';
  if (on) {
    setActiveRoute(null);
    updatePlanStats();
  }
}

function clearPlan(): void {
  planWaypoints = [];
  planSnaps = [];
  planMarkers.forEach((m) => m.remove());
  planMarkers = [];
  planLine?.remove();
  planLine = null;
  planResult = null;
  planAbort?.abort();
  updatePlanStats();
}

function updatePlanStats(text?: string): void {
  const el = $('planStats');
  if (text) {
    el.textContent = text;
  } else if (planResult) {
    const est = naismithHours(planResult.distanceM, planResult.ascentM, settings.speedKmh);
    el.textContent = `${formatDistance(planResult.distanceM)} · ${Math.round(planResult.ascentM)} m ↑ · ~${formatDuration(est)}`;
  } else if (planWaypoints.length < 2) {
    el.textContent = 'Tap the map to add points — the route follows real paths';
  } else {
    el.textContent = 'Routing…';
  }
}

function addWaypoint(p: LatLng): void {
  planWaypoints.push(p);
  planSnaps.push(snapMode);
  const marker = L.marker(p, { icon: wpIcon, draggable: true }).addTo(map);
  marker.on('dragend', () => {
    const i = planMarkers.indexOf(marker);
    const ll = marker.getLatLng();
    planWaypoints[i] = [ll.lat, ll.lng];
    scheduleRecompute();
  });
  planMarkers.push(marker);
  scheduleRecompute();
}

function scheduleRecompute(): void {
  updatePlanStats();
  window.clearTimeout(planTimer);
  planTimer = window.setTimeout(recomputePlan, 350);
}

async function recomputePlan(): Promise<void> {
  if (planWaypoints.length < 2) {
    planLine?.remove();
    planLine = null;
    planResult = null;
    updatePlanStats();
    return;
  }
  planAbort?.abort();
  planAbort = new AbortController();
  updatePlanStats('Routing…');
  try {
    const result = await routeMixed(planWaypoints, planSnaps, settings.profile, planAbort.signal);
    planResult = result;
    planLine?.remove();
    planLine = L.polyline(result.coords, { color: '#1a73e8', weight: 4 }).addTo(map);
    updatePlanStats();
    elevVisible = true;
    updateElevPanel();
  } catch (e) {
    if ((e as Error).name === 'AbortError') return;
    // Router unreachable (offline / bad segment): fall back to straight lines.
    planResult = {
      coords: [...planWaypoints],
      distanceM: planWaypoints.reduce(
        (acc, p, i) => (i ? acc + haversine(planWaypoints[i - 1], p) : 0),
        0
      ),
      ascentM: 0
    };
    planLine?.remove();
    planLine = L.polyline(planResult.coords, {
      color: '#1a73e8',
      weight: 4,
      dashArray: '6 8'
    }).addTo(map);
    updatePlanStats();
    updateElevPanel();
    toast(`Router error — showing straight line. ${(e as Error).message}`, 5000);
  }
}

map.on('click', (e: L.LeafletMouseEvent) => {
  if (planning) addWaypoint([e.latlng.lat, e.latlng.lng]);
});

function planToRoute(name: string): SavedRoute | null {
  if (!planResult) return null;
  return {
    id: String(Date.now()),
    name,
    waypoints: [...planWaypoints],
    snaps: [...planSnaps],
    coords: planResult.coords,
    distanceM: planResult.distanceM,
    ascentM: planResult.ascentM,
    createdAt: Date.now()
  };
}

$('btnPlan').addEventListener('click', () => setPlanning(!planning));
$('planSnap').addEventListener('click', () => {
  snapMode = !snapMode;
  $('planSnap').classList.toggle('active', snapMode);
  toast(snapMode ? 'Snap to paths ON' : 'Freeform ON — next points connect in straight lines', 2500);
});
$('planUndo').addEventListener('click', () => {
  planWaypoints.pop();
  planSnaps.pop();
  planMarkers.pop()?.remove();
  scheduleRecompute();
});
$('planClear').addEventListener('click', clearPlan);
$('planDone').addEventListener('click', () => {
  const r = planToRoute('Unsaved route');
  setPlanning(false);
  clearPlan();
  if (r) setActiveRoute(r, false);
});
$('planSave').addEventListener('click', () => {
  if (!planResult) return toast('Nothing to save yet');
  const name = prompt('Route name:', 'My route');
  if (!name) return;
  const r = planToRoute(name)!;
  routes.push(r);
  saveRoutes(routes);
  toast(`Saved “${name}”`);
});
$('planExport').addEventListener('click', () => {
  if (!planResult) return toast('Nothing to export yet');
  downloadFile('route.gpx', toGpx('Trailhead route', planResult.coords), 'application/gpx+xml');
});

// ---------------------------------------------------------------- GPX import

$('gpxFile').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    const gpx = parseGpx(await file.text(), file.name.replace(/\.gpx$/i, ''));
    let dist = 0;
    for (let i = 1; i < gpx.coords.length; i++) dist += haversine(gpx.coords[i - 1], gpx.coords[i]);
    const r: SavedRoute = {
      id: String(Date.now()),
      name: gpx.name,
      waypoints: null,
      coords: gpx.coords,
      distanceM: dist,
      ascentM: computeAscent(gpx.coords),
      createdAt: Date.now()
    };
    routes.push(r);
    saveRoutes(routes);
    setActiveRoute(r);
    hidePanel();
    toast(`Imported “${gpx.name}” (${formatDistance(dist)})`);
  } catch (err) {
    toast(`Import failed: ${(err as Error).message}`, 5000);
  }
});

// ---------------------------------------------------------------- location + on/off route

const gpsIcon = L.divIcon({ className: '', html: '<div class="gpsDot"></div>', iconSize: [22, 22], iconAnchor: [11, 11] });

let watchId: number | null = null;
let gpsMarker: L.Marker | null = null;
let accCircle: L.Circle | null = null;
let lastFix: LatLng | null = null;
let follow = false;

function updateBanner(): void {
  const banner = $('statusBanner');
  if (!lastFix || !activeRoute) {
    banner.classList.add('hidden');
    return;
  }
  const d = distanceToPolyline(lastFix, activeRoute.coords);
  banner.classList.remove('hidden');
  if (d <= OFF_ROUTE_THRESHOLD_M) {
    banner.className = '';
    banner.textContent = `On route · ${formatDistance(d)} from line`;
  } else {
    banner.className = 'off';
    banner.textContent = `OFF ROUTE · ${formatDistance(d)} away`;
  }
}

function onFix(pos: GeolocationPosition): void {
  const p: LatLng = [pos.coords.latitude, pos.coords.longitude];
  lastFix = p;
  if (!gpsMarker) {
    gpsMarker = L.marker(p, { icon: gpsIcon, interactive: false }).addTo(map);
    accCircle = L.circle(p, {
      radius: pos.coords.accuracy,
      color: '#1a73e8',
      weight: 1,
      fillOpacity: 0.12,
      interactive: false
    }).addTo(map);
  } else {
    gpsMarker.setLatLng(p);
    accCircle!.setLatLng(p).setRadius(pos.coords.accuracy);
  }
  if (follow) map.setView(p, Math.max(map.getZoom(), 15));
  updateBanner();
}

function stopWatch(): void {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  follow = false;
  gpsMarker?.remove();
  accCircle?.remove();
  gpsMarker = null;
  accCircle = null;
  lastFix = null;
  $('btnLocate').classList.remove('active');
  updateBanner();
}

$('btnLocate').addEventListener('click', () => {
  if (watchId === null) {
    if (!('geolocation' in navigator)) return toast('No geolocation on this device');
    follow = true;
    $('btnLocate').classList.add('active');
    watchId = navigator.geolocation.watchPosition(onFix, (err) => {
      toast(`GPS error: ${err.message}`, 5000);
      stopWatch();
    }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
  } else if (!follow) {
    follow = true;
    if (lastFix) map.setView(lastFix, Math.max(map.getZoom(), 15));
  } else {
    stopWatch();
  }
});

map.on('dragstart', () => {
  follow = false;
});

// ---------------------------------------------------------------- panels

function hidePanel(): void {
  $('panel').classList.add('hidden');
}

function showPanel(html: string): HTMLElement {
  const content = $('panelContent');
  content.innerHTML = `<button class="closeX" id="panelClose">&times;</button>${html}`;
  $('panel').classList.remove('hidden');
  $('panelClose').addEventListener('click', hidePanel);
  return content;
}

function openLayersPanel(): void {
  const baseRows = BASE_LAYERS.map(
    (l) => `<div class="row">
      <input type="radio" name="base" id="base-${l.id}" value="${l.id}" ${settings.baseLayer === l.id ? 'checked' : ''}/>
      <label for="base-${l.id}">${l.name}</label>
    </div>`
  ).join('');
  const overlayOpts = ['<option value="">None</option>']
    .concat(BASE_LAYERS.map((l) => `<option value="${l.id}" ${settings.overlayLayer === l.id ? 'selected' : ''}>${l.name}</option>`))
    .join('');
  const profileOpts = BROUTER_PROFILES.map(
    (p) => `<option value="${p}" ${settings.profile === p ? 'selected' : ''}>${p}</option>`
  ).join('');

  showPanel(`
    <h3>Base map</h3>
    ${baseRows}
    <hr/>
    <h3>Overlay</h3>
    <div class="row"><select id="overlaySel" style="flex:1">${overlayOpts}</select></div>
    <div class="row"><label>Opacity</label>
      <input type="range" id="overlayOp" min="0.1" max="0.9" step="0.1" value="${settings.overlayOpacity}"/>
    </div>
    <hr/>
    <h3>Ordnance Survey API key</h3>
    <p class="hint">Free from osdatahub.os.uk — needed only for the OS layers.</p>
    <div class="row"><input type="password" id="osKeyInput" value="${settings.osKey}" placeholder="OS Data Hub key"/></div>
    <hr/>
    <h3>Routing profile</h3>
    <div class="row"><select id="profileSel" style="flex:1">${profileOpts}</select></div>
    <hr/>
    <h3>Walking speed</h3>
    <p class="hint">Your pace on the flat. Time estimates add 1 h per 600 m of climb (Naismith's rule).</p>
    <div class="row">
      <input type="number" id="speedInput" min="1" max="8" step="0.5" value="${settings.speedKmh}" style="width:70px"/>
      <label>km/h</label>
    </div>
    <hr/>
    <div class="row"><button id="importBtn" style="flex:1">Import GPX file</button></div>
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
    overlayTiles?.setOpacity(settings.overlayOpacity);
    saveSettings(settings);
  });
  $('osKeyInput').addEventListener('change', (e) => {
    settings.osKey = (e.target as HTMLInputElement).value.trim();
    applyLayers();
    toast(settings.osKey ? 'OS key saved' : 'OS key cleared');
  });
  $('profileSel').addEventListener('change', (e) => {
    settings.profile = (e.target as HTMLSelectElement).value;
    saveSettings(settings);
  });
  $('speedInput').addEventListener('change', (e) => {
    const v = parseFloat((e.target as HTMLInputElement).value);
    if (Number.isFinite(v) && v > 0) {
      settings.speedKmh = v;
      saveSettings(settings);
      updatePlanStats();
      updateElevPanel();
    }
  });
  $('importBtn').addEventListener('click', () => $('gpxFile').click());
}

function openRoutesPanel(): void {
  const items = routes.length
    ? routes
        .map(
          (r) => `<div class="routeItem" data-id="${r.id}">
        <div class="meta">
          <div class="name">${r.name.replace(/</g, '&lt;')}</div>
          <div class="sub">${formatDistance(r.distanceM)}${r.ascentM ? ` · ${Math.round(r.ascentM)} m ↑` : ''}</div>
        </div>
        <button data-act="load">Load</button>
        <button data-act="share" class="secondary">Share</button>
        <button data-act="gpx" class="secondary">GPX</button>
        <button data-act="del" class="danger">✕</button>
      </div>`
        )
        .join('')
    : '<p class="hint">No saved routes yet. Import a GPX or plan one with the pencil tool.</p>';

  const content = showPanel(`
    <h3>Saved routes</h3>
    ${items}
    <hr/>
    <div class="row"><button id="pasteRoute" style="flex:1">Paste shared route</button></div>
    <p class="hint">Copied a route link (e.g. from Safari after scanning a QR)? This imports it here.</p>
    <div class="row"><button id="clearActive" class="secondary" style="flex:1">Hide active route</button></div>
  `);
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

  content.querySelectorAll<HTMLButtonElement>('.routeItem button').forEach((btn) => {
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
  $('clearActive').addEventListener('click', () => {
    setActiveRoute(null);
    hidePanel();
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

$('btnLayers').addEventListener('click', openLayersPanel);
$('btnRoutes').addEventListener('click', openRoutesPanel);
map.on('click', hidePanel);

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
        ascentM: computeAscent(coords),
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
      <li>Tap &#128193; → <b>Paste shared route</b></li>
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

importSharedRoute();

// ---------------------------------------------------------------- offline tiles

function tileUrls(def: BaseLayerDef, coords: LatLng[]): string[] {
  const urls = new Set<string>();
  for (const z of OFFLINE_ZOOMS) {
    if (z > def.maxZoom) continue;
    const seen = new Set<string>();
    for (const [lat, lng] of coords) {
      const [tx, ty] = latLngToTile(lat, lng, z);
      for (let dx = -OFFLINE_TILE_BUFFER; dx <= OFFLINE_TILE_BUFFER; dx++) {
        for (let dy = -OFFLINE_TILE_BUFFER; dy <= OFFLINE_TILE_BUFFER; dy++) {
          seen.add(`${tx + dx},${ty + dy}`);
        }
      }
    }
    for (const key of seen) {
      const [x, y] = key.split(',').map(Number);
      const n = 2 ** z;
      if (x < 0 || y < 0 || x >= n || y >= n) continue;
      urls.add(
        def.url
          .replace('{s}', 'a')
          .replace('{z}', String(z))
          .replace('{x}', String(x))
          .replace('{y}', String(y))
          .replace('{osKey}', settings.osKey)
      );
    }
  }
  return [...urls];
}

$('btnOffline').addEventListener('click', async () => {
  if (!activeRoute) return toast('Load or plan a route first');
  if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) {
    return toast('Offline caching only works in the installed (built) app', 5000);
  }
  const defs = [layerDef(settings.baseLayer), settings.overlayLayer ? layerDef(settings.overlayLayer) : undefined]
    .filter((d): d is BaseLayerDef => !!d && !(d.needsOsKey && !settings.osKey));
  let urls = defs.flatMap((d) => tileUrls(d, activeRoute!.coords));
  if (urls.length > OFFLINE_MAX_TILES) {
    toast(`Route too long — capping at ${OFFLINE_MAX_TILES} tiles`, 4000);
    urls = urls.slice(0, OFFLINE_MAX_TILES);
  }
  if (!confirm(`Download ~${urls.length} map tiles for offline use?`)) return;

  let done = 0;
  let failed = 0;
  const queue = [...urls];
  const workers = Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const url = queue.shift()!;
      try {
        await fetch(url, { mode: 'no-cors' });
      } catch {
        failed++;
      }
      done++;
      if (done % 25 === 0 || done === urls.length) {
        toast(`Caching tiles… ${done}/${urls.length}`, 0);
      }
    }
  });
  await Promise.all(workers);
  hideToast();
  toast(failed ? `Done — ${failed} tiles failed` : `Offline tiles ready (${urls.length})`, 4000);
});

// ---------------------------------------------------------------- service worker

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}

if (import.meta.env.DEV) {
  (window as unknown as { __map: L.Map }).__map = map;
}
