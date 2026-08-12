import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_POI_KINDS, POI_CATEGORIES } from './poi';
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
  type SavedRoute
} from './state';

/**
 * A localStorage that is a Map. The real one is a browser global, but state.ts
 * only uses three of its methods, so this is cheaper and more controllable than
 * pulling jsdom in — and it lets a test write deliberate rubbish into a key.
 */
const store = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear()
  },
  configurable: true
});

const SETTINGS_KEY = 'trailhead.settings';
const ROUTES_KEY = 'trailhead.routes';
const PINS_KEY = 'trailhead.pins';
const ACTIVE_ROUTE_KEY = 'trailhead.activeRoute';

beforeEach(() => store.clear());

const route = (over: Partial<SavedRoute> = {}): SavedRoute => ({
  id: '1',
  name: 'Scafell Pike',
  waypoints: null,
  coords: [
    [54.4271, -3.2472],
    [54.4542, -3.2116]
  ],
  distanceM: 4200,
  ascentM: 900,
  descentM: 900,
  createdAt: 0,
  ...over
});

describe('loadSettings', () => {
  it('gives a fresh install its defaults', () => {
    const s = loadSettings();
    expect(s.baseLayer).toBe('osm');
    expect(s.overlayLayer).toBe('');
    expect(s.overlayOpacity).toBe(0.5);
    expect(s.profile).toBe('hiking-mountain');
    expect(s.speedKmh).toBe(4);
    expect(s.tfKey).toBe('');
    expect(s.theme).toBe('system');
    expect(s.poiKinds).toEqual(DEFAULT_POI_KINDS);
  });

  it('does not hand out the same array the defaults are built from', () => {
    // A shared array would let one caller's edit leak into the next load.
    const a = loadSettings();
    const b = loadSettings();
    a.poiKinds.push('trig');
    expect(b.poiKinds).toEqual(DEFAULT_POI_KINDS);
  });

  it('lets a saved value override a default', () => {
    store.set(SETTINGS_KEY, JSON.stringify({ speedKmh: 5.5, theme: 'dark' }));
    const s = loadSettings();
    expect(s.speedKmh).toBe(5.5);
    expect(s.theme).toBe('dark');
    // Keys the old install never wrote still get their defaults.
    expect(s.profile).toBe('hiking-mountain');
  });

  it('round trips through saveSettings', () => {
    const s = loadSettings();
    s.speedKmh = 3.2;
    s.poiKinds = ['summit', 'shelter'];
    saveSettings(s);
    expect(loadSettings()).toEqual(s);
  });

  it('falls back to defaults on corrupt JSON rather than throwing', () => {
    // Storage can be truncated by a full quota or a killed tab; a hiker on a
    // hill wants the app to open, not to explain itself.
    store.set(SETTINGS_KEY, '{"speedKmh": 5, ');
    expect(() => loadSettings()).not.toThrow();
    expect(loadSettings().speedKmh).toBe(4);
  });

  it('falls back to defaults on JSON that is not an object', () => {
    store.set(SETTINGS_KEY, 'null');
    expect(loadSettings().speedKmh).toBe(4);
  });

  describe('poiKinds migration', () => {
    it('drops categories that no longer exist', () => {
      store.set(SETTINGS_KEY, JSON.stringify({ poiKinds: ['summit', 'dragons', 'water'] }));
      expect(loadSettings().poiKinds).toEqual(['summit', 'water']);
    });

    it('returns them in table order, not the order they were saved in', () => {
      // The tick list in Settings is rendered from this array, and it should
      // read the same on every install.
      const tableOrder = POI_CATEGORIES.map((c) => c.id);
      const saved = ['transport', 'summit', 'toilets', 'trig'];
      store.set(SETTINGS_KEY, JSON.stringify({ poiKinds: saved }));
      const got = loadSettings().poiKinds;
      expect([...got].sort()).toEqual([...saved].sort());
      expect(got).toEqual(tableOrder.filter((id) => saved.includes(id)));
    });

    it('keeps an empty choice empty rather than resurrecting the defaults', () => {
      // Ticking nothing is a legitimate choice: it turns "What's nearby" off.
      store.set(SETTINGS_KEY, JSON.stringify({ poiKinds: [] }));
      expect(loadSettings().poiKinds).toEqual([]);
    });

    it('falls back to the defaults when the saved value is not a list', () => {
      store.set(SETTINGS_KEY, JSON.stringify({ poiKinds: 'summit' }));
      expect(loadSettings().poiKinds).toEqual(DEFAULT_POI_KINDS);
    });

    it('accepts every id in the table', () => {
      const all = POI_CATEGORIES.map((c) => c.id);
      store.set(SETTINGS_KEY, JSON.stringify({ poiKinds: all }));
      expect(loadSettings().poiKinds).toEqual(all);
    });
  });
});

describe('loadRoutes', () => {
  it('is empty on a fresh install', () => {
    expect(loadRoutes()).toEqual([]);
  });

  it('round trips through saveRoutes', () => {
    const routes = [route(), route({ id: '2', name: 'Great Gable' })];
    saveRoutes(routes);
    expect(loadRoutes()).toEqual(routes);
  });

  it('is empty on corrupt JSON rather than throwing', () => {
    store.set(ROUTES_KEY, '[{"id":"1"');
    expect(() => loadRoutes()).not.toThrow();
    expect(loadRoutes()).toEqual([]);
  });
});

describe('loadPins', () => {
  const pin: Pin = {
    id: '1',
    name: 'Car park',
    category: 'parking',
    lat: 54.4271,
    lng: -3.2472,
    createdAt: 0
  };

  it('is empty on a fresh install', () => {
    expect(loadPins()).toEqual([]);
  });

  it('round trips through savePins', () => {
    savePins([pin]);
    expect(loadPins()).toEqual([pin]);
  });

  it('is empty on corrupt JSON rather than throwing', () => {
    store.set(PINS_KEY, 'not json at all');
    expect(() => loadPins()).not.toThrow();
    expect(loadPins()).toEqual([]);
  });

  it('is empty when the stored value is valid JSON but not a list', () => {
    store.set(PINS_KEY, '{"id":"1"}');
    expect(loadPins()).toEqual([]);
  });
});

describe('loadActiveRoute', () => {
  it('is null when nothing is being followed', () => {
    expect(loadActiveRoute()).toBeNull();
  });

  it('round trips through saveActiveRoute', () => {
    const r = route();
    saveActiveRoute(r);
    expect(loadActiveRoute()).toEqual(r);
  });

  it('clears the key when given null', () => {
    saveActiveRoute(route());
    saveActiveRoute(null);
    expect(store.has(ACTIVE_ROUTE_KEY)).toBe(false);
    expect(loadActiveRoute()).toBeNull();
  });

  it('rejects a route with fewer than two coordinates', () => {
    // One point is not a line: the follow logic projects onto segments, and
    // there are none. Better to start with no active route than to crash.
    store.set(ACTIVE_ROUTE_KEY, JSON.stringify(route({ coords: [[54.4271, -3.2472]] })));
    expect(loadActiveRoute()).toBeNull();

    store.set(ACTIVE_ROUTE_KEY, JSON.stringify(route({ coords: [] })));
    expect(loadActiveRoute()).toBeNull();
  });

  it('rejects a route whose coords are not a list', () => {
    store.set(ACTIVE_ROUTE_KEY, JSON.stringify({ ...route(), coords: 'nope' }));
    expect(loadActiveRoute()).toBeNull();
  });

  it('rejects a stored null', () => {
    store.set(ACTIVE_ROUTE_KEY, 'null');
    expect(loadActiveRoute()).toBeNull();
  });

  it('is null on corrupt JSON rather than throwing', () => {
    store.set(ACTIVE_ROUTE_KEY, '{"coords": [[54.4');
    expect(() => loadActiveRoute()).not.toThrow();
    expect(loadActiveRoute()).toBeNull();
  });

  it('keeps a route that predates descent tracking', () => {
    // Routes saved before descentM existed must still be followable.
    const old = route();
    delete (old as Partial<SavedRoute>).descentM;
    saveActiveRoute(old);
    expect(loadActiveRoute()).toEqual(old);
    expect(loadActiveRoute()!.descentM).toBeUndefined();
  });
});
