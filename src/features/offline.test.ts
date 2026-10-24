// @vitest-environment jsdom

// The offline download: which tiles a route needs, on which layers, and what
// the walker is told about it. The tile arithmetic is the part worth pinning —
// OS's level offset, the sharp levels a high-density screen draws from the
// level in, the buffer that has to double to keep the same ground, the zoom
// each server stops at — because a mistake in any of it does not fail loudly.
// It downloads happily, and the gap is found on a hill with no signal.
//
// So this taps the real button and reads the answer off what was fetched,
// rather than calling the arithmetic directly: the URLs the download asks for
// are the only thing that ends up in the cache, so they are what to check.

import indexHtml from '../../index.html?raw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OFFLINE_MAX_TILES, type BaseLayerDef } from '../config';
import { latLngToTile, type LatLng } from '../geo';
import type { SavedRoute } from '../state';

/** The screen and the Settings key, as each test wants them. */
const device = vi.hoisted(() => ({ dense: false, osKey: '' }));

// map.ts cannot be imported here — it builds a real Leaflet map the moment it
// loads — so these are its three helpers as offline.ts sees them, keyed off
// `device` instead of the window and the saved settings.
vi.mock('../map/map', async () => {
  const { missingKey } = await import('../config');
  return {
    highDensity: () => device.dense,
    tileUrlFor: (def: BaseLayerDef) =>
      def.url.replace('{osKey}', device.osKey).replace('{r}', def.retina && device.dense ? '@2x' : ''),
    usable: (def: BaseLayerDef | undefined) => !!def && !missingKey(def, { osKey: device.osKey })
  };
});
// The sheet itself is ui/confirm.ts's business; here it only matters what it
// was asked and what the walker answered.
vi.mock('../ui/confirm', () => ({ askConfirm: vi.fn(async () => true) }));

import { askConfirm } from '../ui/confirm';
import { initOffline } from './offline';

const GLENRIDDING: LatLng = [54.544, -2.95];
const CHAMONIX: LatLng = [45.92, 6.87];
/** Inside the National Grid's square, which takes in eastern Ireland, but not in GB. */
const DUBLIN: LatLng = [53.35, -6.26];

/** The button and the toast, lifted out of the real index.html. */
const PAGE = (() => {
  const doc = new DOMParser().parseFromString(indexHtml, 'text/html');
  return ['rcOffline', 'toast'].map((id) => doc.getElementById(id)!.outerHTML).join('');
})();

type Layer = 'freemap' | 'os' | 'osm';

interface Fetched {
  url: string;
  init: RequestInit | undefined;
  layer: Layer;
  z: number;
  x: number;
  y: number;
}

/** Which layer a tile URL is for, and the z/x/y in it. */
function parse(url: string, init: RequestInit | undefined): Fetched {
  const layer: Layer = url.includes('freemap.sk') ? 'freemap' : url.includes('api.os.uk') ? 'os' : 'osm';
  const [, z, x, y] = url.match(/\/(\d+)\/(\d+)\/(\d+)(?:@2x)?(?:\.png)?(?:\?.*)?$/)!.map(Number);
  return { url, init, layer, z, x, y };
}

/** A tile server's answer: a 200, or a CORS-less host's opaque one. */
type Answer = (f: Fetched) => Partial<Response> | Error;

const opaqueOrOk: Answer = (f) => (f.init?.mode === 'no-cors' ? { ok: false, status: 0, type: 'opaque' } : { ok: true, status: 200 });

let fetched: Fetched[];
let answer: Answer;
let inFlight: number;
let mostInFlight: number;

function installWorker(controller: object | null) {
  Object.defineProperty(navigator, 'serviceWorker', { value: { controller }, configurable: true });
}

let route: SavedRoute | null;
const along = (coords: LatLng[]) => {
  route = { id: 'r', name: 'Test', waypoints: null, coords, distanceM: 0, ascentM: 0, createdAt: 0 };
};

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = PAGE;
  device.dense = false;
  device.osKey = '';
  fetched = [];
  answer = opaqueOrOk;
  inFlight = 0;
  mostInFlight = 0;
  along([GLENRIDDING]);
  installWorker({});
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const f = parse(url, init);
    fetched.push(f);
    mostInFlight = Math.max(mostInFlight, ++inFlight);
    // A tick before answering, so every worker has its request out at once.
    await Promise.resolve();
    inFlight--;
    const a = answer(f);
    if (a instanceof Error) throw a;
    return a;
  });
  initOffline({ getActiveRoute: () => route });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Tap the offline button and let the download run out. Every fetch here
 * answers on a microtask, so one trip round the event loop sees it finish.
 */
async function tapDownload() {
  document.getElementById('rcOffline')!.click();
  await new Promise((r) => setTimeout(r, 0));
}

const toastText = () => document.getElementById('toast')!.textContent;
const asked = () => vi.mocked(askConfirm).mock.calls[0]?.[0] ?? '';
const on = (layer: Layer) => fetched.filter((f) => f.layer === layer);

/** How many tiles were fetched at each URL level on one layer. */
function perLevel(layer: Layer): Record<number, number> {
  const out: Record<number, number> = {};
  for (const f of on(layer)) out[f.z] = (out[f.z] ?? 0) + 1;
  return out;
}

describe('before anything is fetched', () => {
  it('says it needs the installed app when no service worker controls the page', async () => {
    installWorker(null);
    await tapDownload();
    expect(toastText()).toMatch(/only works in the installed/);
    expect(askConfirm).not.toHaveBeenCalled();
    expect(fetched).toEqual([]);
  });

  it('asks for a route when there is none', async () => {
    route = null;
    await tapDownload();
    expect(toastText()).toBe('Load or plan a route first');
    expect(fetched).toEqual([]);
  });

  it('asks once, naming each layer and the tile count it then fetches', async () => {
    await tapDownload();
    expect(askConfirm).toHaveBeenCalledOnce();
    expect(asked()).toContain('2 layers: Outdoor (Freemap), OpenStreetMap');
    expect(asked()).toContain(`~${fetched.length} map tiles`);
    expect(asked()).not.toMatch(/capping/);
  });

  it('fetches nothing when the walker says no', async () => {
    vi.mocked(askConfirm).mockResolvedValueOnce(false);
    await tapDownload();
    expect(fetched).toEqual([]);
  });
});

describe('which layers come along', () => {
  it('leaves OS Explorer out until there is an OS key', async () => {
    await tapDownload();
    expect(new Set(fetched.map((f) => f.layer))).toEqual(new Set(['freemap', 'osm']));
  });

  it('saves OS Explorer once there is a key, with the key in every URL', async () => {
    device.osKey = 'K3Y';
    await tapDownload();
    expect(asked()).toContain('3 layers: Outdoor (Freemap), OS Explorer (1:25k), OpenStreetMap');
    expect(on('os').length).toBeGreaterThan(0);
    expect(on('os').every((f) => f.url.endsWith('?key=K3Y'))).toBe(true);
  });

  it('saves no OS for a route abroad, and does not count it as a layer', async () => {
    device.osKey = 'K3Y';
    along([CHAMONIX]);
    await tapDownload();
    expect(asked()).toContain('2 layers: Outdoor (Freemap), OpenStreetMap');
    expect(on('os')).toEqual([]);
  });

  it('saves OS for only the British part of a route that leaves Great Britain', async () => {
    // Dublin is on OS's grid, so OS would serve tiles there — of an empty
    // map. Only being outside GB keeps them out of the download.
    device.osKey = 'K3Y';
    await tapDownload();
    const gbOnly = on('os').map((f) => f.url).sort();

    fetched = [];
    along([GLENRIDDING, DUBLIN]);
    await tapDownload();
    expect(on('os').map((f) => f.url).sort()).toEqual(gbOnly);
  });
});

describe('which tiles', () => {
  it('saves a 3×3 block around the line from zoom 12 to 17, and 5×5 at 18', async () => {
    await tapDownload();
    expect(perLevel('freemap')).toEqual({ 12: 9, 13: 9, 14: 9, 15: 9, 16: 9, 17: 9, 18: 25 });
    // And the block is centred on the route, not merely the right size.
    const [cx, cy] = latLngToTile(GLENRIDDING[0], GLENRIDDING[1], 14);
    const at14 = on('freemap').filter((f) => f.z === 14);
    expect(at14.map((f) => f.x).sort((a, b) => a - b)).toEqual([cx - 1, cx - 1, cx - 1, cx, cx, cx, cx + 1, cx + 1, cx + 1]);
    expect(at14.map((f) => f.y).sort((a, b) => a - b)).toEqual([cy - 1, cy - 1, cy - 1, cy, cy, cy, cy + 1, cy + 1, cy + 1]);
  });

  it('puts OS seven levels down in its URLs and stops at its last real tiles', async () => {
    // App zoom 12–16 is OS level 5–9. Zoom 17 and 18 only stretch level 9,
    // which is already saved, so they add nothing.
    device.osKey = 'K3Y';
    await tapDownload();
    expect(perLevel('os')).toEqual({ 5: 9, 6: 9, 7: 9, 8: 9, 9: 9 });
  });

  it('asks a high-density screen for @2x Freemap, and a standard one for plain', async () => {
    await tapDownload();
    expect(on('freemap').some((f) => f.url.endsWith('@2x'))).toBe(false);

    device.dense = true;
    fetched = [];
    await tapDownload();
    expect(on('freemap').every((f) => f.url.endsWith('@2x'))).toBe(true);
    // OpenStreetMap has no @2x tiles to ask for.
    expect(on('osm').some((f) => f.url.includes('@2x'))).toBe(false);
  });

  it('on a high-density screen, saves the level a sharp OS level is drawn from instead of it', async () => {
    // Levels 5, 7 and 8 are sharp, so the map draws each from four tiles of
    // the next level in and never asks for the level itself. A 3×3 block at
    // the sharp level is 6×6 at the level in: the same ground either side.
    // Levels 6 and 9 also come in their own right, from zoom 13 and 16, but
    // those blocks sit inside the ones already saved.
    device.osKey = 'K3Y';
    device.dense = true;
    await tapDownload();
    expect(perLevel('os')).toEqual({ 6: 36, 8: 36, 9: 36 });
  });

  it('asks for each tile once, however many points of the line fall in it', async () => {
    await tapDownload();
    const one = fetched.map((f) => f.url).sort();

    fetched = [];
    along([GLENRIDDING, [GLENRIDDING[0] + 0.00001, GLENRIDDING[1]], GLENRIDDING]);
    await tapDownload();
    expect(fetched.map((f) => f.url).sort()).toEqual(one);
  });

  it('does not ask for tiles past the edge of the world', async () => {
    along([[0, 179.999]]);
    await tapDownload();
    expect(on('osm').every((f) => f.x < 2 ** f.z)).toBe(true);
    // The column east of the line is not there, so each zoom's block is 2 wide.
    expect(perLevel('osm')[12]).toBe(6);
  });
});

describe('a long route', () => {
  // About 110 km due north from Glenridding, a point every 55 m: far more
  // than the cap at zoom 18 alone.
  const LONG: LatLng[] = Array.from({ length: 2000 }, (_, i) => [54 + i / 2000, -2.95]);

  it('caps every layer at the same limit, and says so before asking', async () => {
    along(LONG);
    await tapDownload();
    expect(asked()).toContain(`capping at ${OFFLINE_MAX_TILES} tiles per layer`);
    expect(asked()).toContain(`~${2 * OFFLINE_MAX_TILES} map tiles`);
    expect(on('freemap')).toHaveLength(OFFLINE_MAX_TILES);
    expect(on('osm')).toHaveLength(OFFLINE_MAX_TILES);
  });
});

describe('fetching', () => {
  it('asks Freemap the way an <img> does, because it sends no CORS header', async () => {
    await tapDownload();
    expect(on('freemap').every((f) => f.init?.mode === 'no-cors')).toBe(true);
    expect(on('osm').every((f) => f.init === undefined)).toBe(true);
  });

  it('keeps no more than six tiles in flight', async () => {
    await tapDownload();
    expect(mostInFlight).toBe(6);
  });

  it('says it is ready, with the count, when everything arrives', async () => {
    // Freemap's answers are all opaque — ok false, status 0 — which is the
    // only answer a CORS-less host can give, so none of them is a failure.
    await tapDownload();
    expect(toastText()).toBe(`Offline tiles ready (${fetched.length}, 2 layers)`);
  });

  it('names each layer that had trouble, and how much, and still fetches the rest', async () => {
    const firstFreemap = { url: '' };
    answer = (f) => {
      if (f.layer === 'osm') return { ok: false, status: 404 };
      if (!firstFreemap.url) firstFreemap.url = f.url;
      if (f.url === firstFreemap.url) return new TypeError('Failed to fetch');
      return opaqueOrOk(f);
    };
    await tapDownload();
    const freemap = on('freemap').length;
    const osm = on('osm').length;
    expect(freemap).toBe(79);
    expect(toastText()).toBe(`Done — failed: Outdoor (Freemap) (1/${freemap}), OpenStreetMap (${osm}/${osm})`);
  });
});
