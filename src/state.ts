import type { LatLng } from './geo';
import { DEFAULT_POI_KINDS, poiCategories, type PoiKind } from './poi';

export interface SavedRoute {
  id: string;
  name: string;
  /** Planner waypoints, if the route was made in the planner (allows re-editing). */
  waypoints: LatLng[] | null;
  /** Per-leg snap flags (snaps[i] = leg into waypoint i follows paths). Missing = all snapped. */
  snaps?: boolean[] | null;
  /** Full snapped/imported geometry. */
  coords: LatLng[];
  distanceM: number;
  ascentM: number;
  /** Missing on routes saved before descent tracking existed. */
  descentM?: number;
  /**
   * The place a "Directions to" route leads to, and the mark that says it is
   * one. Absent on every other route. Carries the name rather than a bare flag
   * so the arrival banner can say where you have arrived without the route's
   * own name having to be taken apart.
   */
  detourTo?: string;
  /**
   * The router couldn't be reached, so this is a bearing rather than a path.
   * Worth persisting: a toast is gone in five seconds, and a solid line between
   * two points on a hillside claims a way through that nobody has checked.
   */
  straightLine?: boolean;
  createdAt: number;
}

export interface Settings {
  /** Thunderforest key — the Outdoors base layer. */
  tfKey: string;
  baseLayer: string;
  overlayLayer: string; // '' = none
  overlayOpacity: number;
  profile: string;
  /** Average walking speed on the flat, km/h (Naismith time estimate). */
  speedKmh: number;
  /** UI theme: follow the OS, or force light/dark. */
  theme: 'system' | 'light' | 'dark';
  /** Which categories "What's nearby" searches for. */
  poiKinds: PoiKind[];
  /**
   * Bumped when a default changes in a way an existing install should follow.
   * Absent on anything saved before base layers were reshuffled.
   */
  schema?: number;
}

/** Current settings shape. See `migrate` for what each bump carries. */
const SCHEMA = 1;

/** A saved place the user dropped and named. */
export type PinCategory = 'summit' | 'viewpoint' | 'water' | 'camp' | 'parking' | 'other';

export interface Pin {
  id: string;
  name: string;
  category: PinCategory;
  lat: number;
  lng: number;
  /** Cached elevation in metres; null once fetched and found unavailable. */
  ele?: number | null;
  createdAt: number;
}

const SETTINGS_KEY = 'trailhead.settings';
const ROUTES_KEY = 'trailhead.routes';
const PINS_KEY = 'trailhead.pins';
const ACTIVE_ROUTE_KEY = 'trailhead.activeRoute';

/**
 * Carry an existing install forward when a default changes.
 *
 * v1 makes Freemap the base layer. It only moves installs still sitting on the
 * old default of 'osm': a saved value of anything else is a choice the user made
 * from the Map panel, and stays put. Someone who genuinely picked OpenStreetMap
 * back when it was also the default is indistinguishable from someone who never
 * touched it, so they get moved too — one tap in the Map panel puts it back.
 */
function migrate(s: Settings, saved: unknown): Settings {
  // Read the version off what was *stored*, not off the merged object: the
  // defaults carry the current schema, so the merge would always look current
  // and no migration would ever fire. Storage can also hold `null` or a
  // non-object, which spreads harmlessly but cannot be read from.
  const prev = (saved && typeof saved === 'object' ? saved : {}) as Partial<Settings>;
  if (prev.schema === undefined && prev.baseLayer === 'osm') s.baseLayer = 'freemap';
  s.schema = SCHEMA;
  return s;
}

export function loadSettings(): Settings {
  const defaults: Settings = {
    baseLayer: 'freemap',
    overlayLayer: '',
    overlayOpacity: 0.5,
    profile: 'hiking-beta',
    speedKmh: 4,
    tfKey: '',
    theme: 'system',
    poiKinds: [...DEFAULT_POI_KINDS],
    schema: SCHEMA
  };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
    const s: Settings = { ...defaults, ...saved };
    // Categories can be renamed or dropped between releases, so trust the
    // table over whatever an old install saved.
    s.poiKinds = Array.isArray(s.poiKinds)
      ? poiCategories(s.poiKinds).map((c) => c.id)
      : [...DEFAULT_POI_KINDS];
    return migrate(s, saved);
  } catch {
    return defaults;
  }
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

export function loadRoutes(): SavedRoute[] {
  try {
    return JSON.parse(localStorage.getItem(ROUTES_KEY) ?? '[]');
  } catch {
    return [];
  }
}

export function saveRoutes(routes: SavedRoute[]): void {
  localStorage.setItem(ROUTES_KEY, JSON.stringify(routes));
}

export function loadPins(): Pin[] {
  try {
    const pins = JSON.parse(localStorage.getItem(PINS_KEY) ?? '[]');
    return Array.isArray(pins) ? pins : [];
  } catch {
    return [];
  }
}

export function savePins(pins: Pin[]): void {
  localStorage.setItem(PINS_KEY, JSON.stringify(pins));
}

/** The route being followed, kept so a hike survives an app reload. Stores the
 *  whole route (not just an id) so unsaved or shared routes restore too. */
export function loadActiveRoute(): SavedRoute | null {
  try {
    const r = JSON.parse(localStorage.getItem(ACTIVE_ROUTE_KEY) ?? 'null');
    return r && Array.isArray(r.coords) && r.coords.length >= 2 ? (r as SavedRoute) : null;
  } catch {
    return null;
  }
}

export function saveActiveRoute(r: SavedRoute | null): void {
  if (r) localStorage.setItem(ACTIVE_ROUTE_KEY, JSON.stringify(r));
  else localStorage.removeItem(ACTIVE_ROUTE_KEY);
}
