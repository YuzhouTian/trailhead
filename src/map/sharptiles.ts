// Sharper tiles on a high-density screen, for a layer with no @2x tiles: at
// chosen levels, each tile is drawn from the four tiles of the next level in,
// at half size.
//
// OS Explorer is the case. Its 1:25k levels 7, 8 and 9 are all made from the
// one scanned map, so level 9 drawn at half size shows exactly what level 8
// does — the same ground, text the same size — with twice the pixels each way.
// On a 3× phone a level-8 pixel is spread over 3×3 screen pixels; a level-9
// one at half size over 1.5×1.5. That is the difference between the soft map
// that appeared on letting go at zoom 15 and the crisp one seen mid-pinch,
// while Leaflet was still shrinking the zoom-16 tiles. The cost is four tile
// requests instead of one at those zooms.
//
// Only within one map, though: OS level 6 is the 1:50k, so drawing zoom 13
// from level 7 would swap it for the 1:25k with its text at half size.
//
// Leaflet still sees one tile per grid square, so its tile maths, the
// placeholders it keeps from the old zoom while a new one loads, and the tile
// events all work unchanged. The tile is just a <div> of four <img>s.

import L from '../leaflet-setup';

/** The parts of Leaflet's TileLayer used here that its typings leave out. */
interface TileLayerInternals {
  _url: string;
  _map: L.Map;
  _tileZoom: number;
  _tiles: Record<string, { el: HTMLElement } | undefined>;
  _getZoomForUrl(): number;
  _getSubdomain(coords: L.Point): string;
  _pxBoundsToTileRange(bounds: L.Bounds): L.Bounds;
}

/** A four-image tile, with the two things TileLayer expects of an <img>. */
type QuadTile = HTMLDivElement & { readonly complete: boolean; src: string };

export interface SharpTileLayerOptions extends L.TileLayerOptions {
  /** URL levels to draw from the next level in; see the top of this file. */
  sharpLevels: number[];
}

const tileLayerProto = L.TileLayer.prototype as unknown as {
  _removeTile(key: string): void;
};

export class SharpTileLayer extends L.TileLayer {
  constructor(url: string, options: SharpTileLayerOptions) {
    super(url, options);
  }

  createTile(coords: L.Coords, done: L.DoneCallback): HTMLElement {
    const self = this as unknown as TileLayerInternals;
    const level = self._getZoomForUrl();
    const { sharpLevels } = this.options as SharpTileLayerOptions;
    if (!sharpLevels.includes(level)) return super.createTile(coords, done);

    // A tile on the edge of the grid can have children past it, which the
    // server has no tiles for. Those quarters stay empty.
    const world = self._map.getPixelWorldBounds(self._tileZoom + 1);
    const range = world && self._pxBoundsToTileRange(world);

    const tile = document.createElement('div') as QuadTile;
    tile.className = 'sharp-tile';
    const toLoad: [HTMLImageElement, string][] = [];
    let left = 0;
    let error: Error | undefined;
    let cancelled = false;
    const settle = (e?: Error) => {
      if (cancelled) return;
      error ??= e;
      if (--left === 0) done(error, tile);
    };

    for (const dy of [0, 1]) {
      for (const dx of [0, 1]) {
        const x = 2 * coords.x + dx;
        const y = 2 * coords.y + dy;
        const img = document.createElement('img');
        img.alt = '';
        img.style.left = `${dx * 50}%`;
        img.style.top = `${dy * 50}%`;
        tile.append(img);
        if (range && !range.contains([x, y])) continue;
        const { crossOrigin, referrerPolicy } = this.options;
        if (crossOrigin || crossOrigin === '') img.crossOrigin = crossOrigin === true ? '' : crossOrigin;
        if (typeof referrerPolicy === 'string') img.referrerPolicy = referrerPolicy;
        img.onload = () => settle();
        img.onerror = (e) => settle(e as unknown as Error);
        const s = self._getSubdomain(L.point(x, y));
        toLoad.push([img, L.Util.template(self._url, { ...this.options, s, x, y, z: level + 1 })]);
        left++;
      }
    }

    Object.defineProperties(tile, {
      complete: { get: () => left === 0 },
      // How TileLayer cancels a tile it no longer wants: pass it on to the four.
      src: {
        set: (url: string) => {
          cancelled = true;
          for (const [img] of toLoad) img.src = url;
        }
      }
    });
    for (const [img, url] of toLoad) img.src = url;
    return tile;
  }

  // TileLayer cancels a tile it drops with setAttribute('src'), which a <div>
  // ignores; go through the setter above instead.
  _removeTile(key: string): void {
    const el = (this as unknown as TileLayerInternals)._tiles[key]?.el;
    if (el?.classList.contains('sharp-tile')) (el as QuadTile).src = L.Util.emptyImageUrl;
    tileLayerProto._removeTile.call(this, key);
  }
}
