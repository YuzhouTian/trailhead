// The map itself: the Leaflet instance, its tile layers, the viewport quirks
// that keep it correctly sized, and the startup recentre that gives you local
// tiles instead of the whole UK. Everything drawn *on* the map — routes, pins,
// the GPS dot, search and POI markers — belongs to the features that own them;
// this module only knows about the canvas they draw on.

import L from '../leaflet-setup';
import { DEFAULT_LAYER_ID, crossOriginFor, missingKey, type BaseLayerDef } from '../config';
import { type LatLng } from '../geo';
import { loadLastView, saveLastView, saveSettings, type Settings } from '../state';
import { enableDoubleTapDragZoom } from '../tapzoom';
import { toast } from '../ui/dom';
import {
  FALLBACK_LAYER,
  TILE_FAILURES_BEFORE_FALLBACK,
  chooseBaseLayer,
  failingTilesNotice,
  needsRematch,
  tileUrl,
  viewTouchesGB,
  type ViewBounds
} from './layers';
import { SharpTileLayer } from './sharptiles';
import { osGridCrs, osNative, osReference, osTileSize, setOsNative, setOsReference } from './osgrid';

// Where the map opens when we have never seen you before: the whole of the UK.
// Only reached on a first run, or after localStorage has been cleared, or when
// what was stored there was rubbish.
const UK_FALLBACK_VIEW = { center: [54.5, -3.0] as LatLng, zoom: 6 };
// Match the "me"/follow zoom (see the locate button in main.ts) so the startup
// view and locating yourself land at the same scale.
//
// Who is allowed to move the map at startup, and why only one of them is:
// two things ask to at once — this one-shot geolocation call, and the GPS
// watch that features/tracking.ts starts in follow mode, whose first fix
// centres you and zooms to 15. Letting both act meant two jumps in the first
// few seconds. The rule is that the one-shot only moves the map when there is
// no saved view to open on (a first run, showing the whole UK, where sitting
// there until the watch answers is the worst of the options). When there *is*
// a saved view, the map already opens on the right piece of country, so the
// one-shot only hands the position back and the watch's first fix is the only
// move. That also covers the "new trip, hundreds of miles from last time"
// case: the watch recentres regardless of how far away the saved view was.
const STARTUP_LOCATION_ZOOM = 15;

// The view we opened on, kept so recentreOnStartup knows whether it should
// move. Read once, before the map exists, because the map itself is what it
// is used to build.
const savedView = loadLastView();

export const map = L.map('map', {
  zoomControl: true,
  // No credit line. Trailhead is a personal app rather than one published for
  // others, and the strip it took along the bottom is map you would rather see.
  attributionControl: false,
  rotate: true,
  touchRotate: false,
  rotateControl: false
}).setView(
  savedView?.center ?? UK_FALLBACK_VIEW.center,
  savedView?.zoom ?? UK_FALLBACK_VIEW.zoom
);

// Zoom with one finger: double-tap and drag, so you can do it one-handed.
enableDoubleTapDragZoom(map);

if (import.meta.env.DEV) {
  (window as unknown as { __map: L.Map }).__map = map;
}

// Settings are owned by the app and shared by reference: applyLayers() both
// reads them and writes corrections back (a retired layer, a missing key).
let settings: Settings;

// ---------------------------------------------------------------- tile layers

let baseTiles: L.TileLayer | null = null;

/** A screen with more than one device pixel to the CSS pixel: most phones. */
export function highDensity(): boolean {
  return window.devicePixelRatio > 1.3;
}

/** Fill in the API key and the retina suffix for a layer's tile URL. */
export function tileUrlFor(def: BaseLayerDef): string {
  return tileUrl(def, settings.osKey, highDensity());
}

function makeTileLayer(def: BaseLayerDef): L.TileLayer {
  const opts: L.TileLayerOptions = {
    maxZoom: def.maxZoom,
    maxNativeZoom: def.maxNativeZoom,
    // CORS requests let the service worker distinguish real tiles from
    // errors, so failures are never cached as permanent grey squares. Asking
    // for it from a server that does not send the header is worse than not
    // asking: the browser discards a good tile and the layer looks dead, so
    // hosts without CORS opt out and give up the status check instead.
    crossOrigin: crossOriginFor(def),
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
  if (def.zoomOffset !== undefined) opts.zoomOffset = def.zoomOffset;
  if (def.minZoom !== undefined) opts.minZoom = def.minZoom;
  // OS tiles are drawn larger than 256 px so the scale matches Freemap's at
  // the grid's reference latitude; see map/osgrid.ts.
  if (def.grid === 'osgb') opts.tileSize = osTileSize();
  if (def.sharpLevels && highDensity()) {
    return new SharpTileLayer(tileUrlFor(def), { ...opts, sharpLevels: def.sharpLevels });
  }
  return L.tileLayer(tileUrlFor(def), opts);
}

// ---------------------------------------------------------------- grid switch

/** Leaflet's view reset, which redraws everything under a changed CRS. */
type ResettableMap = L.Map & { _resetView(center: L.LatLng, zoom: number): void };

/** The grid the map is on now. */
let currentGrid: 'web' | 'osgb' = 'web';

/**
 * Put the map on `grid`, keeping the same centre and zoom number. Because the
 * OS grid is matched to Freemap's scale at the centre's latitude, the same zoom
 * number is the same scale: the switch redraws, but nothing on screen moves or
 * grows. Routes, pins and markers keep GPS coordinates and re-project
 * themselves on the reset.
 */
function setGrid(grid: 'web' | 'osgb', minZoom: number): void {
  if (grid === currentGrid) return;
  const centre = map.getCenter();
  const zoom = Math.max(map.getZoom(), minZoom);
  if (grid === 'osgb') setOsReference(centre.lat, centre.lng);
  map.options.crs = grid === 'osgb' ? osGridCrs : L.CRS.EPSG3857;
  currentGrid = grid;
  (map as ResettableMap)._resetView(centre, zoom);
}

/** The map on screen, as layers.ts takes it. */
function viewBounds(): ViewBounds {
  const b = map.getBounds();
  return { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
}

/** Hand a GB-only layer over to Freemap once the map has left GB. */
function leaveOsOutsideGB(): boolean {
  if (currentGrid !== 'osgb' || viewTouchesGB(viewBounds())) return false;
  toast('No OS map here — switched to Freemap', 4000);
  settings.baseLayer = DEFAULT_LAYER_ID;
  applyLayers();
  return true;
}

function onMoveEnd(): void {
  if (!leaveOsOutsideGB()) rematchOsGrid();
}

function rematchOsGrid(): void {
  // OS's own scale is the same everywhere: nothing to re-match.
  if (currentGrid !== 'osgb' || !baseTiles || osNative()) return;
  const centre = map.getCenter();
  if (!needsRematch(centre, osReference())) return;
  setOsReference(centre.lat, centre.lng);
  baseTiles.options.tileSize = osTileSize();
  (map as ResettableMap)._resetView(centre, map.getZoom());
}

/**
 * Draw OS Explorer at OS's own scale, or matched to Freemap's. Native keeps
 * the zoom number, so the map shows 1.14–1.5× more ground than Freemap did at
 * the same zoom (more the further north) and every tile is drawn pixel for
 * pixel; matched keeps the ground and enlarges the tiles by that much instead.
 */
export function setOsNativeScale(on: boolean): void {
  settings.osNative = on;
  saveSettings(settings);
  setOsNative(on);
  if (currentGrid !== 'osgb' || !baseTiles) return;
  const centre = map.getCenter();
  // Matching only happens on a switch or a long pan; do it here so going back
  // to matched is matched where the map is now.
  setOsReference(centre.lat, centre.lng);
  baseTiles.options.tileSize = osTileSize();
  (map as ResettableMap)._resetView(centre, map.getZoom());
}

/** A layer is usable if it exists and any key it needs has been entered. */
export function usable(def: BaseLayerDef | undefined): def is BaseLayerDef {
  return !!def && !missingKey(def, settings);
}

export function applyLayers(): void {
  // Which layer, and why if it is not the one Settings names: see layers.ts.
  const { layer: base, notice } = chooseBaseLayer(settings.baseLayer, settings, viewBounds());
  if (notice) toast(notice, 4000);
  settings.baseLayer = base.id;
  baseTiles?.remove();
  // Switch grid before the tile layer is made: its tile size depends on where
  // the OS grid is matched.
  setGrid(base.grid ?? 'web', base.minZoom ?? 0);
  map.setMinZoom(base.minZoom ?? 0);
  baseTiles = makeTileLayer(base).addTo(map);

  // Layers disagree about how far in they go (OpenStreetMap 19, Freemap and OS 18), so
  // switching down from a deeper layer can leave the map at a zoom the new one
  // will not serve. Leaflet only clamps on the next interaction; do it now.
  if (map.getZoom() > base.maxZoom) map.setZoom(base.maxZoom);

  // Tiles that keep failing — a wrong key, or the edge of Freemap's data —
  // bail out to the dependable layer rather than leave a blank map. Never
  // watched on the fallback itself, which would loop; see failingTilesNotice.
  const failing = failingTilesNotice(base);
  if (failing) {
    let failures = 0;
    baseTiles.on('tileerror', () => {
      if (++failures !== TILE_FAILURES_BEFORE_FALLBACK || settings.baseLayer !== base.id) return;
      toast(failing, 6000);
      settings.baseLayer = FALLBACK_LAYER.id;
      applyLayers();
    });
  }

  saveSettings(settings);
}

// ---------------------------------------------------------------- startup

// Following moves the map about once a second while you walk. Wait for it to
// settle rather than writing to localStorage ~3,600 times an hour.
const SAVE_VIEW_DEBOUNCE_MS = 500;

/**
 * Remember where the map is, so the next launch opens here.
 *
 * Saved on every settled move, whoever caused it — your own panning, the
 * startup recentre, the map following you along a walk. The alternative — a
 * flag that skips the moves the app made itself — was considered and dropped:
 * wherever the map ended up is somewhere you were actually looking, and so it
 * is the right place to reopen on.
 */
function rememberView(): void {
  let timer: number | undefined;
  map.on('moveend zoomend', () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      const c = map.getCenter();
      saveLastView({ center: [c.lat, c.lng], zoom: map.getZoom() });
    }, SAVE_VIEW_DEBOUNCE_MS);
  });
}

/**
 * Recentre on your current location at startup, for the initial tiles — but
 * only on a launch with no saved view to open on; see STARTUP_LOCATION_ZOOM
 * for why exactly one thing is allowed to move the map at startup. The
 * position is handed back either way, because "how far away is that pin" wants
 * it whether or not the map moved.
 *
 * This is deliberately separate from the "me"/follow control — no marker, no
 * accuracy circle, no follow, and it bows out the moment you touch the map so
 * it can't yank you away mid-interaction.
 */
function recentreOnStartup(onPosition: (p: LatLng) => void): void {
  if (!('geolocation' in navigator)) return;
  let userTouchedMap = false;
  map.getContainer().addEventListener(
    'pointerdown',
    () => { userTouchedMap = true; },
    { once: true }
  );
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      // Keep the position even when we decline to move the map: a pin dropped
      // before Me is ever switched on can still say how far away it is.
      onPosition([pos.coords.latitude, pos.coords.longitude]);
      if (userTouchedMap || savedView) return;
      map.setView([pos.coords.latitude, pos.coords.longitude], STARTUP_LOCATION_ZOOM);
    },
    () => { /* denied or unavailable — the UK fallback view stays put */ },
    { enableHighAccuracy: false, maximumAge: 600_000, timeout: 10_000 }
  );
}

/**
 * iOS standalone mode settles its viewport after load, leaving Leaflet with a
 * stale (shorter) size and a blank strip at the bottom — re-measure whenever
 * the visual viewport changes and repeatedly while startup settles.
 */
function watchViewport(): void {
  const remeasure = () => map.invalidateSize({ animate: false });
  window.visualViewport?.addEventListener('resize', remeasure);
  window.addEventListener('orientationchange', () => setTimeout(remeasure, 250));
  window.addEventListener('pageshow', () => setTimeout(remeasure, 100));
  window.addEventListener('touchstart', remeasure, { once: true });
  for (const t of [100, 350, 700, 1500, 3000]) setTimeout(remeasure, t);
}

/**
 * Bring the map up: settings-dependent layers, the viewport watchdogs, and the
 * startup recentre. `onStartupPosition` hands the one-shot fix back to the app,
 * which is where "the last position we know of" lives.
 */
export function initMap(opts: {
  settings: Settings;
  onStartupPosition: (p: LatLng) => void;
}): void {
  settings = opts.settings;
  setOsNative(settings.osNative);
  recentreOnStartup(opts.onStartupPosition);
  rememberView();
  watchViewport();
  map.on('moveend', onMoveEnd);
  applyLayers();
}
