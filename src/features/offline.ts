// Offline tiles: work out which tile images cover the active route, then pull
// them through the service worker's cache so the map still draws when you are
// out of signal. Every usable base layer is saved, so switching layers offline
// still has map. Nothing here touches the map itself — it only asks map/map.ts
// which layers are usable and what their tile URLs look like, and fetches them.

import {
  BASE_LAYERS,
  OFFLINE_MAX_TILES,
  OFFLINE_ZOOMS,
  type BaseLayerDef
} from '../config';
import { latLngToTile, type LatLng } from '../geo';
import { highDensity, tileUrlFor, usable } from '../map/map';
import { inGB, osTileAt, osTileInGrid } from '../osgb';
import { type SavedRoute } from '../state';
import { $, hideToast, toast } from '../ui/dom';

/** How many tiles to fetch at once — enough to be quick, few enough to be polite. */
const FETCH_WORKERS = 6;

/** A tile position on a layer's own grid: x, y and the level in its URL. */
type TileKey = [x: number, y: number, level: number];

/**
 * The tiles under one point at app zoom `z`, as the map would ask for them.
 *
 * On the standard grid that is the zoom's own tile. OS is on the National Grid,
 * with its own level numbers (app zoom + zoomOffset), and at its sharpLevels a
 * high-density screen draws each tile from the four of the next level in
 * (map/sharptiles.ts) — so those four are the ones to keep. A tile the map
 * would never request is no use offline.
 */
function tilesAt(def: BaseLayerDef, lat: number, lng: number, z: number): TileKey[] {
  if (def.grid !== 'osgb') return [[...latLngToTile(lat, lng, z), z]];
  const level = z + (def.zoomOffset ?? 0);
  const [x, y] = osTileAt(lat, lng, level);
  if (!(def.sharpLevels?.includes(level) && highDensity())) return [[x, y, level]];
  return [
    [2 * x, 2 * y, level + 1],
    [2 * x + 1, 2 * y, level + 1],
    [2 * x, 2 * y + 1, level + 1],
    [2 * x + 1, 2 * y + 1, level + 1]
  ];
}

/** Whether the layer's server has this tile at all. */
function inGrid(def: BaseLayerDef, [x, y, level]: TileKey): boolean {
  if (def.grid === 'osgb') return osTileInGrid(x, y, level);
  const n = 2 ** level;
  return x >= 0 && y >= 0 && x < n && y < n;
}

/**
 * Every tile URL covering `coords` on this layer, at each offline zoom, with a
 * buffer of tiles either side so a small detour off the line still has map.
 */
function tileUrls(def: BaseLayerDef, coords: LatLng[]): string[] {
  // OS has no map outside Great Britain, so only the GB part of a route
  // counts — a route abroad downloads no OS tiles at all.
  if (def.grid === 'osgb') coords = coords.filter(([lat, lng]) => inGB(lat, lng));
  const urls = new Set<string>();
  // The template is the same for every tile on this layer, so build it once
  // rather than redoing the key/retina substitution thousands of times.
  const template = tileUrlFor(def);
  for (const { zoom: z, buffer: zoomBuffer } of OFFLINE_ZOOMS) {
    // Past its native zoom a layer stretches its last real tiles, which are
    // already saved — OS Explorer from 17 in. Asking for more would be asking
    // for tiles the server does not have.
    if (z > (def.maxNativeZoom ?? def.maxZoom) || z < (def.minZoom ?? 0)) continue;
    // The buffer is in tiles of the level being saved. A sharp OS level
    // saves the next level in, whose tiles are half the size, so it doubles
    // to keep the same ground either side of the line.
    const seen = new Set<string>();
    for (const [lat, lng] of coords) {
      for (const [tx, ty, level] of tilesAt(def, lat, lng, z)) {
        const buffer = level === z + (def.zoomOffset ?? 0) ? zoomBuffer : 2 * zoomBuffer;
        for (let dx = -buffer; dx <= buffer; dx++) {
          for (let dy = -buffer; dy <= buffer; dy++) {
            seen.add(`${tx + dx},${ty + dy},${level}`);
          }
        }
      }
    }
    for (const key of seen) {
      const tile = key.split(',').map(Number) as TileKey;
      if (!inGrid(def, tile)) continue;
      const [x, y, level] = tile;
      urls.add(
        template
          .replace('{s}', 'a')
          .replace('{z}', String(level))
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
  getActiveRoute: () => SavedRoute | null;
}): void {
  const { getActiveRoute } = opts;

  $('rcOffline').addEventListener('click', async () => {
    const route = getActiveRoute();
    // Belt and braces, not a state you can reach: ui/routeCard.ts hides this
    // button whenever there is no route (the card is hidden while planning), so by the time it
    // is clickable there is always one. Kept because that rule lives in another
    // module — this is what keeps offline.ts correct on its own if it drifts.
    if (!route) return toast('Load or plan a route first');
    if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) {
      return toast('Offline caching only works in the installed (built) app', 5000);
    }
    // Every layer you could switch to on the trail, not just the one on screen:
    // the moment you want another layer is usually the moment you have no
    // signal to load it. usable() drops the keyed layers with no key, so OS
    // Explorer comes along only once you have an OS key in Settings.
    //
    // The cap is per layer, so a long route trims every layer the same way
    // rather than filling up on the first and leaving the last half-missing.
    // Each layer's CORS support travels with its URLs: how a tile is fetched,
    // and whether the result can be checked, differ per layer.
    let capped = false;
    const layers = BASE_LAYERS.filter(usable).map((def) => {
      let urls = tileUrls(def, route.coords);
      if (urls.length > OFFLINE_MAX_TILES) {
        capped = true;
        urls = urls.slice(0, OFFLINE_MAX_TILES);
      }
      return { def, urls, failed: 0 };
    }).filter((l) => l.urls.length > 0); // OS, for a route outside GB
    const defs = layers.map((l) => l.def);
    const total = layers.reduce((n, l) => n + l.urls.length, 0);
    const names = defs.map((d) => d.name).join(', ');
    const ask = `Download ~${total} map tiles (${defs.length} layer${defs.length === 1 ? '' : 's'}: ${names}) for offline use?`;
    const cappedNote = capped ? `\n\nRoute too long — capping at ${OFFLINE_MAX_TILES} tiles per layer.` : '';
    if (!confirm(ask + cappedNote)) return;

    let done = 0;
    const queue = layers.flatMap((layer) => layer.urls.map((url) => ({ url, layer })));
    const workers = Array.from({ length: FETCH_WORKERS }, async () => {
      while (queue.length) {
        const { url, layer } = queue.shift()!;
        const cors = layer.def.cors !== false;
        try {
          // A default fetch is a CORS fetch, which a server that sends no CORS
          // header rejects outright — every Freemap tile would be counted a
          // failure and none would reach the cache. Ask the way the <img> does
          // instead. The response comes back opaque, so "it did not throw" is
          // the only success signal there is for those layers.
          const res = await fetch(url, cors ? undefined : { mode: 'no-cors' });
          if (cors && !res.ok) layer.failed++;
        } catch {
          layer.failed++;
        }
        done++;
        if (done % 25 === 0 || done === total) {
          toast(`Caching tiles… ${done}/${total}`, 0);
        }
      }
    });
    await Promise.all(workers);
    hideToast();
    // Name the layers that had trouble, so "Thunderforest failed" is not
    // hidden inside one total.
    const bad = layers.filter((l) => l.failed);
    toast(
      bad.length
        ? `Done — failed: ${bad.map((l) => `${l.def.name} (${l.failed}/${l.urls.length})`).join(', ')}`
        : `Offline tiles ready (${total}, ${defs.length} layer${defs.length === 1 ? '' : 's'})`,
      bad.length ? 6000 : 4000
    );
  });
}
