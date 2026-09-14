/**
 * Talking to Overpass, the OpenStreetMap query service.
 *
 * Two callers with quite different needs — nearby points ask for one category
 * in a box, search asks for the tags of a handful of known ids — but both face
 * the same shared, frequently overloaded servers, so the transport lives here.
 */

// Overpass servers are free, shared and often overloaded (504/429), so a query
// races several rather than failing the first time one is busy. Every one of
// these must send `Access-Control-Allow-Origin`, or the browser refuses to
// hand the app its answer however quickly it arrives.
//
// Checked 2026-09-14, when searches kept failing (#102): overpass.kumi.systems
// and overpass.private.coffee turned out to be two names for one machine, and
// it was accepting connections and never answering — so of the three servers
// listed then, only overpass-api.de was really working, and it was busy on two
// queries in three. The mail.ru instance answered nearly every time, in about
// a second. private.coffee stays as the last resort in case that machine comes
// back; listing its other name too would only race it against itself.
export const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
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

/** How long a server gets to answer before the next one is started too. */
const STAGGER_MS = 2500;
/** A busy server is often free again a moment later — overpass-api.de would
 *  answer a query in under a second straight after a 504 for the same one. */
const RETRY_DELAY_MS = 1000;
/** Tries per server, so a busy one is asked again but never hammered. */
const MAX_TRIES = 2;

/**
 * Overpass is a free shared service that regularly returns 504 under load,
 * and any given server may be unreachable. Rather than waiting out each one
 * in turn, start the next if the previous hasn't answered shortly — the first
 * success wins and the rest are cancelled. A server that answers "busy" (5xx)
 * gets one more try while there is time left; one that never answers at all is
 * simply outrun.
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
    const tries = new Map<string, number>();
    let launched = 0;
    let inFlight = 0;
    let retriesWaiting = 0;
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
    // Called off: stop now, rather than when a retry that will never run is due.
    ctrl.signal.addEventListener('abort', () =>
      finish(() => reject(new DOMException('Search cancelled', 'AbortError')))
    );

    const attempt = (url: string): void => {
      if (settled || ctrl.signal.aborted) return;
      tries.set(url, (tries.get(url) ?? 0) + 1);
      inFlight++;
      let overloaded = false;
      fetch(url, { method: 'POST', body: query, signal: ctrl.signal })
        .then((res) => {
          if (!res.ok) {
            // 5xx is the server as a whole being swamped, which passes. 429 is
            // it counting *our* queries, and asking again only adds to the count.
            overloaded = res.status >= 500;
            throw new Error(`server busy (${res.status})`);
          }
          return res.json() as Promise<{ elements?: OverpassElement[] }>;
        })
        .then((data) => finish(() => resolve(data)))
        .catch((e: Error) => {
          if (e.name === 'AbortError') return;
          lastError = e.message;
          // Only a server that answered is worth asking again; one that could
          // not be reached at all will not be any more reachable in a second.
          if (overloaded && (tries.get(url) ?? 0) < MAX_TRIES) {
            retriesWaiting++;
            timers.push(
              setTimeout(() => {
                retriesWaiting--;
                attempt(url);
              }, RETRY_DELAY_MS)
            );
          }
        })
        .finally(() => {
          inFlight--;
          if (settled) return;
          // A server failing fast should immediately promote the next one.
          if (launched < OVERPASS_URLS.length) launchNext();
          else if (inFlight === 0 && retriesWaiting === 0) {
            finish(() => reject(new Error(lastError)));
          }
        });
    };

    const launchNext = (): void => {
      if (settled || launched >= OVERPASS_URLS.length) return;
      attempt(OVERPASS_URLS[launched++]);
      if (launched < OVERPASS_URLS.length) timers.push(setTimeout(launchNext, STAGGER_MS));
    };

    launchNext();
  }).finally(() => {
    ctrl.abort(); // cancel any servers still running
    signal?.removeEventListener('abort', relay);
  });
}
