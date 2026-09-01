// A Leaflet that draws nothing and writes everything down.
//
// Every feature that touches the map reaches it the same way: `import L from
// '../leaflet-setup'` for the constructors, `import { map } from '../map/map'`
// for the one map instance. Neither survives a test. leaflet-setup loads a
// rotation plugin that patches a global and a stylesheet; map/map builds a real
// map against a real <div> the moment it is imported. So both get replaced, by
// this.
//
// The point is not to emulate Leaflet — it is to make what a module *asked for*
// visible, so a test can say "the dot moved here" and "the map did not
// recentre" with nothing rendered and no hill involved. Every method records
// and hands back its object, so the chaining the app relies on
// (`L.circle(…).addTo(map)`, `circle.setLatLng(p).setRadius(r)`) works
// unchanged.
//
// It covers what the modules actually call and no more. Adding a method as a
// module needs it is the intended way to grow this; inventing the rest of
// Leaflet up front would only be guessing at the shape of tests not yet
// written.

/** Positions go in and come out as the app writes them: [lat, lng]. */
export type StubLatLng = [number, number];

/** A marker or a circle: where it is, whether it is drawn, what it was given. */
export interface StubLayer {
  readonly kind: 'marker' | 'circle';
  /** Where it sits now — its constructor position, then each setLatLng. */
  latlng: StubLatLng;
  /** Every position it has held, oldest first: the path the app moved it along. */
  readonly track: StubLatLng[];
  /** Circles: radius in metres, from the options or the last setRadius. */
  radius: number | null;
  /** The options object it was constructed with. */
  readonly options: Record<string, unknown>;
  /** True between addTo() and remove() — whether it is on the map right now. */
  onMap: boolean;
  /**
   * What bindPopup was handed. Call it to read what the popup would say — the
   * app builds its popups lazily on open, so this is the only way to see the
   * text without opening one.
   */
  popup: (() => string) | null;
  setLatLng(p: StubLatLng): StubLayer;
  setRadius(m: number): StubLayer;
  bindPopup(content: (() => string) | string): StubLayer;
  addTo(map: StubMap): StubLayer;
  remove(): StubLayer;
}

/** One setView call: where the map was told to go, and how. */
export interface StubView {
  center: StubLatLng;
  zoom: number;
  options: Record<string, unknown>;
}

export interface StubMap {
  /**
   * What getZoom() reports. Writable, because "was I zoomed out when the fix
   * landed" is the whole question in some tests.
   */
  zoom: number;
  /** Rotation in degrees, as the last setBearing left it. */
  bearing: number;
  /** Every setView, oldest first — a map that never moved has none. */
  readonly views: StubView[];
  /** Every setBearing, oldest first. */
  readonly bearings: number[];
  /** The layers drawn on it right now. */
  readonly layers: StubLayer[];
  setView(center: StubLatLng, zoom: number, options?: Record<string, unknown>): StubMap;
  getZoom(): number;
  setBearing(deg: number): StubMap;
  on(type: string, handler: (e: unknown) => void): StubMap;
  off(type: string, handler: (e: unknown) => void): StubMap;
  /**
   * Fire an event the app subscribed to — a drag, a zoom, a click. This is how
   * a test does the thing a thumb would do.
   */
  fire(type: string, payload?: Record<string, unknown>): void;
}

/** Leaflet's constructors, as much of them as anything here calls. */
export interface StubL {
  divIcon(options?: Record<string, unknown>): Record<string, unknown>;
  marker(p: StubLatLng, options?: Record<string, unknown>): StubLayer;
  circle(p: StubLatLng, options?: Record<string, unknown>): StubLayer;
}

export interface LeafletStub {
  /** Stands in for leaflet-setup's default export. */
  L: StubL;
  /** Stands in for map/map's `map`. */
  map: StubMap;
  /** Every layer ever built, still drawn or not — how you catch a redraw. */
  created: StubLayer[];
  /** Every divIcon built, in order. */
  icons: Record<string, unknown>[];
  /**
   * Forget everything recorded and drop every subscriber, keeping the same
   * objects. For tests that reset the module registry between cases: the app's
   * modules come back fresh, and this puts the map they will find back to how
   * it looked before anyone touched it.
   */
  reset(): void;
}

/** The zoom a fresh map sits at — deliberately below the 15 that following
    a fix zooms in to, so a test that wants "already close enough" has to say so. */
const DEFAULT_ZOOM = 13;

export function createLeafletStub(): LeafletStub {
  const created: StubLayer[] = [];
  const icons: Record<string, unknown>[] = [];
  const views: StubView[] = [];
  const bearings: number[] = [];
  const layers: StubLayer[] = [];
  const handlers = new Map<string, ((e: unknown) => void)[]>();

  const map: StubMap = {
    zoom: DEFAULT_ZOOM,
    bearing: 0,
    views,
    bearings,
    layers,
    setView(center, zoom, options = {}) {
      views.push({ center, zoom, options });
      map.zoom = zoom;
      return map;
    },
    getZoom: () => map.zoom,
    setBearing(deg) {
      bearings.push(deg);
      map.bearing = deg;
      return map;
    },
    on(type, handler) {
      handlers.set(type, [...(handlers.get(type) ?? []), handler]);
      return map;
    },
    off(type, handler) {
      handlers.set(type, (handlers.get(type) ?? []).filter((h) => h !== handler));
      return map;
    },
    fire(type, payload = {}) {
      // Copied before iterating: a handler is allowed to unsubscribe itself,
      // which is exactly what a pause-on-drag handler might one day do.
      for (const h of [...(handlers.get(type) ?? [])]) h({ type, ...payload });
    }
  };

  function layer(kind: 'marker' | 'circle', p: StubLatLng, options: Record<string, unknown>): StubLayer {
    const self: StubLayer = {
      kind,
      latlng: p,
      track: [p],
      radius: typeof options.radius === 'number' ? options.radius : null,
      options,
      onMap: false,
      popup: null,
      setLatLng(next) {
        self.latlng = next;
        self.track.push(next);
        return self;
      },
      setRadius(m) {
        self.radius = m;
        return self;
      },
      bindPopup(content) {
        self.popup = typeof content === 'function' ? content : () => content;
        return self;
      },
      addTo() {
        if (!self.onMap) layers.push(self);
        self.onMap = true;
        return self;
      },
      remove() {
        const i = layers.indexOf(self);
        if (i >= 0) layers.splice(i, 1);
        self.onMap = false;
        return self;
      }
    };
    created.push(self);
    return self;
  }

  const L: StubL = {
    divIcon(options = {}) {
      icons.push(options);
      return options;
    },
    marker: (p, options = {}) => layer('marker', p, options),
    circle: (p, options = {}) => layer('circle', p, options)
  };

  const stub: LeafletStub = {
    L,
    map,
    created,
    icons,
    reset() {
      created.length = 0;
      icons.length = 0;
      views.length = 0;
      bearings.length = 0;
      layers.length = 0;
      handlers.clear();
      map.zoom = DEFAULT_ZOOM;
      map.bearing = 0;
    }
  };
  return stub;
}
