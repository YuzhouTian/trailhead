import type { LatLng } from './geo';
import { queryOverpass } from './overpass';

/**
 * Nearby points of interest from OpenStreetMap via Overpass.
 *
 * Every category lives in one table below: it drives the Overpass query, the
 * map markers, the map key and the chips in the Map sheet. Adding a category
 * means adding a row, not touching four files.
 *
 * The list is deliberately short — the things a walker actually goes looking
 * for — and each id matches a saved-pin category, so a point found here and a
 * pin you saved there share a name and a glyph.
 */

/** One OSM tag a feature must carry to fall into a category. */
type TagMatch = readonly [key: string, value: string];

/** The shape of a row in the table below; `PoiCategory` is what you get out. */
interface PoiCategoryShape {
  readonly id: string;
  /** Singular — the map key, and the name of an unnamed feature. */
  readonly label: string;
  /** Plural and short — the chip in the Map sheet, and the toasts. */
  readonly plural: string;
  /** Id of a `<symbol>` in index.html's sprite — the saved-pin glyph of the
   *  same name, so the marker, the map key and the chip all draw it. */
  readonly icon: string;
  /** Marker ring colour. Map symbology, so a fixed colour rather than a theme token. */
  readonly colour: string;
  readonly tags: readonly TagMatch[];
  /** Search ways and relations too — for things usually mapped as an area. */
  readonly areas: boolean;
  /** This category's `out` limit. */
  readonly quota: number;
}

/** In the order the chips and the map key list them. */
export const POI_CATEGORIES = [
  {
    id: 'summit',
    label: 'Summit',
    plural: 'Summits',
    icon: 'c-summit',
    colour: '#2d6a4f',
    tags: [
      ['natural', 'peak'],
      ['natural', 'hill']
    ],
    areas: false,
    quota: 40
  },
  {
    id: 'viewpoint',
    label: 'Viewpoint',
    plural: 'Viewpoints',
    icon: 'c-viewpoint',
    colour: '#1a73e8',
    tags: [['tourism', 'viewpoint']],
    areas: false,
    quota: 25
  },
  {
    id: 'water',
    label: 'Water source',
    plural: 'Water',
    icon: 'c-water',
    colour: '#3d9bd0',
    tags: [
      ['natural', 'spring'],
      ['amenity', 'drinking_water'],
      ['man_made', 'water_tap']
    ],
    areas: false,
    quota: 25
  },
  {
    // Somewhere to stop or sleep: one question, so one category.
    id: 'camp',
    label: 'Shelter or campsite',
    plural: 'Shelters & camps',
    icon: 'c-camp',
    colour: '#8b5a2b',
    tags: [
      ['amenity', 'shelter'],
      ['building', 'bothy'],
      ['tourism', 'wilderness_hut'],
      ['tourism', 'alpine_hut'],
      ['tourism', 'camp_site'],
      ['tourism', 'caravan_site']
    ],
    areas: true,
    quota: 30
  },
  {
    id: 'parking',
    label: 'Parking or trailhead',
    plural: 'Parking',
    icon: 'c-parking',
    colour: '#4a7ebb',
    tags: [
      ['amenity', 'parking'],
      ['highway', 'trailhead']
    ],
    areas: true,
    quota: 25
  }
] as const satisfies readonly PoiCategoryShape[];

export type PoiCategory = (typeof POI_CATEGORIES)[number];
export type PoiKind = PoiCategory['id'];

const BY_ID = new Map<string, PoiCategory>(POI_CATEGORIES.map((c) => [c.id, c]));

export function poiCategory(id: string): PoiCategory | undefined {
  return BY_ID.get(id);
}

export interface Poi {
  kind: PoiKind;
  name: string;
  pos: LatLng;
  /** Summit height in metres, where OSM records it. */
  ele?: number;
}

/** How long Overpass may spend on one category's query. */
const SERVER_TIMEOUT_S = 20;

const selector = ([key, value]: TagMatch): string => `["${key}"="${value}"]`;

/** The edges of an area of map, in degrees. */
export interface Box {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** Metres in one degree of latitude — near enough everywhere. */
const M_PER_DEG = 111320;
/** Nearby never searches less than this either side of the middle of the view… */
export const NEARBY_MIN_HALF_M = 800;
/** …nor more, which is what Overpass answers quickly on a busy mirror. */
export const NEARBY_MAX_HALF_M = 12000;

/**
 * The area a nearby search covers: the map as it is on screen, wherever that
 * is. It used to be a square around the live GPS fix, sized from the screen —
 * so sitting in Ealing and looking at Sheeps Tor found things around Ealing,
 * none of them on the map you were looking at (#98).
 *
 * Each direction is clamped separately around the middle of the view. Zoomed
 * right in, a few streets' worth of screen is widened so a search still finds
 * something; zoomed right out, a county's worth is cut down to what the
 * servers will answer, keeping the middle, where you are looking.
 */
export function nearbyBox(view: Box): Box {
  const midLat = (view.south + view.north) / 2;
  const midLng = (view.west + view.east) / 2;
  // Guard the cosine so a search near the poles cannot divide by ~zero.
  const mPerDegLng = M_PER_DEG * Math.max(Math.cos((midLat * Math.PI) / 180), 0.01);
  const clampHalf = (degrees: number, mPerDeg: number) =>
    Math.min(Math.max((degrees / 2) * mPerDeg, NEARBY_MIN_HALF_M), NEARBY_MAX_HALF_M) / mPerDeg;
  const dLat = clampHalf(view.north - view.south, M_PER_DEG);
  const dLng = clampHalf(view.east - view.west, mPerDegLng);
  const lat = (v: number) => Math.min(Math.max(v, -90), 90);
  // Overpass wants west < east, so a box spilling over the antimeridian is
  // clipped rather than wrapped.
  const lng = (v: number) => Math.min(Math.max(v, -180), 180);
  return {
    south: lat(midLat - dLat),
    west: lng(midLng - dLng),
    north: lat(midLat + dLat),
    east: lng(midLng + dLng)
  };
}

/**
 * A box rather than an `(around:…)` circle on every statement, because that is
 * what Overpass is fast at: measured against the live mirrors, fifteen
 * categories in one boxed query answered in about three seconds where three
 * with per-statement `around` took ten, or timed out.
 */
function bboxFilter({ south, west, north, east }: Box): string {
  return [south, west, north, east].map((v) => v.toFixed(5)).join(',');
}

/**
 * Fetch POIs of one category inside a box.
 *
 * One category per query: each chip in the Map sheet is its own layer, so
 * ticking one asks only for that, and unticking another costs nothing.
 * Throws on network/timeout failure.
 */
export async function fetchPois(
  box: Box,
  kind: PoiKind,
  signal?: AbortSignal
): Promise<Poi[]> {
  const cat = BY_ID.get(kind);
  if (!cat) return [];

  const kw = cat.areas ? 'nwr' : 'node';
  const lines = cat.tags.map((t) => `  ${kw}${selector(t)};`).join('\n');
  // One union, so a feature carrying two of the tags comes back once.
  // `out center` gives areas a single point; on nodes it is plain `out body`.
  const query = `[out:json][timeout:${SERVER_TIMEOUT_S}][bbox:${bboxFilter(box)}];\n(\n${lines}\n);\nout center ${cat.quota};`;

  const data = await queryOverpass(query, SERVER_TIMEOUT_S * 1000 + 5000, signal);

  const out: Poi[] = [];
  for (const el of data.elements ?? []) {
    const tags = el.tags ?? {};
    const lat2 = el.lat ?? el.center?.lat;
    const lng2 = el.lon ?? el.center?.lon;
    if (lat2 === undefined || lng2 === undefined) continue;
    const ele = parseFloat(tags.ele ?? '');
    out.push({
      kind: cat.id,
      name: tags.name || cat.label,
      pos: [lat2, lng2],
      ...(Number.isFinite(ele) ? { ele } : {})
    });
  }
  return out;
}
