import type { LatLng } from './geo';

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
  createdAt: number;
}

export interface Settings {
  /** Thunderforest key — the Outdoors base layer. */
  tfKey: string;
  /** Ordnance Survey key — place-name search only; no longer used for map tiles. */
  osKey: string;
  baseLayer: string;
  overlayLayer: string; // '' = none
  overlayOpacity: number;
  profile: string;
  /** Average walking speed on the flat, km/h (Naismith time estimate). */
  speedKmh: number;
  /** UI theme: follow the OS, or force light/dark. */
  theme: 'system' | 'light' | 'dark';
}

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

export function loadSettings(): Settings {
  const defaults: Settings = {
    osKey: '',
    baseLayer: 'osm',
    overlayLayer: '',
    overlayOpacity: 0.5,
    profile: 'hiking-mountain',
    speedKmh: 4,
    tfKey: '',
    theme: 'system'
  };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
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
