// The map itself: the Leaflet instance, its tile layers, the viewport quirks
// that keep it correctly sized, and the startup recentre that gives you local
// tiles instead of the whole UK. Everything drawn *on* the map — routes, pins,
// the GPS dot, search and POI markers — belongs to the features that own them;
// this module only knows about the canvas they draw on.

import L from '../leaflet-setup';
import { BASE_LAYERS, type BaseLayerDef } from '../config';
import { type LatLng } from '../geo';
import { saveSettings, type Settings } from '../state';
import { enableDoubleTapDragZoom } from '../tapzoom';
import { toast } from '../ui/dom';

// The map opens on a whole-UK view, then recentres on your actual area on
// every startup once geolocation resolves. If location is denied, unavailable,
// or times out, the UK view stays put.
const UK_FALLBACK_VIEW = { center: [54.5, -3.0] as LatLng, zoom: 6 };
// Match the "me"/follow zoom (see the locate button in main.ts) so the startup
// view and locating yourself land at the same scale.
const STARTUP_LOCATION_ZOOM = 15;

export const map = L.map('map', {
  zoomControl: true,
  rotate: true,
  touchRotate: false,
  rotateControl: false
}).setView(UK_FALLBACK_VIEW.center, UK_FALLBACK_VIEW.zoom);

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
let overlayTiles: L.TileLayer | null = null;

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

/** Live opacity while the Map panel's slider is dragged. */
export function setOverlayOpacity(opacity: number): void {
  overlayTiles?.setOpacity(opacity);
}

// ---------------------------------------------------------------- startup

/**
 * Recentre on your current location at startup, for the initial tiles. This is
 * deliberately separate from the "me"/follow control — no marker, no accuracy
 * circle, no follow, and it bows out the moment you touch the map so it can't
 * yank you away mid-interaction.
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
      if (userTouchedMap) return;
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
  watchViewport();
  applyLayers();

  // Metric scale bar (bottom-left, above the nav bar) so distance is readable at
  // a glance. The attribution is bottom-right, and on the Thunderforest layer it
  // grew wide enough to reach across and sit on top of the scale — see the
  // stacking in style.css, which puts the scale on its own line above it.
  L.control.scale({ imperial: false, position: 'bottomleft', maxWidth: 120 }).addTo(map);

  // Drop Leaflet's own "Leaflet | " prefix. It is BSD-licensed and asks for no
  // in-UI credit, so it is the one part of that line we can reclaim — the
  // OpenStreetMap and Thunderforest credits are required and stay verbatim.
  map.attributionControl.setPrefix(false);
}
