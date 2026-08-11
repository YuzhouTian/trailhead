// Offline tiles: work out which tile images cover the active route, then pull
// them through the service worker's cache so the map still draws when you are
// out of signal. Nothing here touches the map itself — it only asks map/map.ts
// which layers are in use and what their tile URLs look like, and fetches them.

import {
  OFFLINE_MAX_TILES,
  OFFLINE_TILE_BUFFER,
  OFFLINE_ZOOMS,
  type BaseLayerDef
} from '../config';
import { latLngToTile, type LatLng } from '../geo';
import { layerDef, tileUrlFor, usable } from '../map/map';
import { type SavedRoute, type Settings } from '../state';
import { $, hideToast, toast } from '../ui/dom';

/** How many tiles to fetch at once — enough to be quick, few enough to be polite. */
const FETCH_WORKERS = 6;

/**
 * Every tile URL covering `coords` on this layer, at each offline zoom, with a
 * buffer of tiles either side so a small detour off the line still has map.
 */
function tileUrls(def: BaseLayerDef, coords: LatLng[]): string[] {
  const urls = new Set<string>();
  // The template is the same for every tile on this layer, so build it once
  // rather than redoing the key/retina substitution thousands of times.
  const template = tileUrlFor(def);
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
        template
          .replace('{s}', 'a')
          .replace('{z}', String(z))
          .replace('{x}', String(x))
          .replace('{y}', String(y))
      );
    }
  }
  return [...urls];
}

/**
 * Wire up the active-route card's offline button. The route is read through a
 * getter rather than passed in: it changes under us as routes are planned,
 * loaded and closed, and it belongs to the app rather than to this feature.
 */
export function initOffline(opts: {
  settings: Settings;
  getActiveRoute: () => SavedRoute | null;
}): void {
  const { settings, getActiveRoute } = opts;

  $('rcOffline').addEventListener('click', async () => {
    const route = getActiveRoute();
    if (!route) return toast('Load or plan a route first');
    if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) {
      return toast('Offline caching only works in the installed (built) app', 5000);
    }
    const defs = [layerDef(settings.baseLayer), settings.overlayLayer ? layerDef(settings.overlayLayer) : undefined]
      .filter(usable);
    let urls = defs.flatMap((d) => tileUrls(d, route.coords));
    if (urls.length > OFFLINE_MAX_TILES) {
      toast(`Route too long — capping at ${OFFLINE_MAX_TILES} tiles`, 4000);
      urls = urls.slice(0, OFFLINE_MAX_TILES);
    }
    if (!confirm(`Download ~${urls.length} map tiles for offline use?`)) return;

    let done = 0;
    let failed = 0;
    const queue = [...urls];
    const workers = Array.from({ length: FETCH_WORKERS }, async () => {
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
}
