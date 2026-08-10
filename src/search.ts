import { haversine, type LatLng } from './geo';
import { parseGridRef } from './osgb';
import { queryOverpass } from './overpass';

export interface SearchHit {
  name: string;
  detail: string;
  pos: LatLng;
}

/** Decimal or signed lat/lng pair: "54.4542, -3.2116". */
function parseLatLng(input: string): LatLng | null {
  const m = input.trim().match(/^(-?\d{1,2}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return [lat, lng];
}

// ------------------------------------------------------------- kinds of place

/**
 * How much a kind of place looks like somewhere you would walk to. The gap
 * between buckets is wider than every other signal put together, so no amount
 * of fame or proximity lifts a lane above the hill it was named after.
 */
const TARGET = 0; // summits, parks, reserves, big water — the thing you came for
const FEATURE = 1; // other natural features: woods, moors, valleys, cliffs
const SETTLEMENT = 2; // cities down to hamlets
const OTHER = 3; // streets, addresses, buildings, everything else

interface PlaceType {
  /** Human label for the detail line, in place of the raw OSM value. */
  label: string;
  bucket: number;
  /** Worth showing the OSM `ele` tag: how you tell two hills of a name apart. */
  ele?: boolean;
}

/**
 * `osm_key=osm_value` as Photon reports it. Anything missing still gets a
 * sensible label and bucket from the rules below, so this table only needs the
 * types where the raw value reads badly or the bucket isn't obvious.
 */
const PLACE_TYPES: Record<string, PlaceType> = {
  'natural=peak': { label: 'Summit', bucket: TARGET, ele: true },
  'natural=hill': { label: 'Hill', bucket: TARGET, ele: true },
  'natural=volcano': { label: 'Volcano', bucket: TARGET, ele: true },
  'natural=massif': { label: 'Massif', bucket: TARGET, ele: true },
  'natural=ridge': { label: 'Ridge', bucket: TARGET, ele: true },
  'natural=arete': { label: 'Arête', bucket: TARGET, ele: true },
  'natural=saddle': { label: 'Col', bucket: TARGET, ele: true },
  'natural=glacier': { label: 'Glacier', bucket: TARGET },
  'natural=water': { label: 'Water', bucket: TARGET },
  'water=lake': { label: 'Lake', bucket: TARGET },
  'water=reservoir': { label: 'Reservoir', bucket: TARGET },
  'water=pond': { label: 'Pond', bucket: FEATURE },
  'water=river': { label: 'River', bucket: FEATURE },
  'natural=wood': { label: 'Woodland', bucket: FEATURE },
  'natural=scrub': { label: 'Scrub', bucket: FEATURE },
  'natural=cave_entrance': { label: 'Cave', bucket: FEATURE },
  'natural=coastline': { label: 'Coast', bucket: FEATURE },
  'waterway=waterfall': { label: 'Waterfall', bucket: TARGET, ele: true },
  'boundary=national_park': { label: 'National park', bucket: TARGET },
  'boundary=protected_area': { label: 'Protected area', bucket: TARGET },
  // The parish outline of a town is never a better answer than the town.
  'boundary=administrative': { label: 'Boundary', bucket: OTHER },
  'boundary=ceremonial': { label: 'Boundary', bucket: OTHER },
  'leisure=nature_reserve': { label: 'Nature reserve', bucket: TARGET },
  'tourism=viewpoint': { label: 'Viewpoint', bucket: TARGET, ele: true },
  'tourism=alpine_hut': { label: 'Mountain hut', bucket: TARGET, ele: true },
  'tourism=wilderness_hut': { label: 'Bothy', bucket: TARGET, ele: true },
  'route=hiking': { label: 'Walking route', bucket: TARGET },
  'route=foot': { label: 'Walking route', bucket: TARGET },
  'landuse=forest': { label: 'Forest', bucket: FEATURE },
  'leisure=park': { label: 'Park', bucket: FEATURE },
  'man_made=survey_point': { label: 'Trig point', bucket: FEATURE, ele: true },
  'place=locality': { label: 'Locality', bucket: SETTLEMENT },
  'place=isolated_dwelling': { label: 'Dwelling', bucket: SETTLEMENT },
  'highway=residential': { label: 'Residential street', bucket: OTHER },
  'highway=unclassified': { label: 'Street', bucket: OTHER },
  'highway=service': { label: 'Service road', bucket: OTHER },
  'highway=footway': { label: 'Footpath', bucket: OTHER },
  'highway=bus_stop': { label: 'Bus stop', bucket: OTHER }
};

/** Where a key on its own is enough to place something. */
const KEY_BUCKETS: Record<string, number> = {
  natural: FEATURE,
  water: FEATURE,
  waterway: FEATURE,
  landuse: FEATURE,
  place: SETTLEMENT,
  highway: OTHER
};

/** "nature_reserve" → "Nature reserve". */
function prettify(value: string): string {
  const words = value.replace(/_/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : '';
}

function placeType(key: string, value: string, photonType: string): PlaceType {
  const known = PLACE_TYPES[`${key}=${value}`];
  if (known) return known;
  // Photon's own `type` is the last word: it knows a housenumber from a county
  // even when the OSM tags are something we've never seen.
  const fromPhoton = /^(city|district|locality|county|state|country)$/.test(photonType)
    ? SETTLEMENT
    : OTHER;
  // `building=yes` and friends say nothing in the value, so fall back to the
  // key rather than putting "Yes" on the row.
  const label = value && value !== 'yes' ? prettify(value) : prettify(key);
  return { label: label || 'Place', bucket: KEY_BUCKETS[key] ?? fromPhoton };
}

// ------------------------------------------------------------------- scoring

/**
 * A candidate result and everything the score is allowed to look at. Photon
 * fills all of it except `ele` and `famous`, which only the optional Overpass
 * enrichment can know.
 */
interface Candidate {
  name: string;
  pos: LatLng;
  type: PlaceType;
  /** `natural=water` — kept so enrichment can refine what it found. */
  tag: string;
  /** County, park or town: how people actually tell two of a name apart. */
  locality: string;
  /** `node/123`, the handle the enrichment query needs. Absent for nothing. */
  ref: string;
  /** Mapped as an area rather than a lone node — a real footprint on the ground. */
  extent: boolean;
  /** Place in Photon's own ranking, which its internal importance feeds. */
  order: number;
  distKm: number;
  ele?: number;
  famous?: boolean;
}

/**
 * Penalty points, lowest first. The magnitudes are the whole design: the kind
 * of place decides, then how exactly the name matches, then how well known it
 * is — and distance only separates candidates that are otherwise identical.
 * Someone who typed a name deliberately wants the famous one 40 km away, not
 * the nameless knoll up the road; if they wanted that, they'd look at the map.
 */
const W = {
  bucket: 1000,
  /** Per step of exact → prefix → substring → unrelated. */
  name: 100,
  /** Carries a wikipedia/wikidata tag: blunt, but people have heard of it. */
  famous: 60,
  /** Scaled over ELE_FULL_M — the higher of two same-named hills. */
  ele: 30,
  /** Has a bounding box, so it is an area and not a single node. */
  extent: 20,
  /** Per place in Photon's ranking, capped at ORDER_CAP. */
  order: 3,
  /** Scaled over KM_FULL, and capped there. */
  distance: 40
};
const ELE_FULL_M = 1000;
const KM_FULL = 250;
const ORDER_CAP = 10;

/** Lower-case, unaccented, punctuation-free: for comparing names to a query. */
function normalise(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** 0 exact, 1 starts with the query, 2 contains it, 3 neither. */
function nameMatch(name: string, query: string): number {
  const n = normalise(name);
  if (n === query) return 0;
  if (n.startsWith(`${query} `)) return 1;
  if (n.includes(query)) return 2;
  return 3;
}

function score(c: Candidate, query: string): number {
  // Height only counts where height is the point: a tall office block with an
  // `ele` tag is not a more likely answer than a short one.
  const height = c.type.ele && c.ele !== undefined ? Math.max(c.ele, 0) : 0;
  const fame =
    (c.famous ? W.famous : 0) +
    (c.extent ? W.extent : 0) +
    (Math.min(height, ELE_FULL_M) / ELE_FULL_M) * W.ele;
  return (
    c.type.bucket * W.bucket +
    nameMatch(c.name, query) * W.name +
    Math.min(c.order, ORDER_CAP) * W.order +
    (Math.min(c.distKm, KM_FULL) / KM_FULL) * W.distance -
    fame
  );
}

/**
 * Two hits this close with the same name are the same place twice — the peak
 * and the hill around it, or one stream cut into two ways.
 */
const DUPLICATE_M = 2000;

/**
 * Best first, and only one of each place: Photon routinely returns a hill as
 * both the peak node and the way around it, and a screen of near-identical
 * rows is exactly what makes a search feel useless.
 */
function rank(cands: Candidate[], query: string, limit: number): Candidate[] {
  const sorted = cands
    .map((c) => ({ c, s: score(c, query) }))
    .sort((a, b) => a.s - b.s)
    .map(({ c }) => c);

  const kept: Candidate[] = [];
  for (const c of sorted) {
    const dupe = kept.some(
      (k) => normalise(k.name) === normalise(c.name) && haversine(k.pos, c.pos) < DUPLICATE_M
    );
    if (dupe) continue;
    kept.push(c);
    if (kept.length === limit) break;
  }
  return kept;
}

/** "Summit · 260 m · Buckinghamshire · 34 km away" — distance last. */
function present(cands: Candidate[], near: LatLng | undefined): SearchHit[] {
  return cands.map((c) => {
    const parts = [c.type.label];
    if (c.type.ele && c.ele !== undefined) parts.push(`${Math.round(c.ele)} m`);
    if (c.locality) parts.push(c.locality);
    if (near && c.distKm >= 0.1) {
      parts.push(`${c.distKm < 10 ? c.distKm.toFixed(1) : Math.round(c.distKm)} km away`);
    }
    return { name: c.name, detail: parts.join(' · '), pos: c.pos };
  });
}

// ---------------------------------------------------------------- enrichment

/** Photon's one-letter OSM types, as Overpass spells them. */
const OSM_TYPES: Record<string, string> = { N: 'node', W: 'way', R: 'relation' };

const ENRICH_TIMEOUT_MS = 8000;

/**
 * Fetch the OSM tags of a shortlist and fold them into the candidates: `ele`
 * for summits, and a wikipedia/wikidata entry as the "people have heard of
 * this" signal the Photon response has no way to express.
 *
 * Strictly a bonus. It runs after the ranked list is already on screen, it is
 * cancelled along with the search, and Overpass is a busy shared service that
 * often just says no — in which case nothing changes and nobody is told.
 * Returns whether anything was actually learnt.
 */
async function enrich(cands: Candidate[], signal?: AbortSignal): Promise<boolean> {
  const ids: Record<string, number[]> = {};
  for (const c of cands) {
    const [type, id] = c.ref.split('/');
    (ids[type] ??= []).push(Number(id));
  }
  const sets = Object.entries(ids).map(([type, list]) => `  ${type}(id:${list.join(',')});`);
  if (!sets.length) return false;

  // `out tags` and nothing else: no geometry, no members — an id lookup is the
  // cheapest thing Overpass does, and we already know where everything is.
  const query = `[out:json][timeout:10];\n(\n${sets.join('\n')}\n);\nout tags;`;
  const data = await queryOverpass(query, ENRICH_TIMEOUT_MS, signal);

  const tagsByRef = new Map<string, Record<string, string>>();
  for (const el of data.elements ?? []) {
    if (el.type && el.id !== undefined && el.tags) tagsByRef.set(`${el.type}/${el.id}`, el.tags);
  }

  let learnt = false;
  for (const c of cands) {
    const tags = tagsByRef.get(c.ref);
    if (!tags) continue;
    const ele = parseFloat(tags.ele ?? '');
    if (Number.isFinite(ele)) {
      c.ele = ele;
      learnt = true;
    }
    if (tags.wikidata || tags.wikipedia) {
      c.famous = true;
      learnt = true;
    }
    // A lake and a reservoir are both `natural=water` to Photon.
    if (c.tag === 'natural=water' && tags.water) {
      c.type = { ...c.type, label: prettify(tags.water) };
      learnt = true;
    }
  }
  return learnt;
}

// -------------------------------------------------------------------- Photon

interface PhotonFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    name?: string;
    osm_key?: string;
    osm_value?: string;
    osm_type?: string;
    osm_id?: number;
    type?: string;
    extent?: number[];
    housenumber?: string;
    street?: string;
    city?: string;
    district?: string;
    county?: string;
    state?: string;
  };
}

/** How many rows the search box shows. */
const MAX_HITS = 8;

/**
 * Photon fallback when there's no OS key. It's OpenStreetMap data like
 * Nominatim, but purpose-built for type-ahead (and gentler on the shared
 * Nominatim service we'd otherwise lean on). The `near` bias asks Photon to
 * favour nearby results; our own ranking then does the hiking-specific sort.
 */
async function searchPhoton(
  query: string,
  near: LatLng | undefined,
  signal?: AbortSignal,
  onRefine?: (hits: SearchHit[]) => void
): Promise<SearchHit[]> {
  const bias = near ? `&lat=${near[0]}&lon=${near[1]}` : '';
  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=20&lang=en${bias}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Photon ${res.status}`);
  const data = (await res.json()) as { features?: PhotonFeature[] };

  const cands = (data.features ?? []).flatMap((f, order): Candidate[] => {
    const c = f.geometry?.coordinates;
    const p = f.properties;
    if (!c || !p) return [];
    const name = p.name || [p.housenumber, p.street].filter(Boolean).join(' ') || p.city || '';
    if (!name) return [];
    const pos: LatLng = [c[1], c[0]]; // GeoJSON is [lon, lat]
    const type = placeType(p.osm_key ?? '', p.osm_value ?? '', p.type ?? '');
    // A hill belongs to its county; a street belongs to its town.
    const places =
      type.bucket <= FEATURE
        ? [p.county, p.city, p.state, p.district]
        : [p.city, p.district, p.county, p.state];
    const osmType = OSM_TYPES[p.osm_type ?? ''];
    return [{
      name,
      pos,
      type,
      tag: `${p.osm_key ?? ''}=${p.osm_value ?? ''}`,
      locality: places.find((v) => v && normalise(v) !== normalise(name)) ?? '',
      ref: osmType && p.osm_id !== undefined ? `${osmType}/${p.osm_id}` : '',
      extent: Array.isArray(p.extent),
      order,
      distKm: near ? haversine(near, pos) / 1000 : 0
    }];
  });

  const q = normalise(query);
  const shortlist = rank(cands, q, MAX_HITS);

  // Only bother Overpass when the answer is the kind of thing it can settle —
  // a search that turned up nothing but streets has nothing to learn from `ele`.
  const worthEnriching = shortlist.some((c) => c.ref && c.type.bucket <= FEATURE);
  if (onRefine && worthEnriching) {
    void enrich(shortlist.filter((c) => c.ref), signal)
      .then((learnt) => {
        if (learnt && !signal?.aborted) onRefine(present(rank(shortlist, q, MAX_HITS), near));
      })
      .catch(() => {
        /* Overpass is busy or gone: the list on screen is already the answer. */
      });
  }

  return present(shortlist, near);
}

/**
 * Resolve a search box entry. Grid references and coordinates are handled
 * offline; anything else goes to the Photon place-name search, ranked with
 * `near` (normally the map centre) as a tie-breaker.
 *
 * `onRefine` is called at most once, some time after the returned list, if a
 * background lookup manages to improve the order or the descriptions. Callers
 * that don't want to re-render can leave it out and lose nothing else.
 */
export async function search(
  query: string,
  near?: LatLng,
  signal?: AbortSignal,
  onRefine?: (hits: SearchHit[]) => void
): Promise<SearchHit[]> {
  const q = query.trim();
  if (!q) return [];

  const grid = parseGridRef(q);
  if (grid) {
    return [{ name: q.toUpperCase(), detail: 'Grid reference', pos: grid }];
  }

  const ll = parseLatLng(q);
  if (ll) {
    return [{ name: `${ll[0].toFixed(5)}, ${ll[1].toFixed(5)}`, detail: 'Coordinates', pos: ll }];
  }

  return searchPhoton(q, near, signal, onRefine);
}
