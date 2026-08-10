/**
 * Talking to Overpass, the OpenStreetMap query service.
 *
 * Two callers with quite different needs — "What's nearby" asks for everything
 * in a box, search asks for the tags of a handful of known ids — but both face
 * the same shared, frequently overloaded servers, so the transport lives here.
 */

// The main Overpass instance is frequently overloaded (504/429), so try
// mirrors in turn rather than failing the first time it is busy.
const OVERPASS_URLS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];

export interface OverpassElement {
  type?: string;
  id?: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

const STAGGER_MS = 2500;

/**
 * Overpass is a free shared service that regularly returns 504 under load,
 * and any given mirror may be unreachable. Rather than waiting out each one
 * in turn, start the next mirror if the previous hasn't answered shortly —
 * the first success wins and the rest are cancelled.
 */
export function queryOverpass(
  query: string,
  overallTimeoutMs: number,
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
      setTimeout(() => finish(() => reject(new Error('timed out'))), overallTimeoutMs)
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
