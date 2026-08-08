import { haversine, type LatLng } from './geo';
import { eastingNorthingToLatLng, parseGridRef } from './osgb';

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

/**
 * Gazetteers rank "Helvellyn Avenue, Sunderland" above the mountain, which is
 * the wrong answer in a hiking app. Rank natural features first, then
 * settlements, then everything else, and prefer whatever is nearest the map.
 */
function typeRank(type: string): number {
  const t = type.toLowerCase();
  if (/hill|mountain|peak|water|lake|forest|wood|landform|landcover|wetland|park|island|valley|moor|cliff|bay/.test(t)) {
    return 0;
  }
  if (/city|town|village|hamlet|settlement|suburb|locality|place/.test(t)) return 1;
  return 2;
}

// Larger than the length of Great Britain, so a hill always outranks a
// street named after it however far away it is; distance only orders
// results that are of the same kind.
const KM_PER_RANK = 1200;

function rankHits(hits: (SearchHit & { type: string })[], near: LatLng | undefined): SearchHit[] {
  return hits
    .map((h) => {
      const distKm = near ? haversine(near, h.pos) / 1000 : 0;
      return { hit: h, distKm, score: typeRank(h.type) * KM_PER_RANK + distKm };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, 8)
    .map(({ hit, distKm }) => ({
      name: hit.name,
      detail: near && distKm >= 0.1
        ? `${hit.detail}${hit.detail ? ' · ' : ''}${distKm < 10 ? distKm.toFixed(1) : Math.round(distKm)} km away`
        : hit.detail,
      pos: hit.pos
    }));
}

interface OsNamesResult {
  GAZETTEER_ENTRY?: {
    NAME1?: string;
    LOCAL_TYPE?: string;
    COUNTY_UNITARY?: string;
    DISTRICT_BOROUGH?: string;
    GEOMETRY_X?: number;
    GEOMETRY_Y?: number;
  };
}

/** OS Names API — needs the user's OS key; British place names only. */
async function searchOsNames(
  query: string,
  osKey: string,
  near: LatLng | undefined,
  signal?: AbortSignal
): Promise<SearchHit[]> {
  const url = `https://api.os.uk/search/names/v1/find?query=${encodeURIComponent(query)}&maxresults=40&key=${osKey}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`OS Names ${res.status}`);
  const data = (await res.json()) as { results?: OsNamesResult[] };

  const hits = (data.results ?? []).flatMap((r) => {
    const g = r.GAZETTEER_ENTRY;
    if (!g?.NAME1 || g.GEOMETRY_X === undefined || g.GEOMETRY_Y === undefined) return [];
    return [{
      name: g.NAME1,
      detail: [g.LOCAL_TYPE, g.COUNTY_UNITARY ?? g.DISTRICT_BOROUGH].filter(Boolean).join(' · '),
      pos: eastingNorthingToLatLng(g.GEOMETRY_X, g.GEOMETRY_Y),
      type: g.LOCAL_TYPE ?? ''
    }];
  });
  return rankHits(hits, near);
}

interface PhotonFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    name?: string;
    osm_key?: string;
    osm_value?: string;
    housenumber?: string;
    street?: string;
    city?: string;
    county?: string;
    state?: string;
  };
}

/**
 * Photon fallback when there's no OS key. It's OpenStreetMap data like
 * Nominatim, but purpose-built for type-ahead (and gentler on the shared
 * Nominatim service we'd otherwise lean on). The `near` bias asks Photon to
 * favour nearby results; our own ranking then does the hiking-specific sort.
 */
async function searchPhoton(
  query: string,
  near: LatLng | undefined,
  signal?: AbortSignal
): Promise<SearchHit[]> {
  const bias = near ? `&lat=${near[0]}&lon=${near[1]}` : '';
  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=20&lang=en${bias}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Photon ${res.status}`);
  const data = (await res.json()) as { features?: PhotonFeature[] };

  const hits = (data.features ?? []).flatMap((f) => {
    const c = f.geometry?.coordinates;
    const p = f.properties;
    if (!c || !p) return [];
    const name = p.name || [p.housenumber, p.street].filter(Boolean).join(' ') || p.city || '';
    if (!name) return [];
    const locality = p.city ?? p.county ?? p.state;
    return [{
      name,
      detail: [p.osm_value, locality].filter(Boolean).join(' · '),
      pos: [c[1], c[0]] as LatLng, // GeoJSON is [lon, lat]
      type: `${p.osm_key ?? ''} ${p.osm_value ?? ''}`
    }];
  });
  return rankHits(hits, near);
}

/**
 * Resolve a search box entry. Grid references and coordinates are handled
 * offline; anything else goes to a place-name gazetteer, ranked with `near`
 * (normally the map centre) as a tie-breaker.
 */
export async function search(
  query: string,
  osKey: string,
  near?: LatLng,
  signal?: AbortSignal
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

  return osKey ? searchOsNames(q, osKey, near, signal) : searchPhoton(q, near, signal);
}
