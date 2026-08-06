export interface BaseLayerDef {
  id: string;
  name: string;
  url: string;
  attribution: string;
  /** Highest zoom the map allows on this layer (tiles upscale past maxNativeZoom). */
  maxZoom: number;
  /** Highest zoom the tile server actually provides. */
  maxNativeZoom: number;
  /** Lowest zoom the tile server provides (tiles downscale below it). */
  minNativeZoom?: number;
  /** Needs the Thunderforest API key from Settings. */
  needsTfKey?: boolean;
  /** Server offers @2x tiles — much sharper on a phone's high-density screen. */
  retina?: boolean;
  /** Shown under the layer name in the Map panel. */
  blurb?: string;
}

export const BASE_LAYERS: BaseLayerDef[] = [
  {
    id: 'tf-outdoors',
    name: 'Outdoors (Thunderforest)',
    // {r} becomes "@2x" on high-density screens.
    url: 'https://tile.thunderforest.com/outdoors/{z}/{x}/{y}{r}.png?apikey={tfKey}',
    attribution: '&copy; OpenStreetMap contributors | Maps &copy; Thunderforest',
    maxZoom: 20,
    maxNativeZoom: 20,
    needsTfKey: true,
    retina: true,
    blurb: 'Hiking cartography over OpenStreetMap data: trails graded by difficulty, terrain shading, sharp retina tiles. Needs a free key in Settings.'
  },
  {
    id: 'osm',
    name: 'OpenStreetMap',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
    maxNativeZoom: 19,
    blurb: 'The reference rendering, and the only layer that draws individual gates and stiles. No key needed, so it is also the fallback if Outdoors is unavailable.'
  },
  {
    id: 'otm',
    name: 'OpenTopoMap',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors, SRTM | &copy; OpenTopoMap (CC-BY-SA)',
    maxZoom: 19,
    maxNativeZoom: 17,
    blurb: 'Contours and hillshading over OpenStreetMap data. Slower to load and stops at zoom 17, but needs no key.'
  }
];

export const BROUTER_URL = 'https://brouter.de/brouter';

export interface ProfileDef {
  id: string;
  label: string;
  desc: string;
}

export const BROUTER_PROFILES: ProfileDef[] = [
  {
    id: 'hiking-mountain',
    label: 'Mountain hiking',
    desc: 'Prefers proper hiking trails and is happy to use steep, rough or exposed mountain paths. Best for fell and mountain walks.'
  },
  {
    id: 'hiking-beta',
    label: 'General hiking',
    desc: 'Footpaths and easier trails; steers away from technical mountain terrain more than the mountain profile.'
  },
  {
    id: 'trekking',
    label: 'Trekking (bike-style)',
    desc: "BRouter's bicycle-touring profile. Prefers smoother, cycle-friendly ways and avoids steps — a useful fallback when the hiking profiles refuse to connect two points."
  },
  {
    id: 'shortest',
    label: 'Shortest',
    desc: 'The shortest routable way regardless of surface or scenery. Good for comparison, or as a last resort.'
  }
];

/** Distance (m) from the route line beyond which you count as off-route. */
export const OFF_ROUTE_THRESHOLD_M = 50;

/** Zoom levels pre-cached by the offline download. */
export const OFFLINE_ZOOMS = [12, 13, 14, 15, 16];
/** Corridor half-width in tiles around the route at each zoom. */
export const OFFLINE_TILE_BUFFER = 1;
/** Safety cap so a long route cannot trigger an absurd download. */
export const OFFLINE_MAX_TILES = 4000;
