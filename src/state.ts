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
  osKey: string;
  baseLayer: string;
  overlayLayer: string; // '' = none
  overlayOpacity: number;
  profile: string;
  /** Average walking speed on the flat, km/h (Naismith time estimate). */
  speedKmh: number;
}

const SETTINGS_KEY = 'trailhead.settings';
const ROUTES_KEY = 'trailhead.routes';

export function loadSettings(): Settings {
  const defaults: Settings = {
    osKey: '',
    baseLayer: 'osm',
    overlayLayer: '',
    overlayOpacity: 0.5,
    profile: 'hiking-mountain',
    speedKmh: 4
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
