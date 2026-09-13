import { beforeEach, describe, expect, it } from 'vitest';
import {
  loadActiveRoute,
  loadLastView,
  loadPins,
  loadRoutes,
  loadSettings,
  saveActiveRoute,
  saveLastView,
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
const LAST_VIEW_KEY = 'trailhead.lastView';

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
    expect(s.baseLayer).toBe('freemap');
    expect(s.overlayLayer).toBe('');
    expect(s.overlayOpacity).toBe(0.5);
    expect(s.profile).toBe('hiking-beta');
    expect(s.speedKmh).toBe(4);
    expect(s.tfKey).toBe('');
    expect(s.theme).toBe('system');
  });

  it('lets a saved value override a default', () => {
    store.set(SETTINGS_KEY, JSON.stringify({ speedKmh: 5.5, theme: 'dark' }));
    const s = loadSettings();
    expect(s.speedKmh).toBe(5.5);
    expect(s.theme).toBe('dark');
    // Keys the old install never wrote still get their defaults.
    expect(s.profile).toBe('hiking-beta');
  });

  describe('base layer migration', () => {
    it('moves an install still on the old default over to Freemap', () => {
      store.set(SETTINGS_KEY, JSON.stringify({ baseLayer: 'osm', speedKmh: 5 }));
      const s = loadSettings();
      expect(s.baseLayer).toBe('freemap');
      // Everything else the old install saved survives the move.
      expect(s.speedKmh).toBe(5);
    });

    it('leaves a layer the user actually chose alone', () => {
      store.set(SETTINGS_KEY, JSON.stringify({ baseLayer: 'tf-outdoors' }));
      expect(loadSettings().baseLayer).toBe('tf-outdoors');
    });

    it('does not run twice — picking OSM after the move sticks', () => {
      store.set(SETTINGS_KEY, JSON.stringify({ baseLayer: 'osm', schema: 1 }));
      expect(loadSettings().baseLayer).toBe('osm');
    });
  });

  it('round trips through saveSettings', () => {
    const s = loadSettings();
    s.speedKmh = 3.2;
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

  it('forgets the nearby tick list an older install saved', () => {
    // Categories are chosen fresh in the Map sheet now; nothing is on at start.
    store.set(SETTINGS_KEY, JSON.stringify({ speedKmh: 5, poiKinds: ['summit', 'water'] }));
    const s = loadSettings();
    expect(s.speedKmh).toBe(5);
    expect(s).not.toHaveProperty('poiKinds');
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

describe('loadLastView', () => {
  it('is null on a first run, so the map falls back to the UK view', () => {
    expect(loadLastView()).toBeNull();
  });

  it('round trips through saveLastView', () => {
    saveLastView({ center: [54.4271, -3.2472], zoom: 15 });
    expect(loadLastView()).toEqual({ center: [54.4271, -3.2472], zoom: 15 });
  });

  it('stores nothing but the centre and the zoom', () => {
    saveLastView({ center: [54.4271, -3.2472], zoom: 15 } as never);
    expect(Object.keys(JSON.parse(store.get(LAST_VIEW_KEY)!)).sort()).toEqual(['center', 'zoom']);
  });

  it('rejects a centre that is not two finite numbers', () => {
    // A half-written or hand-edited key must not hand Leaflet a NaN: a wrong
    // map is recoverable, a broken one is not.
    for (const center of [null, 'nope', [], [54.4], [54.4, -3.2, 9], ['54.4', '-3.2'], [54.4, null]]) {
      store.set(LAST_VIEW_KEY, JSON.stringify({ center, zoom: 15 }));
      expect(loadLastView()).toBeNull();
    }
    store.set(LAST_VIEW_KEY, '{"center":[null,null],"zoom":15}');
    expect(loadLastView()).toBeNull();
  });

  it('rejects a centre off the globe', () => {
    store.set(LAST_VIEW_KEY, JSON.stringify({ center: [954.4, -3.2], zoom: 15 }));
    expect(loadLastView()).toBeNull();
    store.set(LAST_VIEW_KEY, JSON.stringify({ center: [54.4, -300], zoom: 15 }));
    expect(loadLastView()).toBeNull();
  });

  it('rejects a zoom outside the range the layers serve', () => {
    for (const zoom of [1, 0, -3, 21, 99, 'twelve', null, undefined]) {
      store.set(LAST_VIEW_KEY, JSON.stringify({ center: [54.4271, -3.2472], zoom }));
      expect(loadLastView()).toBeNull();
    }
  });

  it('keeps the ends of the usable zoom range', () => {
    for (const zoom of [2, 20]) {
      saveLastView({ center: [54.4271, -3.2472], zoom });
      expect(loadLastView()!.zoom).toBe(zoom);
    }
  });

  it('is null on garbage rather than throwing', () => {
    for (const junk of ['null', 'nonsense', '{"center":[54.4,', '[]', '42', '"a string"']) {
      store.set(LAST_VIEW_KEY, junk);
      expect(() => loadLastView()).not.toThrow();
      expect(loadLastView()).toBeNull();
    }
  });
});
