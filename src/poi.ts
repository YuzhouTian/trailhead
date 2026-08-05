import type { LatLng } from './geo';

/**
 * Nearby points of interest from OpenStreetMap via Overpass.
 * Deliberately a short, hiking-focused list rather than everything OSM knows —
 * the point is "what's worth seeing near me", not a directory.
 */

// The main Overpass instance is frequently overloaded (504/429), so try
// mirrors in turn rather than failing the first time it is busy.
const OVERPASS_URLS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];

export type PoiKind = 'summit' | 'viewpoint' | 'water';

export interface Poi {
  kind: PoiKind;
  name: string;
  pos: LatLng;
  /** Summit height in metres, where OSM records it. */
  ele?: number;
}

export const POI_STYLE: Record<PoiKind, { icon: string; label: string }> = {
  summit: { icon: '▲', label: 'Summit' },
  viewpoint: { icon: '◉', label: 'Viewpoint' },
  water: { icon: '💧', label: 'Water' }
};

interface OverpassElement {
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/** One attempt at one mirror, with its own time limit. */
async function attempt(
  url: string,
  query: string,
  outer: AbortSignal | undefined,
  timeoutMs: number
): Promise<{ elements?: OverpassElement[] }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const relay = () => ctrl.abort();
  outer?.addEventListener('abort', relay);
  try {
    const res = await fetch(url, { method: 'POST', body: query, signal: ctrl.signal });
    if (!res.ok) throw new Error(`server busy (${res.status})`);
    return (await res.json()) as { elements?: OverpassElement[] };
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', relay);
  }
}

/**
 * Overpass is a free shared service that regularly returns 504 under load,
 * so sweep the mirrors twice before giving up.
 */
async function queryOverpass(
  query: string,
  signal?: AbortSignal
): Promise<{ elements?: OverpassElement[] }> {
  let lastError = 'no response';
  for (let pass = 0; pass < 2; pass++) {
    for (const url of OVERPASS_URLS) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      try {
        return await attempt(url, query, signal, 12000);
      } catch (e) {
        if (signal?.aborted) throw e;
        lastError = (e as Error).message;
      }
    }
  }
  throw new Error(lastError);
}

function classify(tags: Record<string, string>): PoiKind | null {
  if (tags.natural === 'peak') return 'summit';
  if (tags.tourism === 'viewpoint') return 'viewpoint';
  if (tags.natural === 'spring' || tags.amenity === 'drinking_water') return 'water';
  return null;
}

/** Fetch POIs within `radiusM` of a point. Throws on network/timeout failure. */
export async function fetchPois(
  centre: LatLng,
  radiusM: number,
  signal?: AbortSignal
): Promise<Poi[]> {
  const [lat, lng] = centre;
  const around = `(around:${Math.round(radiusM)},${lat.toFixed(5)},${lng.toFixed(5)})`;
  const query = `[out:json][timeout:20];
(
  node["natural"="peak"]${around};
  node["tourism"="viewpoint"]${around};
  node["natural"="spring"]${around};
  node["amenity"="drinking_water"]${around};
);
out body 80;`;

  const data = await queryOverpass(query, signal);

  const out: Poi[] = [];
  for (const el of data.elements ?? []) {
    const tags = el.tags ?? {};
    const kind = classify(tags);
    if (!kind) continue;
    const lat2 = el.lat ?? el.center?.lat;
    const lng2 = el.lon ?? el.center?.lon;
    if (lat2 === undefined || lng2 === undefined) continue;
    const ele = parseFloat(tags.ele ?? '');
    out.push({
      kind,
      name: tags.name || (kind === 'water' ? 'Water source' : POI_STYLE[kind].label),
      pos: [lat2, lng2],
      ...(Number.isFinite(ele) ? { ele } : {})
    });
  }
  return out;
}
