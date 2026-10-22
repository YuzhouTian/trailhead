// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import L from '../leaflet-setup';
import { osGridCrs, setOsNative } from './osgrid';
import { SharpTileLayer } from './sharptiles';

const URL = 'https://tiles.test/{z}/{x}/{y}.png';

describe('SharpTileLayer', () => {
  let map: L.Map;
  let layer: SharpTileLayer;

  beforeEach(() => {
    setOsNative(true);
    map = L.map(document.createElement('div'), { crs: osGridCrs }).setView([54.53, -3.02], 15);
    layer = new SharpTileLayer(URL, {
      zoomOffset: -7,
      minNativeZoom: 7,
      maxNativeZoom: 16,
      tileSize: 256,
      sharpLevels: [7, 8]
    }).addTo(map);
  });

  afterEach(() => {
    map.remove();
    setOsNative(false);
  });

  /** The <img>s inside a tile, and the URLs they ask for. */
  function srcs(tile: HTMLElement): string[] {
    return [...tile.querySelectorAll('img')].map((img) => img.src);
  }

  it('draws a sharp level from the four tiles of the next level in', () => {
    // Zoom 15 is level 8: tile (320, 961) is made of level 9's (640–641, 1922–1923).
    const tile = layer.createTile(L.point(320, 961) as L.Coords, () => {});
    expect(tile.tagName).toBe('DIV');
    expect(srcs(tile)).toEqual([
      'https://tiles.test/9/640/1922.png',
      'https://tiles.test/9/641/1922.png',
      'https://tiles.test/9/640/1923.png',
      'https://tiles.test/9/641/1923.png'
    ]);
  });

  it('draws other levels as plain tiles', () => {
    map.setZoom(13, { animate: false });
    const tile = layer.createTile(L.point(80, 240) as L.Coords, () => {}) as HTMLImageElement;
    expect(tile.tagName).toBe('IMG');
    expect(tile.src).toBe('https://tiles.test/6/80/240.png');
  });

  it('is ready once all four have loaded, and reports any that failed', () => {
    const done = vi.fn();
    const tile = layer.createTile(L.point(320, 961) as L.Coords, done) as HTMLElement & { complete: boolean };
    const imgs = [...tile.querySelectorAll('img')];
    imgs.slice(0, 3).forEach((img) => img.dispatchEvent(new Event('load')));
    expect(done).not.toHaveBeenCalled();
    expect(tile.complete).toBe(false);
    imgs[3].dispatchEvent(new Event('error'));
    expect(done).toHaveBeenCalledOnce();
    expect(done.mock.calls[0][0]).toBeInstanceOf(Event);
    expect(tile.complete).toBe(true);
  });

  it('cancels all four when Leaflet cancels the tile', () => {
    const done = vi.fn();
    const tile = layer.createTile(L.point(320, 961) as L.Coords, done) as HTMLElement & { src: string };
    tile.src = L.Util.emptyImageUrl;
    expect(srcs(tile).every((s) => s === L.Util.emptyImageUrl)).toBe(true);
    tile.querySelectorAll('img').forEach((img) => img.dispatchEvent(new Event('load')));
    expect(done).not.toHaveBeenCalled();
  });
});
