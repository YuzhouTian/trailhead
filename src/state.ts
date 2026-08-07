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
}

/** A remembered map position, so a returning visitor reopens where they left off. */
export interface MapView {
  center: LatLng;
  zoom: number;
}

const SETTINGS_KEY = 'trailhead.settings';
const ROUTES_KEY = 'trailhead.routes';
const LAST_VIEW_KEY = 'trailhead.lastView';

export function loadSettings(): Settings {
  const defaults: Settings = {
    osKey: '',
    baseLayer: 'osm',
    overlayLayer: '',
    overlayOpacity: 0.5,
    profile: 'hiking-mountain',
    speedKmh: 4,
    tfKey: ''
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

/** The map position from last time, or null on a first-ever load / bad data. */
export function loadLastView(): MapView | null {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_VIEW_KEY) ?? 'null');
    if (
      v &&
      Array.isArray(v.center) &&
      v.center.length === 2 &&
      Number.isFinite(v.center[0]) &&
      Number.isFinite(v.center[1]) &&
      Number.isFinite(v.zoom)
    ) {
      return v as MapView;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveLastView(center: LatLng, zoom: number): void {
  localStorage.setItem(LAST_VIEW_KEY, JSON.stringify({ center, zoom }));
}
