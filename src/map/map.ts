// The map itself: the Leaflet instance, its tile layers, the viewport quirks
// that keep it correctly sized, and the startup recentre that gives you local
// tiles instead of the whole UK. Everything drawn *on* the map — routes, pins,
// the GPS dot, search and POI markers — belongs to the features that own them;
// this module only knows about the canvas they draw on.

import L from '../leaflet-setup';
import { BASE_LAYERS, FALLBACK_LAYER_ID, crossOriginFor, type BaseLayerDef } from '../config';
import { type LatLng } from '../geo';
import { loadLastView, saveLastView, saveSettings, type Settings } from '../state';
import { enableDoubleTapDragZoom } from '../tapzoom';
import { toast } from '../ui/dom';

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

export function layerDef(id: string): BaseLayerDef | undefined {
  return BASE_LAYERS.find((l) => l.id === id);
}

/** Fill in the API key and the retina suffix for a layer's tile URL. */
export function tileUrlFor(def: BaseLayerDef): string {
  const scale = def.retina && window.devicePixelRatio > 1.3 ? '@2x' : '';
  return def.url.replace('{tfKey}', settings.tfKey).replace('{r}', scale);
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
  return L.tileLayer(tileUrlFor(def), opts);
}

/** The layer we fall back to: always available, never needs a key. */
const FALLBACK_LAYER =
  BASE_LAYERS.find((l) => l.id === FALLBACK_LAYER_ID) ??
  BASE_LAYERS.find((l) => !l.needsTfKey) ??
  BASE_LAYERS[0];

/** A layer is usable if it exists and any key it needs has been entered. */
export function usable(def: BaseLayerDef | undefined): def is BaseLayerDef {
  return !!def && !(def.needsTfKey && !settings.tfKey);
}

export function applyLayers(): void {
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

  // Layers disagree about how far in they go (Freemap 20, OpenStreetMap 19), so
  // switching down from a deeper layer can leave the map at a zoom the new one
  // will not serve. Leaflet only clamps on the next interaction; do it now.
  if (map.getZoom() > base.maxZoom) map.setZoom(base.maxZoom);

  // Tiles can fail for reasons the checks above cannot see: a *wrong* key 401s,
  // and Freemap covers Europe only, so walking off the edge of its data returns
  // nothing. Either way you get a blank map with no explanation — bail out to
  // the dependable layer instead. Never attached to the fallback itself, which
  // would loop. Four failures rather than one so a blip does not switch layers.
  if (base.id !== FALLBACK_LAYER.id) {
    let failures = 0;
    baseTiles.on('tileerror', () => {
      if (++failures !== 4 || settings.baseLayer !== base.id) return;
      toast(
        base.needsTfKey
          ? `${base.name} tiles are failing — check the key in Settings`
          : `${base.name} has no tiles here — switched to ${FALLBACK_LAYER.name}`,
        6000
      );
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
  recentreOnStartup(opts.onStartupPosition);
  rememberView();
  watchViewport();
  applyLayers();

  // Metric scale bar so distance is readable at a glance. Leaflet calls it
  // "bottomleft", but style.css moves it to the right-hand edge, just above the
  // tab bar and under the Me button.
  L.control.scale({ imperial: false, position: 'bottomleft', maxWidth: 120 }).addTo(map);
}
