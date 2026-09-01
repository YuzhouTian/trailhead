/* Trailhead service worker: offline app shell + map tile cache. */
const STATIC_CACHE = 'trailhead-static-v1';
// v2: v1 could contain opaque error responses cached as if they were tiles
// (permanent grey squares) — bumping the name discards them.
// v3: the default layer moved to Freemap, which sends no CORS header, so its
// tiles are opaque and cached on trust again (see the fetch handler). Bumping
// discards anything the previous rules let through.
const TILE_CACHE = 'trailhead-tiles-v3';

const PRECACHE = ['./', './index.html', './manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== STATIC_CACHE && k !== TILE_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

function isTileRequest(url) {
  return (
    url.hostname.endsWith('tile.openstreetmap.org') ||
    url.hostname.endsWith('tile.thunderforest.com') ||
    url.hostname.endsWith('tiles.freemap.sk')
  );
}

/* Normalise tile URLs so cache hits don't depend on the {s} subdomain
   or on an API key that may be rotated. */
function tileCacheKey(url) {
  const u = new URL(url.href);
  u.hostname = u.hostname.replace(/^[abc]\.tile\./, 'tile.');
  u.searchParams.delete('apikey');
  u.searchParams.delete('key');
  return u.href;
}

/* Hold the tile cache open: every visible tile hits this path, and reopening
   it per request adds latency to the one thing that must feel instant. */
let tileCachePromise = null;
const tileCache = () => (tileCachePromise ??= caches.open(TILE_CACHE));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Map tiles: cache-first, populate on fetch.
  if (isTileRequest(url)) {
    const key = tileCacheKey(url);
    event.respondWith(
      tileCache().then(async (cache) => {
        const hit = await cache.match(key);
        if (hit) return hit;
        // Tiles from a CORS-capable host have a readable status, so only real
        // ones are cached and failures are retried on the next view.
        //
        // Freemap sends no CORS header, so Trailhead asks for its tiles without
        // one and they arrive opaque: the status is hidden and there is nothing
        // to check. Caching them on trust is the only way the default layer
        // works offline at all. A dropped connection rejects the fetch rather
        // than returning a response, so patchy signal on a hill still cannot
        // poison the cache; a server-side 404 or 5xx can, and that is what
        // bumping TILE_CACHE clears.
        const res = await fetch(req);
        if (res.ok || res.type === 'opaque') cache.put(key, res.clone());
        return res;
      })
    );
    return;
  }

  // Never cache routing calls.
  if (url.hostname.includes('brouter')) return;

  // Page loads: stale-while-revalidate. Serve the cached shell instantly so the
  // map paints without waiting on the network, and refresh it in the background
  // for next launch. A new deploy therefore appears on the next open, not this
  // one. Falls back to the network on a cold cache, and errors only when both
  // are unavailable (truly offline first run).
  if (req.mode === 'navigate' && url.origin === self.location.origin) {
    const update = caches.open(STATIC_CACHE).then(async (cache) => {
      try {
        const res = await fetch(req);
        if (res.ok) await cache.put('./index.html', res.clone());
        return res;
      } catch {
        return null;
      }
    });
    // Keep the worker alive until the background refresh finishes.
    event.waitUntil(update);
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const cached = (await cache.match('./index.html')) || (await cache.match('./'));
        if (cached) return cached;
        const res = await update;
        if (res) return res;
        throw new Error('offline');
      })
    );
    return;
  }

  // Other same-origin files (hashed JS/CSS, icons): stale-while-revalidate.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        const network = fetch(req)
          .then((res) => {
            if (res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(() => {
            throw new Error('offline');
          });
        return cached || network;
      })
    );
  }
});
