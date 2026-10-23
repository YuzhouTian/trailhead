export interface BaseLayerDef {
  id: string;
  name: string;
  url: string;
  /** Highest zoom the map allows on this layer (tiles upscale past maxNativeZoom). */
  maxZoom: number;
  /** Highest zoom the tile server actually provides. */
  maxNativeZoom: number;
  /** Lowest zoom the tile server provides (tiles downscale below it). */
  minNativeZoom?: number;
  /** Needs an API key from Settings: Thunderforest's or the OS Data Hub's. */
  needsKey?: LayerKey;
  /**
   * Which grid the tiles are cut on. 'osgb' is the British National Grid
   * (src/map/osgrid.ts): picking such a layer switches the whole map onto it.
   * Default 'web', the standard Web Mercator grid every other layer uses.
   */
  grid?: 'web' | 'osgb';
  /** Added to the map's zoom to get the zoom in the tile URL. */
  zoomOffset?: number;
  /** Lowest zoom the map allows on this layer. */
  minZoom?: number;
  /** Server offers @2x tiles — much sharper on a phone's high-density screen. */
  retina?: boolean;
  /**
   * For a layer with no @2x tiles: URL levels that a high-density screen draws
   * from four tiles of the next level in, at half size. The same map with twice
   * the pixels each way, so only levels that share their map with the next one.
   * See map/sharptiles.ts.
   */
  sharpLevels?: number[];
  /**
   * Whether the server sends `Access-Control-Allow-Origin`. Default true.
   *
   * Set false and tiles are requested without `crossOrigin`, because a browser
   * refuses an image fetched with `crossOrigin="anonymous"` from a host that
   * sends no CORS header — even on a 200 with a perfectly good tile in the body.
   * The cost is that the response becomes opaque: neither the offline download
   * nor the service worker can read its status. See both for what they do
   * instead.
   */
  cors?: boolean;
  /** Shown under the layer name in the Map panel. */
  blurb?: string;
}

/** The API keys a layer can need, each a field in Settings. */
export type LayerKey = 'tf' | 'os';

export const BASE_LAYERS: BaseLayerDef[] = [
  {
    id: 'freemap',
    name: 'Outdoor (Freemap)',
    // No extension and no subdomain; {r} becomes "@2x", which this server
    // renders natively rather than upscaling.
    url: 'https://outdoor.tiles.freemap.sk/{z}/{x}/{y}{r}',
    maxZoom: 20,
    maxNativeZoom: 20,
    retina: true,
    // Serves tiles happily but sends no Access-Control-Allow-Origin.
    cors: false,
    blurb: 'Contours, hillshading and crag ticks over OpenStreetMap data, with waymarked routes named along the line. The sharpest layer here — its own tiles all the way to z20, at true retina resolution. Covers Europe only.'
  },
  {
    id: 'os-leisure',
    name: 'OS Explorer (1:25k)',
    url: 'https://api.os.uk/maps/raster/v1/zxy/Leisure_27700/{z}/{x}/{y}.png?key={osKey}',
    // OS serves this style on the British National Grid only, so picking it
    // moves the whole map onto that grid: see map/osgrid.ts.
    grid: 'osgb',
    // App zoom 7–16 is OS level 0–9: 1:50k at 12–13, the 1:25k map at 14–16.
    // Same scale as Freemap at the same zoom, so switching never jumps.
    zoomOffset: -7,
    minZoom: 7,
    minNativeZoom: 7,
    maxNativeZoom: 16,
    maxZoom: 18,
    // On a phone, every zoom whose next level in is the same map: MiniScale at
    // 8, the 1:250k at 10, the 1:50k at 12 and the 1:25k at 14–15. Zooms 7, 9,
    // 11 and 13 sit at a change of map. Levels 0–5 are open data; drawing zoom
    // 12 from level 6 turns each free tile into four Premium ones.
    sharpLevels: [1, 3, 5, 7, 8],
    needsKey: 'os',
    blurb: 'The Ordnance Survey Explorer map: 1:25,000 from close in, with rights of way and access land. Great Britain only: leave it and the map switches to Freemap. Needs an OS Data Hub key in Settings, and the Premium plan for the 1:25k zooms.'
  },
  {
    id: 'tf-outdoors',
    name: 'Outdoors (Thunderforest)',
    // {r} becomes "@2x" on high-density screens.
    url: 'https://tile.thunderforest.com/outdoors/{z}/{x}/{y}{r}.png?apikey={tfKey}',
    maxZoom: 20,
    maxNativeZoom: 20,
    needsKey: 'tf',
    retina: true,
    blurb: 'Hiking cartography over OpenStreetMap data: trails graded by difficulty, terrain shading, sharp retina tiles. Needs a free key in Settings.'
  },
  {
    id: 'osm',
    name: 'OpenStreetMap',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    maxZoom: 19,
    maxNativeZoom: 19,
    blurb: 'The reference rendering. No key, global coverage and the sturdiest servers, which is why it is the fallback.'
  }
];

/** The key `def` needs, if any, read from Settings ('' when it has none). */
export function keyFor(def: BaseLayerDef, keys: { tfKey: string; osKey: string }): string | null {
  if (def.needsKey === 'tf') return keys.tfKey;
  if (def.needsKey === 'os') return keys.osKey;
  return null;
}

/** True when `def` needs a key and Settings does not have it. */
export function missingKey(def: BaseLayerDef, keys: { tfKey: string; osKey: string }): boolean {
  return keyFor(def, keys) === '';
}

/**
 * What to give an `<img>` as its `crossOrigin` for this layer, or undefined to
 * leave the attribute off entirely.
 *
 * Lives here beside the definitions, and pure, because the rule is easy to get
 * backwards and expensive when you do: asking a CORS-less host for a CORS image
 * makes the browser throw away a perfectly good tile, and the layer looks dead
 * rather than broken. map.ts cannot be imported in a test — it builds a real
 * Leaflet map the moment it loads — so this is where the rule can be pinned.
 */
export function crossOriginFor(def: BaseLayerDef): 'anonymous' | undefined {
  return def.cors === false ? undefined : 'anonymous';
}

/**
 * The layer to fall back to when the chosen one cannot be used — a missing key,
 * a retired id, tiles that will not load. Named rather than "the first keyless
 * layer" because the default is now Freemap, and the point of a fallback is to
 * be the *dependable* one: OpenStreetMap is global (Freemap is Europe-only) and
 * runs on the most robust servers of the four.
 */
export const FALLBACK_LAYER_ID = 'osm';

/**
 * Where a GB-only layer (OS Explorer) hands over when the map leaves Great
 * Britain. Not the fallback: OS is chosen for the hills, and Freemap is the
 * hill map that carries on past the border. The map stays on it until OS is
 * picked again, rather than flipping back on the way home.
 */
export const OUTSIDE_GB_LAYER_ID = 'freemap';

export const BROUTER_URL = 'https://brouter.de/brouter';

export interface ProfileDef {
  id: string;
  label: string;
}

/**
 * The first is the default for a fresh install, and what a stored or shared id
 * that is no longer on this list falls back to (see knownProfile).
 *
 * BRouter's Trekking and Shortest profiles were offered here too and are gone:
 * one is a bicycle profile and the other ignores the ground altogether, and
 * Plan's Straight option is the honest version of "just get me across".
 *
 * Named for the one thing that tells them apart. Tested over Striding Edge and
 * Crib Goch, both pick the same line wherever the climb can't be avoided, and
 * both judge a path by its OpenStreetMap difficulty grade: each goes round Crib
 * Goch (graded alpine) and each takes Striding Edge (graded as a mountain path).
 * Where they part is a climb that can be walked round — "Save my legs" goes
 * through Grisedale Hause, Standard goes over the 810 m top — so that is what
 * the names say, rather than "General" and "Mountain", which suggested a
 * difference in terrain that isn't there.
 */
export const BROUTER_PROFILES: ProfileDef[] = [
  {
    id: 'hiking-beta',
    label: 'Standard'
  },
  {
    // Not BRouter's hiking-mountain but our copy of it that counts the climb
    // (src/profiles/mountain-hiking.brf, uploaded by src/routing.ts). It keeps
    // the stock id so installs and share links that already say
    // hiking-mountain get the fixed version, with nothing to migrate.
    id: 'hiking-mountain',
    label: 'Save my legs'
  }
];

/** `id` if it is still a profile the app offers, otherwise the default. */
export function knownProfile(id: string | undefined | null): string {
  return BROUTER_PROFILES.find((p) => p.id === id)?.id ?? BROUTER_PROFILES[0].id;
}

export interface RouteColourDef {
  colour: string;
  label: string;
}

/**
 * The colours a route line can be drawn in, picked in Settings. One colour for
 * both the plan being sketched and a route loaded to walk: every base map has
 * its own lines in red or blue somewhere, so whichever clashes least depends on
 * the layer and the ground, and only the walker looking at it can tell.
 * The first is the default — the red loaded routes have always been.
 */
export const ROUTE_COLOURS: RouteColourDef[] = [
  { colour: '#d8303c', label: 'Red' },
  { colour: '#1a73e8', label: 'Blue' },
  { colour: '#d6249f', label: 'Magenta' },
  { colour: '#f57c00', label: 'Orange' },
  { colour: '#7b1fa2', label: 'Purple' },
  { colour: '#1a1a1a', label: 'Black' }
];

/** A colour off the list, or the default for anything that is not on it. */
export function knownRouteColour(colour: string | undefined | null): string {
  return ROUTE_COLOURS.find((c) => c.colour === colour)?.colour ?? ROUTE_COLOURS[0].colour;
}

/** Distance (m) from the route line beyond which you count as off-route. */
export const OFF_ROUTE_THRESHOLD_M = 50;

/**
 * Distance (m) from the route line beyond which we stop believing the
 * projection describes progress at all. Off-route means "you have wandered
 * from the line"; past this you are simply not at this route — and the nearest
 * point of a loop can then be anywhere on it, which is how a Coombe Hill route
 * opened from Ealing reported 85% done. Set well clear of
 * OFF_ROUTE_THRESHOLD_M so a poor fix or a parallel path still counts as being
 * on the walk.
 */
export const EN_ROUTE_THRESHOLD_M = 300;

/**
 * Distance (m) from a detour's destination at which you have arrived. Asked of
 * the destination itself rather than of the route's end, because standing at
 * the place you asked for you can easily be a few metres past where the router
 * chose to stop. Well inside OFF_ROUTE_THRESHOLD_M, which is far too loose to
 * mean "I am there".
 */
export const ARRIVAL_M = 30;

/**
 * How long (ms) after opening the app a newly found deploy may reload it
 * without asking, provided the screen has not been touched. Long enough to
 * cover downloading the new build on weak signal; after it, or after a touch,
 * an "Update ready" button appears instead.
 */
export const UPDATE_AUTO_RELOAD_MS = 10_000;

/**
 * Zoom levels pre-cached by the offline download, each with the corridor's
 * half-width in tiles either side of the route at that zoom.
 *
 * 17 and 18 are there so you can zoom right in on a junction with no signal
 * and still have map: past the last cached zoom a layer goes blank rather than
 * stretching what it has. They are narrower on the ground than the rest —
 * about 200 m either side, against 400 m or more further out — because each
 * zoom in costs twice the tiles along the line; widening them as well would
 * make them the bulk of every download. Zoom 18 already shows every path.
 */
export const OFFLINE_ZOOMS: { zoom: number; buffer: number }[] = [
  { zoom: 12, buffer: 1 },
  { zoom: 13, buffer: 1 },
  { zoom: 14, buffer: 1 },
  { zoom: 15, buffer: 1 },
  { zoom: 16, buffer: 1 },
  { zoom: 17, buffer: 1 },
  { zoom: 18, buffer: 2 }
];
/** Safety cap so a long route cannot trigger an absurd download. */
export const OFFLINE_MAX_TILES = 4000;
