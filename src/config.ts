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
  needsOsKey?: boolean;
}

export const BASE_LAYERS: BaseLayerDef[] = [
  {
    id: 'osm',
    name: 'OpenStreetMap',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
    maxNativeZoom: 19
  },
  {
    id: 'otm',
    name: 'OpenTopoMap',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors, SRTM | &copy; OpenTopoMap (CC-BY-SA)',
    maxZoom: 19,
    maxNativeZoom: 17
  },
  {
    id: 'os-outdoor',
    name: 'OS Outdoor (Ordnance Survey)',
    url: 'https://api.os.uk/maps/raster/v1/zxy/Outdoor_3857/{z}/{x}/{y}.png?key={osKey}',
    attribution: 'Contains OS data &copy; Crown copyright',
    maxZoom: 19,
    maxNativeZoom: 16,
    minNativeZoom: 7,
    needsOsKey: true
  },
  {
    id: 'os-light',
    name: 'OS Light (Ordnance Survey)',
    url: 'https://api.os.uk/maps/raster/v1/zxy/Light_3857/{z}/{x}/{y}.png?key={osKey}',
    attribution: 'Contains OS data &copy; Crown copyright',
    maxZoom: 19,
    maxNativeZoom: 16,
    minNativeZoom: 7,
    needsOsKey: true
  }
];

export const BROUTER_URL = 'https://brouter.de/brouter';
export const BROUTER_PROFILES = ['hiking-mountain', 'hiking-beta', 'trekking', 'shortest'];

/** Distance (m) from the route line beyond which you count as off-route. */
export const OFF_ROUTE_THRESHOLD_M = 50;

/** Zoom levels pre-cached by the offline download. */
export const OFFLINE_ZOOMS = [12, 13, 14, 15, 16];
/** Corridor half-width in tiles around the route at each zoom. */
export const OFFLINE_TILE_BUFFER = 1;
/** Safety cap so a long route cannot trigger an absurd download. */
export const OFFLINE_MAX_TILES = 4000;
