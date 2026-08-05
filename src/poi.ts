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

const MAX_PER_KIND: Record<PoiKind, number> = {
  summit: 40,
  viewpoint: 25,
  water: 25
};

export const POI_STYLE: Record<PoiKind, { icon: string; label: string }> = {
  summit: { icon: '▲', label: 'Summit' },
  viewpoint: { icon: '◉', label: 'Viewpoint' },
  water: { icon: '💧', label: 'Water' }
};

interface OverpassElement {
  id?: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

const STAGGER_MS = 2500;
const OVERALL_TIMEOUT_MS = 25000;

/**
 * Overpass is a free shared service that regularly returns 504 under load,
 * and any given mirror may be unreachable. Rather than waiting out each one
 * in turn, start the next mirror if the previous hasn't answered shortly —
 * the first success wins and the rest are cancelled.
 */
function queryOverpass(
  query: string,
  signal?: AbortSignal
): Promise<{ elements?: OverpassElement[] }> {
  const ctrl = new AbortController();
  const relay = () => ctrl.abort();
  signal?.addEventListener('abort', relay);

  return new Promise<{ elements?: OverpassElement[] }>((resolve, reject) => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    let launched = 0;
    let inFlight = 0;
    let settled = false;
    let lastError = 'no response';

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      fn();
    };

    timers.push(
      setTimeout(() => finish(() => reject(new Error('timed out'))), OVERALL_TIMEOUT_MS)
    );

    const launch = (): void => {
      if (settled || launched >= OVERPASS_URLS.length) return;
      const url = OVERPASS_URLS[launched++];
      inFlight++;
      fetch(url, { method: 'POST', body: query, signal: ctrl.signal })
        .then((res) => {
          if (!res.ok) throw new Error(`server busy (${res.status})`);
          return res.json() as Promise<{ elements?: OverpassElement[] }>;
        })
        .then((data) => finish(() => resolve(data)))
        .catch((e: Error) => {
          if (e.name !== 'AbortError') lastError = e.message;
        })
        .finally(() => {
          inFlight--;
          // A mirror failing fast should immediately promote the next one.
          if (!settled && launched < OVERPASS_URLS.length) launch();
          else if (!settled && inFlight === 0) finish(() => reject(new Error(lastError)));
        });
      if (launched < OVERPASS_URLS.length) timers.push(setTimeout(launch, STAGGER_MS));
    };

    launch();
  }).finally(() => {
    ctrl.abort(); // cancel any mirrors still running
    signal?.removeEventListener('abort', relay);
  });
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
  // Each category gets its own quota. A single shared limit meant somewhere
  // like Dartmoor — hundreds of tors tagged as peaks — used the whole budget
  // and hid every viewpoint and spring.
  const query = `[out:json][timeout:20];
node["natural"="peak"]${around};
out body ${MAX_PER_KIND.summit};
node["tourism"="viewpoint"]${around};
out body ${MAX_PER_KIND.viewpoint};
(
  node["natural"="spring"]${around};
  node["amenity"="drinking_water"]${around};
);
out body ${MAX_PER_KIND.water};`;

  const data = await queryOverpass(query, signal);

  const out: Poi[] = [];
  const seen = new Set<number>();
  for (const el of data.elements ?? []) {
    const tags = el.tags ?? {};
    const kind = classify(tags);
    if (!kind) continue;
    if (el.id !== undefined) {
      if (seen.has(el.id)) continue;
      seen.add(el.id);
    }
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
