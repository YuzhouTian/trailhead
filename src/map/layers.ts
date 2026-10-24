// Which base map to draw, and what to say about it: the decisions behind
// map.ts's applyLayers and its grid upkeep, with the map itself left out.
//
// They live apart from map.ts because map.ts cannot be imported in a test — it
// builds a real Leaflet map the moment it loads — and these are the rules worth
// pinning: which layer you land on when the one you chose cannot be shown, what
// you are told about it, and what a tile URL looks like once the key and the
// retina suffix are in. Everything here is a function of its arguments.

import {
  BASE_LAYERS,
  DEFAULT_LAYER_ID,
  FALLBACK_LAYER_ID,
  missingKey,
  type BaseLayerDef
} from '../config';
import { inGB } from '../osgb';

export function layerDef(id: string): BaseLayerDef | undefined {
  return BASE_LAYERS.find((l) => l.id === id);
}

/** Resolve one of config's layer ids, with a keyless layer as a backstop. */
const namedLayer = (id: string): BaseLayerDef =>
  BASE_LAYERS.find((l) => l.id === id) ??
  BASE_LAYERS.find((l) => !l.needsKey) ??
  BASE_LAYERS[0];

/** The map to show when the chosen one isn't available here. */
export const DEFAULT_LAYER = namedLayer(DEFAULT_LAYER_ID);

/** The last resort, for tiles that are actually failing. */
export const FALLBACK_LAYER = namedLayer(FALLBACK_LAYER_ID);

/**
 * A layer's tile URL template with the API key and the retina suffix filled
 * in. `dense` is whether the screen is high-density; only a layer with @2x
 * tiles of its own asks for them.
 */
export function tileUrl(def: BaseLayerDef, osKey: string, dense: boolean): string {
  const scale = def.retina && dense ? '@2x' : '';
  return def.url.replace('{osKey}', osKey).replace('{r}', scale);
}

/** The edges of the map on screen, in degrees. */
export interface ViewBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

/**
 * Whether any of the visible map is over Great Britain, sampled on a 3×3 grid
 * across the view. Any one point is enough to keep OS: it is the map you chose,
 * and half a screen of it on a coast is still worth having.
 */
export function viewTouchesGB(b: ViewBounds): boolean {
  for (const fy of [0, 0.5, 1]) {
    for (const fx of [0, 0.5, 1]) {
      const lat = b.south + fy * (b.north - b.south);
      const lng = b.west + fx * (b.east - b.west);
      if (inGB(lat, lng)) return true;
    }
  }
  return false;
}

/** For the one layer that needs a key, picked without it. */
export const NEEDS_KEY_TOAST = 'OS Explorer needs an OS Data Hub key — add it in Settings';

/**
 * Why a keyed layer's tiles might be failing. OS has a second cause: past the
 * Premium plan's free monthly allowance with no card registered, it stops
 * serving the 1:25k zooms while the rest still load.
 */
export const KEY_FAILING_TOAST =
  'tiles are failing — check the OS key in Settings, and that your Data Hub plan includes Premium';

/**
 * The layer to draw for the one Settings names, and what to tell the walker
 * when it is not that one (null when it is, or when there is nothing to say).
 *
 * Lands on the default map for both a missing key and settings still naming a
 * retired layer (Thunderforest's Outdoors, and the old OS Outdoor and Light
 * layers, among them). Deliberately not FALLBACK_LAYER: that is the escape from
 * tiles that are failing, and the reference rendering is a poor map to strand a
 * walker on while the keyless hill map is right there.
 *
 * A layer picked, or opened on, somewhere it has no map goes straight to the
 * default too, rather than switching grids to show a blank one.
 */
export function chooseBaseLayer(
  id: string,
  keys: { osKey: string },
  view: ViewBounds
): { layer: BaseLayerDef; notice: string | null } {
  const requested = layerDef(id);
  if (requested && !missingKey(requested, keys)) {
    if (requested.grid === 'osgb' && !viewTouchesGB(view)) {
      return { layer: DEFAULT_LAYER, notice: `${requested.name} covers Great Britain only — showing Freemap` };
    }
    return { layer: requested, notice: null };
  }
  // A retired layer needs no word: the walker never chose what it became.
  return { layer: DEFAULT_LAYER, notice: requested?.needsKey ? NEEDS_KEY_TOAST : null };
}

/**
 * How many tile errors on a layer before giving up on it: four rather than one,
 * so a blip does not switch layers.
 */
export const TILE_FAILURES_BEFORE_FALLBACK = 4;

/**
 * What to say when `base`'s tiles keep failing and the map bails out to
 * FALLBACK_LAYER, or null for the fallback itself, which is never given up on
 * — that would loop.
 *
 * Tiles can fail for reasons the checks in chooseBaseLayer cannot see: a
 * *wrong* key 401s, and Freemap covers Europe only, so walking off the edge of
 * its data returns nothing. Either way the walker would get a blank map with no
 * explanation.
 */
export function failingTilesNotice(base: BaseLayerDef): string | null {
  if (base.id === FALLBACK_LAYER.id) return null;
  return base.needsKey
    ? `${base.name} ${KEY_FAILING_TOAST}`
    : `${base.name} has no tiles here — switched to ${FALLBACK_LAYER.name}`;
}

/**
 * Freemap's scale changes with latitude and the OS grid's does not, so after a
 * long pan north or south the grid is re-matched where the map now is. 0.5°
 * keeps each step to about 1% of scale — too little to see. East–west the
 * grid's own scale factor drifts far more slowly, so a whole degree is allowed.
 */
const REMATCH_LAT_DEG = 0.5;
const REMATCH_LNG_DEG = 1;

/** Whether the map has moved far enough from where the OS grid was matched to match it again. */
export function needsRematch(centre: { lat: number; lng: number }, ref: { lat: number; lng: number }): boolean {
  return Math.abs(centre.lat - ref.lat) > REMATCH_LAT_DEG || Math.abs(centre.lng - ref.lng) > REMATCH_LNG_DEG;
}
