import type { LatLng } from './geo';
import { queryOverpass } from './overpass';

/**
 * Nearby points of interest from OpenStreetMap via Overpass.
 *
 * Every category lives in one table below: it drives the Overpass query, the
 * map markers, the map key and the tick list in Settings. Adding a category
 * means adding a row, not touching four files.
 */

/** One OSM tag a feature must carry to fall into a category. */
type TagMatch = readonly [key: string, value: string];

/** The shape of a row in the table below; `PoiCategory` is what you get out. */
interface PoiCategoryShape {
  readonly id: string;
  /** Singular — the marker popup, the map key, and the name of an unnamed feature. */
  readonly label: string;
  /** Plural — the tick list in Settings. */
  readonly plural: string;
  readonly icon: string;
  /** Marker ring colour. Map symbology, so a fixed colour rather than a theme token. */
  readonly colour: string;
  readonly tags: readonly TagMatch[];
  /** Search ways and relations too — for things usually mapped as an area. */
  readonly areas: boolean;
  /** This category's own `out` limit; categories never share a budget. */
  readonly quota: number;
}

/**
 * Order matters twice: it is the order of the tick list, and it decides which
 * category wins when a feature carries tags from two (a trig pillar on a peak
 * is a summit, not a survey point).
 */
export const POI_CATEGORIES = [
  {
    id: 'summit',
    label: 'Summit',
    plural: 'Summits',
    icon: '▲',
    colour: '#2d6a4f',
    tags: [
      ['natural', 'peak'],
      ['natural', 'hill']
    ],
    areas: false,
    quota: 40
  },
  {
    id: 'trig',
    label: 'Trig point',
    plural: 'Trig points',
    icon: '△',
    colour: '#6b705c',
    tags: [['man_made', 'survey_point']],
    areas: false,
    quota: 20
  },
  {
    id: 'viewpoint',
    label: 'Viewpoint',
    plural: 'Viewpoints',
    icon: '◉',
    colour: '#1a73e8',
    tags: [['tourism', 'viewpoint']],
    areas: false,
    quota: 25
  },
  {
    id: 'water',
    label: 'Water source',
    plural: 'Water sources',
    icon: '💧',
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
    id: 'waterfall',
    label: 'Waterfall',
    plural: 'Waterfalls',
    icon: '≋',
    colour: '#2f7d95',
    tags: [['waterway', 'waterfall']],
    areas: false,
    quota: 15
  },
  {
    id: 'shelter',
    label: 'Shelter or bothy',
    plural: 'Shelters and bothies',
    icon: '⌂',
    colour: '#8b5a2b',
    tags: [
      ['amenity', 'shelter'],
      ['building', 'bothy'],
      ['tourism', 'wilderness_hut'],
      ['tourism', 'alpine_hut']
    ],
    areas: true,
    quota: 20
  },
  {
    id: 'campsite',
    label: 'Campsite',
    plural: 'Campsites',
    icon: '⛺',
    colour: '#7a9e3f',
    tags: [
      ['tourism', 'camp_site'],
      ['tourism', 'caravan_site']
    ],
    areas: true,
    quota: 20
  },
  {
    id: 'refreshment',
    label: 'Pub or café',
    plural: 'Pubs and cafés',
    icon: '☕',
    colour: '#b5651d',
    tags: [
      ['amenity', 'pub'],
      ['amenity', 'cafe'],
      ['amenity', 'restaurant']
    ],
    areas: true,
    quota: 25
  },
  {
    id: 'toilets',
    label: 'Toilets',
    plural: 'Toilets',
    icon: '🚻',
    colour: '#5a6d8c',
    tags: [['amenity', 'toilets']],
    areas: true,
    quota: 15
  },
  {
    id: 'parking',
    label: 'Parking or trailhead',
    plural: 'Parking and trailheads',
    icon: 'P',
    colour: '#4a7ebb',
    tags: [
      ['amenity', 'parking'],
      ['highway', 'trailhead']
    ],
    areas: true,
    quota: 25
  },
  {
    id: 'transport',
    label: 'Bus stop or station',
    plural: 'Public transport',
    icon: '🚌',
    colour: '#7b5ea7',
    tags: [
      ['highway', 'bus_stop'],
      ['railway', 'station'],
      ['railway', 'halt']
    ],
    areas: false,
    quota: 25
  },
  {
    id: 'picnic',
    label: 'Picnic site',
    plural: 'Picnic sites',
    icon: '🧺',
    colour: '#6a9e4f',
    tags: [
      ['tourism', 'picnic_site'],
      ['leisure', 'picnic_table']
    ],
    areas: true,
    quota: 15
  },
  {
    id: 'landmark',
    label: 'Landmark',
    plural: 'Cairns and landmarks',
    icon: '★',
    colour: '#a0522d',
    tags: [
      ['historic', 'cairn'],
      ['man_made', 'cairn'],
      ['historic', 'monument'],
      ['historic', 'memorial'],
      ['historic', 'ruins'],
      ['historic', 'archaeological_site']
    ],
    areas: true,
    quota: 25
  },
  {
    id: 'cave',
    label: 'Cave entrance',
    plural: 'Caves',
    icon: '∩',
    colour: '#4d4d4d',
    tags: [['natural', 'cave_entrance']],
    areas: false,
    quota: 15
  },
  {
    id: 'emergency',
    label: 'Emergency point',
    plural: 'Emergency points',
    icon: '✚',
    colour: '#c0392b',
    tags: [
      ['emergency', 'phone'],
      ['amenity', 'rescue_station']
    ],
    areas: false,
    quota: 15
  }
] as const satisfies readonly PoiCategoryShape[];

export type PoiCategory = (typeof POI_CATEGORIES)[number];
export type PoiKind = PoiCategory['id'];

/** What an install without a saved choice searches — today's three. */
export const DEFAULT_POI_KINDS: PoiKind[] = ['summit', 'viewpoint', 'water'];

/**
 * Past this many categories the search is worth a word of warning: still a few
 * seconds on a healthy mirror, but more to go wrong when one is busy.
 */
export const POI_KINDS_ADVISORY = 10;

const BY_ID = new Map<string, PoiCategory>(POI_CATEGORIES.map((c) => [c.id, c]));

export function poiCategory(id: string): PoiCategory | undefined {
  return BY_ID.get(id);
}

/** The chosen categories, in table order, ignoring ids we no longer know. */
export function poiCategories(ids: readonly string[]): PoiCategory[] {
  return POI_CATEGORIES.filter((c) => ids.includes(c.id));
}

/** "summits, viewpoints and water sources" — for toasts and hints. */
export function describeKinds(ids: readonly string[]): string {
  const names = poiCategories(ids).map((c) => c.plural.toLowerCase());
  if (!names.length) return 'nothing';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export interface Poi {
  kind: PoiKind;
  name: string;
  pos: LatLng;
  /** Summit height in metres, where OSM records it. */
  ele?: number;
}

const selector = ([key, value]: TagMatch): string => `["${key}"="${value}"]`;

/**
 * The search area as `south,west,north,east`, from a centre and a radius.
 *
 * A box rather than an `(around:…)` circle on every statement, because that is
 * what Overpass is fast at: measured against the live mirrors, all fifteen
 * categories in one boxed query answered in about three seconds where three
 * categories with per-statement `around` took ten, or timed out. It searches
 * the corners of the map as well, which is no bad thing — the radius is taken
 * from the visible map in the first place.
 */
function boundingBox([lat, lng]: LatLng, radiusM: number): string {
  const dLat = radiusM / 111320;
  // Guard the cosine so a search near the poles cannot divide by ~zero.
  const dLng = radiusM / (111320 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
  const clampLat = (v: number) => Math.min(Math.max(v, -90), 90).toFixed(5);
  // Overpass wants west < east, so a box spilling over the antimeridian is
  // clipped rather than wrapped.
  const clampLng = (v: number) => Math.min(Math.max(v, -180), 180).toFixed(5);
  return `${clampLat(lat - dLat)},${clampLng(lng - dLng)},${clampLat(lat + dLat)},${clampLng(lng + dLng)}`;
}

/** First category whose tags the feature carries, searching in table order. */
function classify(tags: Record<string, string>, cats: PoiCategory[]): PoiCategory | null {
  for (const cat of cats) {
    for (const [key, value] of cat.tags) {
      if (tags[key] === value) return cat;
    }
  }
  return null;
}

/**
 * Fetch POIs of the chosen categories within `radiusM` of a point.
 * Throws on network/timeout failure.
 */
export async function fetchPois(
  centre: LatLng,
  radiusM: number,
  kinds: readonly string[],
  signal?: AbortSignal
): Promise<Poi[]> {
  const cats = poiCategories(kinds);
  if (!cats.length) return [];

  // Each category gets its own quota. A single shared limit meant somewhere
  // like Dartmoor — hundreds of tors tagged as peaks — used the whole budget
  // and hid every viewpoint and spring.
  //
  // Only the ticked categories are asked for, so turning one off makes the
  // query genuinely cheaper rather than just filtering the answer.
  const blocks = cats.map((cat) => {
    const kw = cat.areas ? 'nwr' : 'node';
    const lines = cat.tags.map((t) => `  ${kw}${selector(t)};`).join('\n');
    // `out center` gives areas a single point; on nodes it is plain `out body`.
    return `(\n${lines}\n);\nout center ${cat.quota};`;
  });
  // More categories is more work for one shared server, so give it more rope.
  const serverTimeout = Math.min(20 + 2 * Math.max(0, cats.length - 3), 40);
  const query = `[out:json][timeout:${serverTimeout}][bbox:${boundingBox(centre, radiusM)}];\n${blocks.join('\n')}`;

  const data = await queryOverpass(query, serverTimeout * 1000 + 5000, signal);

  const out: Poi[] = [];
  const seen = new Set<string>();
  for (const el of data.elements ?? []) {
    const tags = el.tags ?? {};
    const cat = classify(tags, cats);
    if (!cat) continue;
    if (el.id !== undefined) {
      // Ids are only unique within a type, so a way and a node can collide.
      const key = `${el.type ?? 'node'}/${el.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
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
