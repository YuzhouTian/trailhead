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

/** A marker, circle, line or group: where it is, whether it is drawn, what it was given. */
export interface StubLayer {
  readonly kind: 'marker' | 'circle' | 'polyline' | 'group';
  /** Where it sits now — its constructor position, then each setLatLng. */
  latlng: StubLatLng;
  /** Lines: every point they were drawn through. Empty for anything else. */
  readonly coords: StubLatLng[];
  /** Groups: the layers they were made from. Empty for anything else. */
  readonly children: StubLayer[];
  /** Every position it has held, oldest first: the path the app moved it along. */
  readonly track: StubLatLng[];
  /** Circles: radius in metres, from the options or the last setRadius. */
  radius: number | null;
  /** The options object it was constructed with. */
  readonly options: Record<string, unknown>;
  /** True between addTo() and remove() — whether it is on the map right now. */
  onMap: boolean;
  setLatLng(p: StubLatLng): StubLayer;
  setRadius(m: number): StubLayer;
  /** Merged into `options`, as Leaflet merges it into a path's own. */
  setStyle(style: Record<string, unknown>): StubLayer;
  addTo(map: StubMap): StubLayer;
  remove(): StubLayer;
  /** Leaflet's own shape, which is what the app reads off a dragged marker. */
  getLatLng(): { lat: number; lng: number };
  on(type: string, handler: (e: unknown) => void): StubLayer;
  /** Fire one of this layer's own events — how a test drags a waypoint. */
  fire(type: string, payload?: Record<string, unknown>): void;
}

/** One setView call: where the map was told to go, and how. */
export interface StubView {
  center: StubLatLng;
  zoom: number;
  options: Record<string, unknown>;
}

/** The edges of the map on screen, in degrees. */
export interface StubBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface StubMap {
  /**
   * What getZoom() reports. Writable, because "was I zoomed out when the fix
   * landed" is the whole question in some tests.
   */
  zoom: number;
  /** Rotation in degrees, as the last setBearing left it. */
  bearing: number;
  /** What getCenter() reports: where the last setView put it, or a test. */
  center: StubLatLng;
  /** What getBounds() reports. Writable, for "what is on screen" tests. */
  bounds: StubBounds;
  /** Every panBy offset in pixels, oldest first. */
  readonly pans: [number, number][];
  /** Every setView, oldest first — a map that never moved has none. */
  readonly views: StubView[];
  /** Every setBearing, oldest first. */
  readonly bearings: number[];
  /** The layers drawn on it right now. */
  readonly layers: StubLayer[];
  setView(center: StubLatLng, zoom: number, options?: Record<string, unknown>): StubMap;
  getZoom(): number;
  getCenter(): { lat: number; lng: number };
  /** Leaflet's LatLngBounds, as far as its four edge getters. */
  getBounds(): { getSouth(): number; getWest(): number; getNorth(): number; getEast(): number };
  panBy(offset: [number, number], options?: Record<string, unknown>): StubMap;
  /**
   * The element the map is drawn on. Real Leaflet hands out a live <div>, and
   * the app listens on it for the touches Leaflet's own events do not carry —
   * so this is a real element too, and a test starts a gesture by dispatching
   * at it. Replaced by reset(), which is what drops the listeners the last
   * boot left on it.
   */
  getContainer(): HTMLElement;
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
  polyline(coords: StubLatLng[], options?: Record<string, unknown>): StubLayer;
  layerGroup(layers: StubLayer[]): StubLayer;
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

/** Where a fresh map sits, and the screenful around it. Nowhere in particular. */
const DEFAULT_CENTER: StubLatLng = [0, 0];
const DEFAULT_BOUNDS: StubBounds = { south: -0.05, west: -0.05, north: 0.05, east: 0.05 };

export function createLeafletStub(): LeafletStub {
  const created: StubLayer[] = [];
  const icons: Record<string, unknown>[] = [];
  const views: StubView[] = [];
  const bearings: number[] = [];
  const layers: StubLayer[] = [];
  const pans: [number, number][] = [];
  const handlers = new Map<string, ((e: unknown) => void)[]>();
  let container = document.createElement('div');

  const map: StubMap = {
    zoom: DEFAULT_ZOOM,
    bearing: 0,
    center: DEFAULT_CENTER,
    bounds: { ...DEFAULT_BOUNDS },
    views,
    bearings,
    layers,
    pans,
    getContainer: () => container,
    setView(center, zoom, options = {}) {
      views.push({ center, zoom, options });
      map.center = center;
      map.zoom = zoom;
      return map;
    },
    getZoom: () => map.zoom,
    getCenter: () => ({ lat: map.center[0], lng: map.center[1] }),
    getBounds: () => ({
      getSouth: () => map.bounds.south,
      getWest: () => map.bounds.west,
      getNorth: () => map.bounds.north,
      getEast: () => map.bounds.east
    }),
    panBy(offset) {
      pans.push(offset);
      return map;
    },
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

  function layer(
    kind: StubLayer['kind'],
    p: StubLatLng,
    options: Record<string, unknown>,
    coords: StubLatLng[] = [],
    children: StubLayer[] = []
  ): StubLayer {
    // A layer's own subscribers, kept per layer rather than per type on the
    // map: two waypoint markers both listen for 'dragend' and must not hear
    // each other's.
    const own = new Map<string, ((e: unknown) => void)[]>();
    const self: StubLayer = {
      kind,
      latlng: p,
      coords,
      children,
      track: [p],
      radius: typeof options.radius === 'number' ? options.radius : null,
      options,
      onMap: false,
      setLatLng(next) {
        self.latlng = next;
        self.track.push(next);
        return self;
      },
      setRadius(m) {
        self.radius = m;
        return self;
      },
      setStyle(style) {
        Object.assign(self.options, style);
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
      },
      getLatLng: () => ({ lat: self.latlng[0], lng: self.latlng[1] }),
      on(type, handler) {
        own.set(type, [...(own.get(type) ?? []), handler]);
        return self;
      },
      fire(type, payload = {}) {
        for (const h of [...(own.get(type) ?? [])]) h({ type, target: self, ...payload });
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
    circle: (p, options = {}) => layer('circle', p, options),
    // A line has no one position; its first point stands in for one so the
    // shared layer record keeps the same shape.
    polyline: (coords, options = {}) => layer('polyline', coords[0] ?? [0, 0], options, coords),
    // A group is drawn as one layer; what is in it is read off `children`,
    // which stay off `map.layers` themselves, as Leaflet's do from the app's view.
    layerGroup: (children) => layer('group', children[0]?.latlng ?? [0, 0], {}, [], children)
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
      pans.length = 0;
      handlers.clear();
      container = document.createElement('div');
      map.zoom = DEFAULT_ZOOM;
      map.bearing = 0;
      map.center = DEFAULT_CENTER;
      map.bounds = { ...DEFAULT_BOUNDS };
    }
  };
  return stub;
}
