import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet-rotate';
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
import { fetchElevation, renderProfile } from './elevation';
import { legendHtml } from './legend';
import {
  compassDir,
  computeClimbs,
  cumulativeDistances,
  formatDistance,
  formatDuration,
  haversine,
  latLngToTile,
  naismithHours,
  projectOnPolyline,
  type LatLng,
  type RouteProgress
} from './geo';
import { parseGpx, toGpx } from './gpx';
import { formatGridRef } from './osgb';
import { fetchPois, POI_STYLE, type Poi } from './poi';
import { routeMixed, type RouteResult } from './routing';
import { search, type SearchHit } from './search';
import { buildShareUrl, parseShareHash, type ParsedShare } from './share';
import {
  loadActiveRoute,
  loadPins,
  loadRoutes,
  loadSettings,
  saveActiveRoute,
  savePins,
  saveRoutes,
  saveSettings,
  type Pin,
  type PinCategory,
  type SavedRoute,
  type Settings
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

// The "Me" button shows its state through the glyph as well as the colour:
// a hollow crosshair when off, a filled one while following you north-up, and
// a compass arrow in heading-up mode.
const svgUse = (id: string) => `<svg viewBox="0 0 24 24"><use href="#${id}"/></svg>`;
const LOCATE_ICON = { off: svgUse('i-locate'), follow: svgUse('i-locate-on'), heading: svgUse('i-compass') };

// The map opens on a whole-UK view, then recentres on your actual area on
// every startup once geolocation resolves. If location is denied, unavailable,
// or times out, the UK view stays put.
const UK_FALLBACK_VIEW = { center: [54.5, -3.0] as LatLng, zoom: 6 };
// Match the "me"/follow zoom (see btnLocate below) so the startup view and
// locating yourself land at the same scale.
const STARTUP_LOCATION_ZOOM = 15;

const map = L.map('map', {
  zoomControl: true,
  rotate: true,
  touchRotate: false,
  rotateControl: false
}).setView(UK_FALLBACK_VIEW.center, UK_FALLBACK_VIEW.zoom);

// Recentre on your current location at startup, for the initial tiles. This is
// deliberately separate from the "me"/follow control below — no marker, no
// accuracy circle, no follow, and it bows out the moment you touch the map so
// it can't yank you away mid-interaction.
if ('geolocation' in navigator) {
  let userTouchedMap = false;
  map.getContainer().addEventListener(
    'pointerdown',
    () => { userTouchedMap = true; },
    { once: true }
  );
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      if (userTouchedMap) return;
      map.setView([pos.coords.latitude, pos.coords.longitude], STARTUP_LOCATION_ZOOM);
    },
    () => { /* denied or unavailable — the UK fallback view stays put */ },
    { enableHighAccuracy: false, maximumAge: 600_000, timeout: 10_000 }
  );
}

// iOS standalone mode settles its viewport after load, leaving Leaflet with a
// stale (shorter) size and a blank strip at the bottom — re-measure whenever
// the visual viewport changes and repeatedly while startup settles.
const remeasure = () => map.invalidateSize({ animate: false });
window.visualViewport?.addEventListener('resize', remeasure);
window.addEventListener('orientationchange', () => setTimeout(remeasure, 250));
window.addEventListener('pageshow', () => setTimeout(remeasure, 100));
window.addEventListener('touchstart', remeasure, { once: true });
for (const t of [100, 350, 700, 1500, 3000]) setTimeout(remeasure, t);

let baseTiles: L.TileLayer | null = null;
let overlayTiles: L.TileLayer | null = null;

function layerDef(id: string): BaseLayerDef | undefined {
  return BASE_LAYERS.find((l) => l.id === id);
}

/** Fill in the API key and the retina suffix for a layer's tile URL. */
function tileUrlFor(def: BaseLayerDef): string {
  const scale = def.retina && window.devicePixelRatio > 1.3 ? '@2x' : '';
  return def.url.replace('{tfKey}', settings.tfKey).replace('{r}', scale);
}

function makeTileLayer(def: BaseLayerDef): L.TileLayer {
  const opts: L.TileLayerOptions = {
    attribution: def.attribution,
    maxZoom: def.maxZoom,
    maxNativeZoom: def.maxNativeZoom,
    // CORS requests let the service worker distinguish real tiles from
    // errors, so failures are never cached as permanent grey squares.
    crossOrigin: 'anonymous',
    // Leaflet defaults updateWhenIdle to true on touch devices, which holds
    // every tile request until the pan stops — the map visibly fills in
    // behind your finger. Load them as you go instead.
    updateWhenIdle: false,
    // Don't re-request at every intermediate zoom level mid-animation.
    updateWhenZooming: false,
    // Keep several rings of off-screen tiles alive instead of the default two,
    // so panning moves into already-loaded map rather than blank squares, and
    // a zoom keeps parent tiles visible under the ones still loading.
    keepBuffer: 6
  };
  if (def.minNativeZoom !== undefined) opts.minNativeZoom = def.minNativeZoom;
  return L.tileLayer(tileUrlFor(def), opts);
}

/** The layer we fall back to: always available, never needs a key. */
const FALLBACK_LAYER = BASE_LAYERS.find((l) => !l.needsTfKey) ?? BASE_LAYERS[0];

/** A layer is usable if it exists and any key it needs has been entered. */
function usable(def: BaseLayerDef | undefined): def is BaseLayerDef {
  return !!def && !(def.needsTfKey && !settings.tfKey);
}

function applyLayers(): void {
  const requested = layerDef(settings.baseLayer);
  // Read this before the type guard below narrows `requested` away.
  const missingKey = !!requested?.needsTfKey && !settings.tfKey;
  // Falls back for both a missing key and settings still naming a retired
  // OS layer.
  const base = usable(requested) ? requested : FALLBACK_LAYER;
  if (base.id !== settings.baseLayer) {
    if (missingKey) toast('Outdoors needs a Thunderforest key — add it in Settings', 4000);
    settings.baseLayer = base.id;
  }
  baseTiles?.remove();
  baseTiles = makeTileLayer(base).addTo(map);

  // An empty key is caught above, but a *wrong* one just 401s and leaves a
  // blank map. Bail out to the keyless layer rather than showing nothing.
  if (base.needsTfKey) {
    let failures = 0;
    baseTiles.on('tileerror', () => {
      if (++failures !== 4 || settings.baseLayer !== base.id) return;
      toast(`${base.name} tiles are failing — check the key in Settings`, 6000);
      settings.baseLayer = FALLBACK_LAYER.id;
      applyLayers();
    });
  }

  overlayTiles?.remove();
  overlayTiles = null;
  const over = settings.overlayLayer ? layerDef(settings.overlayLayer) : undefined;
  if (usable(over) && over.id !== base.id) {
    overlayTiles = makeTileLayer(over).addTo(map);
    overlayTiles.setOpacity(settings.overlayOpacity);
  } else if (settings.overlayLayer && !layerDef(settings.overlayLayer)) {
    settings.overlayLayer = ''; // retired layer
  }
  saveSettings(settings);
}

applyLayers();

// Metric scale bar (bottom-left, above the nav bar) so distance is readable at
// a glance. Attribution stays bottom-right, so the two don't collide.
L.control.scale({ imperial: false, position: 'bottomleft', maxWidth: 120 }).addTo(map);

// ---------------------------------------------------------------- active route

let activeRoute: SavedRoute | null = null;
let activeLine: L.Polyline | null = null;
// How far along the active route we last were, and the latest projection —
// used to keep progress continuous where the line passes close to itself.
let routeHint: number | null = null;
let lastProg: RouteProgress | null = null;

function setActiveRoute(r: SavedRoute | null, fit = true): void {
  activeRoute = r;
  routeHint = null; // a freshly loaded route reads from its start
  lastProg = null;
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
  saveActiveRoute(r); // remember it so a hike survives an app reload
  updateElevPanel();
  updateBanner();
}

// ------------------------------------------------- elevation / stats panel

function climbText(ascentM: number, descentM?: number): string {
  let s = `↑ ${Math.round(ascentM)} m`;
  if (descentM !== undefined && Math.round(descentM) > 0) s += ` · ↓ ${Math.round(descentM)} m`;
  return s;
}

let chartOpen = false;
let scrubMarker: L.CircleMarker | null = null;

function onProfileScrub(pos: LatLng | null): void {
  if (!pos) {
    scrubMarker?.remove();
    scrubMarker = null;
    return;
  }
  if (!scrubMarker) {
    scrubMarker = L.circleMarker(pos, {
      radius: 7,
      color: '#c1121f',
      weight: 3,
      fillColor: '#fff',
      fillOpacity: 1,
      interactive: false
    }).addTo(map);
  } else {
    scrubMarker.setLatLng(pos);
  }
}

/** Refresh the active-route card from the plan in progress or the active route. */
function updateElevPanel(): void {
  const src = planning ? planResult : activeRoute;
  const card = $('routeCard');
  if (!src) {
    card.classList.add('hidden');
    onProfileScrub(null);
    return;
  }
  card.classList.remove('hidden');
  card.classList.toggle('abovePlan', planning);
  $('rcName').textContent = planning ? 'New route' : activeRoute?.name ?? '';
  const est = naismithHours(src.distanceM, src.ascentM, settings.speedKmh);
  $('rcStats').textContent =
    `${formatDistance(src.distanceM)} · ${climbText(src.ascentM, src.descentM)} · ~${formatDuration(est)}`;
  const remaining = planning ? null : remainingText();
  $('rcRemaining').textContent = remaining ?? '';
  $('rcRemaining').classList.toggle('hidden', !remaining);
  $('rcOffline').classList.toggle('hidden', planning);
  $('rcClose').classList.toggle('hidden', planning);
  $('rcStart').classList.toggle('hidden', planning);
  updateRouteStart();
  $('rcChart').classList.toggle('active', chartOpen);
  const chart = $('elevChart');
  if (chartOpen) {
    chart.classList.remove('hidden');
    if (!renderProfile(chart, src.coords, onProfileScrub)) {
      chart.innerHTML = '<p class="hint">No elevation data for this route.</p>';
    }
  } else {
    chart.classList.add('hidden');
    onProfileScrub(null);
  }
}

$('rcChart').addEventListener('click', () => {
  chartOpen = !chartOpen;
  updateElevPanel();
});
$('rcClose').addEventListener('click', () => setActiveRoute(null));

// ---------------------------------------------------------------- route planner

const wpIcon = L.divIcon({ className: '', html: '<div class="wpMarker"></div>', iconSize: [20, 20], iconAnchor: [10, 10] });

let planning = false;
let planWaypoints: LatLng[] = [];
/** planSnaps[i]: the leg arriving at waypoint i follows paths (magnet on). */
let planSnaps: boolean[] = [];
let snapMode = true;
let planMarkers: L.Marker[] = [];
let planLine: L.Polyline | null = null;
let planResult: RouteResult | null = null;
let planAbort: AbortController | null = null;
let planTimer: number | undefined;

function setPlanning(on: boolean): void {
  planning = on;
  document.body.classList.toggle('planning', on);
  $('btnPlan').classList.toggle('active', on);
  $('planBar').classList.toggle('hidden', !on);
  map.getContainer().style.cursor = on ? 'crosshair' : '';
  if (on) {
    setActiveRoute(null);
    updatePlanStats();
  }
  updateElevPanel();
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
    el.textContent = `${formatDistance(planResult.distanceM)} · ${climbText(planResult.ascentM, planResult.descentM)} · ~${formatDuration(est)}`;
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
      ascentM: 0,
      descentM: 0
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
    descentM: planResult.descentM,
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
  // Nothing drawn yet — just leave planning.
  if (!planResult || planWaypoints.length < 2) {
    setPlanning(false);
    clearPlan();
    return;
  }
  // Offer to keep it: naming the route saves it to your list; cancelling still
  // finishes with the route shown (but unsaved), so a plan is never lost by an
  // accidental tap. Either way, planning ends here.
  const name = prompt('Name this route to save it — or cancel to finish without saving:', 'My route');
  const r = planToRoute(name || 'Unsaved route')!;
  if (name) {
    routes.push(r);
    saveRoutes(routes);
    toast(`Saved “${name}”`);
  }
  setPlanning(false);
  clearPlan();
  setActiveRoute(r, false);
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
      ...computeClimbs(gpx.coords),
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
    lastProg = null;
    banner.classList.add('hidden');
    updateElevPanel();
    return;
  }
  // One projection per fix, seeded with where we were, then shared with the
  // remaining-distance readout so both stay consistent and continuous.
  const prog = projectOnPolyline(lastFix, activeRoute.coords, routeHint);
  lastProg = prog;
  if (prog) routeHint = prog.alongM;
  banner.classList.remove('hidden');
  if (prog && prog.offRouteM <= OFF_ROUTE_THRESHOLD_M) {
    banner.className = '';
    banner.textContent = `On route · ${Math.round(prog.offRouteM)} m from line`;
  } else {
    banner.className = 'off';
    banner.textContent = `OFF ROUTE · ${formatDistance(prog?.offRouteM ?? Infinity)} away`;
  }
  updateElevPanel();
}

/**
 * What's left of the active route from the current position: distance,
 * remaining climb, and a time estimate at the user's pace.
 */
function remainingText(): string | null {
  if (!lastFix || !activeRoute || !lastProg) return null;
  const coords = activeRoute.coords;
  const prog = lastProg;

  const cum = cumulativeDistances(coords);
  const total = cum[cum.length - 1];
  const remainingM = Math.max(0, total - prog.alongM);

  // Remaining climb and descent: only the part of the profile still ahead.
  const ahead = coords.slice(prog.index + 1);
  const { ascentM, descentM } = computeClimbs(ahead);
  const est = naismithHours(remainingM, ascentM, settings.speedKmh);

  const pct = total > 0 ? Math.round((prog.alongM / total) * 100) : 0;
  return `${formatDistance(remainingM)} to go · ${climbText(ascentM, descentM)} · ~${formatDuration(est)} · ${pct}% done`;
}

function onFix(pos: GeolocationPosition): void {
  const p: LatLng = [pos.coords.latitude, pos.coords.longitude];
  lastFix = p;
  if (!gpsMarker) {
    gpsMarker = L.marker(p, { icon: gpsIcon }).addTo(map);
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
  // Tap your own dot for the grid reference to read out to mountain rescue.
  gpsMarker.bindPopup(
    `<div style="font-size:13px;line-height:1.5">${positionText(p)}<br>
     <span style="color:var(--muted)">±${Math.round(pos.coords.accuracy)} m</span></div>`
  );
  // Recentre instantly: fixes arrive every second or so, and queueing a pan
  // animation per fix looks jittery and stalls entirely while backgrounded.
  if (follow) map.setView(p, Math.max(map.getZoom(), 15), { animate: false });
  updateBanner();
}

// --- compass (heading-up) mode ---------------------------------------

let headingOn = false;
let headingHandler: ((e: DeviceOrientationEvent) => void) | null = null;
/** Newest compass reading, degrees clockwise from north. */
let targetHeading: number | null = null;
/** Smoothed heading currently drawn, chased towards the target each frame. */
let shownHeading: number | null = null;
let appliedHeading: number | null = null;
let headingFrame: number | null = null;

/** Shortest signed turn from a to b, in (-180, 180] — handles the 359°→0° wrap. */
function angleDelta(a: number, b: number): number {
  return ((b - a + 540) % 360) - 180;
}

/**
 * Redraw the bearing once per animation frame rather than once per compass
 * event, easing towards the latest reading. Following the raw sensor looks
 * jittery (it is noisy and fires irregularly); easing at display rate looks
 * like the map is simply turning with you.
 */
function headingTick(): void {
  headingFrame = requestAnimationFrame(headingTick);
  if (targetHeading === null) return;

  if (shownHeading === null) shownHeading = targetHeading;
  else shownHeading = (shownHeading + angleDelta(shownHeading, targetHeading) * 0.25 + 360) % 360;

  // Skip the redraw when the change is imperceptible, so a still phone
  // costs nothing.
  if (appliedHeading !== null && Math.abs(angleDelta(appliedHeading, shownHeading)) < 0.25) return;
  appliedHeading = shownHeading;
  map.setBearing(-shownHeading);
}

async function startHeading(): Promise<boolean> {
  type DOEStatic = { requestPermission?: () => Promise<string> };
  const doe = DeviceOrientationEvent as unknown as DOEStatic;
  try {
    if (typeof doe.requestPermission === 'function') {
      if ((await doe.requestPermission()) !== 'granted') return false;
    }
  } catch {
    return false;
  }
  // Record every reading; headingTick decides how often to redraw.
  headingHandler = (e: DeviceOrientationEvent) => {
    const webkit = (e as DeviceOrientationEvent & { webkitCompassHeading?: number })
      .webkitCompassHeading;
    if (typeof webkit === 'number' && !Number.isNaN(webkit)) targetHeading = webkit;
    else if (e.absolute && typeof e.alpha === 'number') targetHeading = 360 - e.alpha;
  };
  window.addEventListener('deviceorientation', headingHandler);
  headingFrame = requestAnimationFrame(headingTick);
  headingOn = true;
  return true;
}

function stopHeading(): void {
  if (headingHandler) window.removeEventListener('deviceorientation', headingHandler);
  if (headingFrame !== null) cancelAnimationFrame(headingFrame);
  headingHandler = null;
  headingFrame = null;
  targetHeading = shownHeading = appliedHeading = null;
  headingOn = false;
  map.setBearing(0);
}

function stopWatch(): void {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  follow = false;
  stopHeading();
  gpsMarker?.remove();
  accCircle?.remove();
  gpsMarker = null;
  accCircle = null;
  lastFix = null;
  $('btnLocate').classList.remove('active');
  $('locateIco').innerHTML = LOCATE_ICON.off;
  updateRouteStart();
  updateBanner();
}

/** The route card's Start button: a play glyph until following, then a live
 *  locate glyph with a ring (tap to re-centre). Hidden while planning. */
function updateRouteStart(): void {
  const btn = $('rcStart');
  const live = watchId !== null;
  btn.innerHTML = live
    ? '<svg viewBox="0 0 24 24"><use href="#i-locate-on"/></svg>'
    : '<svg viewBox="0 0 24 24"><use href="#i-start"/></svg>';
  btn.classList.toggle('live', live);
  btn.title = live ? 'Re-centre on you' : 'Start following this route';
}

/** Start GPS following (north-up). Shared by the Me button and the card Start. */
function beginFollow(): boolean {
  if (!('geolocation' in navigator)) {
    toast('No geolocation on this device');
    return false;
  }
  follow = true;
  $('btnLocate').classList.add('active');
  $('locateIco').innerHTML = LOCATE_ICON.follow;
  watchId = navigator.geolocation.watchPosition(onFix, (err) => {
    toast(`GPS error: ${err.message}`, 5000);
    stopWatch();
  }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
  updateRouteStart();
  return true;
}

// Tap cycle: off → follow north-up → follow heading-up → off.
// A map drag pauses following; the next tap just re-centres.
$('btnLocate').addEventListener('click', async () => {
  if (watchId === null) {
    if (beginFollow()) toast('Following you — tap again to rotate with your heading', 3000);
  } else if (!follow) {
    follow = true;
    $('locateIco').innerHTML = LOCATE_ICON.follow;
    if (lastFix) map.setView(lastFix, Math.max(map.getZoom(), 15), { animate: false });
  } else if (!headingOn) {
    if (await startHeading()) {
      $('locateIco').innerHTML = LOCATE_ICON.heading;
      toast('Heading-up — the map turns with you. Tap again to stop.', 3000);
    } else {
      toast('Compass not available — staying north-up. Tap again to stop.', 3500);
      stopWatch();
    }
  } else {
    stopWatch();
  }
});

map.on('dragstart', () => {
  follow = false;
});

// Route card's Start: begin following this route, or re-centre if already live.
$('rcStart').addEventListener('click', () => {
  if (watchId === null) {
    beginFollow();
  } else {
    follow = true;
    $('locateIco').innerHTML = headingOn ? LOCATE_ICON.heading : LOCATE_ICON.follow;
    if (lastFix) map.setView(lastFix, Math.max(map.getZoom(), 15), { animate: false });
  }
});

// ---------------------------------------------------------------- grid references

/** Human-readable position line: grid ref where we have one, plus lat/lng. */
function positionText(p: LatLng): string {
  const grid = formatGridRef(p[0], p[1], 4);
  const ll = `${p[0].toFixed(5)}, ${p[1].toFixed(5)}`;
  return grid ? `<b>${grid}</b><br>${ll}` : ll;
}

// ---------------------------------------------------------------- saved pins

const PIN_CATS: { id: PinCategory; label: string; icon: string }[] = [
  { id: 'summit', label: 'Summit', icon: 'c-summit' },
  { id: 'viewpoint', label: 'Viewpoint', icon: 'c-viewpoint' },
  { id: 'water', label: 'Water', icon: 'c-water' },
  { id: 'camp', label: 'Camp', icon: 'c-camp' },
  { id: 'parking', label: 'Parking', icon: 'c-parking' },
  { id: 'other', label: 'Other', icon: 'c-other' }
];
const catMeta = (id: PinCategory) => PIN_CATS.find((c) => c.id === id) ?? PIN_CATS[5];
const svgIcon = (id: string) => `<svg viewBox="0 0 24 24"><use href="#${id}"/></svg>`;

let pins = loadPins();
const pinMarkers = new Map<string, L.Marker>();
let dropMarker: L.Marker | null = null; // the temporary pin for an unsaved point
let eleAbort: AbortController | null = null; // in-flight elevation lookup
let pinCardJustOpened = false; // swallow the click that can trail a long-press

function renderPinMarkers(): void {
  for (const m of pinMarkers.values()) m.remove();
  pinMarkers.clear();
  for (const pin of pins) {
    const m = L.marker([pin.lat, pin.lng], {
      icon: L.divIcon({
        className: '',
        html: `<div class="savedPin">${svgIcon(catMeta(pin.category).icon)}</div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14]
      })
    }).addTo(map);
    m.on('click', () => openSavedPin(pin.id));
    pinMarkers.set(pin.id, m);
  }
}

/** Grid ref where Britain has one, otherwise decimal lat/lng. */
function gridText(lat: number, lng: number): string {
  return formatGridRef(lat, lng, 4) || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

/** Distance + compass bearing from the user, when their position is known. */
function distFactHtml(lat: number, lng: number): string {
  if (!lastFix) return '';
  const d = formatDistance(haversine(lastFix, [lat, lng]));
  return `<span class="pc-fact">${svgIcon('i-compass')}${d} ${compassDir(lastFix, [lat, lng])}</span>`;
}

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

function hidePinCard(): void {
  eleAbort?.abort();
  eleAbort = null;
  dropMarker?.remove();
  dropMarker = null;
  const card = $('pinCard');
  card.classList.add('hidden');
  card.innerHTML = '';
}

function flagOpened(): void {
  pinCardJustOpened = true;
  setTimeout(() => { pinCardJustOpened = false; }, 350);
}

/** The card for a fresh point: identify, name, tag, and save it. */
function openNewPin(lat: number, lng: number): void {
  hidePinCard();
  flagOpened();
  dropMarker = L.marker([lat, lng], {
    icon: L.divIcon({
      className: '',
      html: `<div class="dropPin">${svgIcon('i-pin')}</div>`,
      iconSize: [32, 32],
      iconAnchor: [16, 32]
    })
  }).addTo(map);

  let category: PinCategory = 'other';
  let ele: number | null | undefined; // undefined = still loading

  const chips = PIN_CATS.map(
    (c) => `<button class="pc-chip${c.id === category ? ' on' : ''}" data-cat="${c.id}">${svgIcon(c.icon)}${c.label}</button>`
  ).join('');
  const card = $('pinCard');
  card.innerHTML = `
    <button class="pc-close" aria-label="Close">&times;</button>
    <p class="pc-eyebrow">What's here</p>
    <div class="pc-grid">${gridText(lat, lng)}</div>
    <div class="pc-ll">${lat.toFixed(5)}, ${lng.toFixed(5)}</div>
    <div class="pc-facts"><span class="pc-fact loading" id="pcEle">${svgIcon('i-ele')}…</span>${distFactHtml(lat, lng)}</div>
    <div class="pc-sep"></div>
    <input class="pc-name" id="pcName" placeholder="Name this spot" autocomplete="off" />
    <div class="pc-chips">${chips}</div>
    <div class="pc-actions">
      <button class="pc-primary" id="pcSave">${svgIcon('i-save')}Save pin</button>
      <button class="pc-neutral" id="pcCopy">${svgIcon('i-copy')}Copy</button>
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
  eleAbort = new AbortController();
  fetchElevation(lat, lng, eleAbort.signal).then((m) => {
    ele = m;
    const el = document.getElementById('pcEle');
    if (!el) return;
    if (typeof m === 'number') {
      el.classList.remove('loading');
      el.innerHTML = `${svgIcon('i-ele')}${Math.round(m)} m`;
    } else {
      el.remove();
    }
  });
}

/** The card for an already-saved pin: reopened by tapping its marker. */
function openSavedPin(id: string): void {
  const pin = pins.find((p) => p.id === id);
  if (!pin) return;
  hidePinCard();
  flagOpened();
  const eleHtml =
    typeof pin.ele === 'number' ? `<span class="pc-fact">${svgIcon('i-ele')}${Math.round(pin.ele)} m</span>` : '';
  const card = $('pinCard');
  card.innerHTML = `
    <button class="pc-close" aria-label="Close">&times;</button>
    <p class="pc-eyebrow">Saved pin</p>
    <div class="pc-title"><span class="ci">${svgIcon(catMeta(pin.category).icon)}</span><span class="nm">${pin.name.replace(/</g, '&lt;')}</span></div>
    <div class="pc-grid">${gridText(pin.lat, pin.lng)}</div>
    <div class="pc-ll">${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}</div>
    <div class="pc-facts">${eleHtml}${distFactHtml(pin.lat, pin.lng)}</div>
    <div class="pc-actions">
      <button class="pc-neutral" id="pcCopy">${svgIcon('i-copy')}Copy</button>
      <button class="pc-neutral" id="pcShare">${svgIcon('i-share')}Share</button>
      <button class="pc-danger" id="pcDel" aria-label="Delete pin">${svgIcon('i-trash')}</button>
    </div>`;
  card.classList.remove('hidden');

  card.querySelector('.pc-close')!.addEventListener('click', hidePinCard);
  $('pcCopy').addEventListener('click', () => copyPin(pin));
  $('pcShare').addEventListener('click', () => sharePin(pin));
  $('pcDel').addEventListener('click', () => {
    if (!confirm(`Delete “${pin.name}”?`)) return;
    pins = pins.filter((p) => p.id !== pin.id);
    savePins(pins);
    renderPinMarkers();
    hidePinCard();
    toast('Pin deleted');
  });
}

/** A #p=lat,lng,name link centres here and offers to save the pin. */
function openSharedPin(): boolean {
  const m = location.hash.match(/^#p=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,(.*))?$/);
  if (!m) return false;
  const lat = parseFloat(m[1]);
  const lng = parseFloat(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  history.replaceState(null, '', location.pathname + location.search);
  map.setView([lat, lng], Math.max(map.getZoom(), 15));
  openNewPin(lat, lng);
  const nameEl = document.getElementById('pcName') as HTMLInputElement | null;
  if (nameEl && m[3]) nameEl.value = decodeURIComponent(m[3]);
  return true;
}

renderPinMarkers();

// Long-press (or right-click) anywhere to identify and optionally save a spot.
map.on('contextmenu', (e: L.LeafletMouseEvent) => {
  if (planning) return;
  openNewPin(e.latlng.lat, e.latlng.lng);
});

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
          html: `<div class="searchPin">${svgIcon('i-pin')}</div>`,
          iconSize: [32, 32],
          iconAnchor: [16, 32]
        })
      }).addTo(map);
      // Centre first and without animation, so the popup's auto-pan can't
      // animate over the top of it and leave the map where it started.
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
    searchAbort = new AbortController();
    const near: LatLng = lastFix ?? [map.getCenter().lat, map.getCenter().lng];
    try {
      showSearchHits(await search(q, near, searchAbort.signal));
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
  const centre: LatLng = lastFix ?? [map.getCenter().lat, map.getCenter().lng];
  // Cover roughly the visible map, clamped to something Overpass answers quickly.
  const bounds = map.getBounds();
  const radius = Math.min(
    Math.max(haversine([bounds.getNorth(), bounds.getWest()], [bounds.getSouth(), bounds.getEast()]) / 2, 800),
    12000
  );
  toast('Looking for summits, viewpoints and water…', 0);
  try {
    const pois = await fetchPois(centre, radius);
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
  const style = POI_STYLE[p.kind];
  const marker = L.marker(p.pos, {
    icon: L.divIcon({
      className: '',
      html: `<div class="poiMarker ${p.kind}">${style.icon}</div>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13]
    })
  });
  const height = p.ele !== undefined ? ` · ${Math.round(p.ele)} m` : '';
  const away = lastFix ? ` · ${formatDistance(haversine(lastFix, p.pos))} away` : '';
  marker.bindPopup(
    `<div style="font-size:13px;line-height:1.5">
      <b>${p.name.replace(/</g, '&lt;')}</b><br>
      ${style.label}${height}${away}<br>${positionText(p.pos)}
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
    <p class="hint">Summits, viewpoints and water sources from OpenStreetMap, around what you can see.
    Needs signal, and the free map-data servers are sometimes busy — retry if it fails. Tap again to hide.</p>
    <div class="row"><button id="poiBtn" style="flex:1">${poiLayer ? 'Hide nearby points' : "What's nearby"}</button></div>
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
    overlayTiles?.setOpacity(settings.overlayOpacity);
    saveSettings(settings);
  });
  $('keyBtn').addEventListener('click', () => showPanel(legendHtml(settings.baseLayer)));
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
      updateElevPanel();
    }
  });
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
  const tick = () => {
    qrRAF = requestAnimationFrame(tick);
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
        <div class="meta">
          <div class="name">${r.name.replace(/</g, '&lt;')}</div>
          <div class="sub">${formatDistance(r.distanceM)}${r.ascentM ? ` · ${climbText(r.ascentM, r.descentM)}` : ''}</div>
        </div>
        <button data-act="load">Load</button>
        <button data-act="share" class="secondary">Share</button>
        <button data-act="gpx" class="secondary">GPX</button>
        <button data-act="del" class="danger">✕</button>
      </div>`
        )
        .join('')
    : '<p class="hint">No saved routes yet. Import a GPX or plan one with the pencil tool.</p>';

  const pinItems = pins.length
    ? pins
        .map(
          (p) => `<div class="routeItem" data-pin="${p.id}">
        <span class="pinCat">${svgIcon(catMeta(p.category).icon)}</span>
        <div class="meta">
          <div class="name">${p.name.replace(/</g, '&lt;')}</div>
          <div class="sub">${gridText(p.lat, p.lng)}${typeof p.ele === 'number' ? ` · ${Math.round(p.ele)} m` : ''}</div>
        </div>
        <button data-pact="go">Go</button>
        <button data-pact="del" class="danger">✕</button>
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
        map.setView([pin.lat, pin.lng], Math.max(map.getZoom(), 15));
        openSavedPin(pin.id);
      } else {
        if (!confirm(`Delete “${pin.name}”?`)) return;
        pins = pins.filter((x) => x.id !== id);
        savePins(pins);
        renderPinMarkers();
        openRoutesPanel();
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
  if (!pinCardJustOpened) hidePinCard();
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
        tileUrlFor(def)
          .replace('{s}', 'a')
          .replace('{z}', String(z))
          .replace('{x}', String(x))
          .replace('{y}', String(y))
      );
    }
  }
  return [...urls];
}

$('rcOffline').addEventListener('click', async () => {
  if (!activeRoute) return toast('Load or plan a route first');
  if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) {
    return toast('Offline caching only works in the installed (built) app', 5000);
  }
  const defs = [layerDef(settings.baseLayer), settings.overlayLayer ? layerDef(settings.overlayLayer) : undefined]
    .filter(usable);
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
        const res = await fetch(url);
        if (!res.ok) failed++;
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
