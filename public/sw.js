/* Trailhead service worker: offline app shell + map tile cache. */
const STATIC_CACHE = 'trailhead-static-v1';
// v2: v1 could contain opaque error responses cached as if they were tiles
// (permanent grey squares) — bumping the name discards them.
const TILE_CACHE = 'trailhead-tiles-v2';

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
    url.hostname.endsWith('tile.opentopomap.org') ||
    url.hostname.endsWith('tile.thunderforest.com')
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
        // Tiles are requested with CORS, so status is visible: only cache
        // real tiles. Failures stay uncached and are retried on next view.
        const res = await fetch(req);
        if (res.ok) cache.put(key, res.clone());
        return res;
      })
    );
    return;
  }

  // Never cache routing calls.
  if (url.hostname.includes('brouter')) return;

  // Page loads: network-first so a new deploy shows up immediately;
  // cached shell only when offline.
  if (req.mode === 'navigate' && url.origin === self.location.origin) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        try {
          const res = await fetch(req);
          if (res.ok) cache.put('./index.html', res.clone());
          return res;
        } catch {
          const shell = (await cache.match(req)) || (await cache.match('./index.html'));
          if (shell) return shell;
          throw new Error('offline');
        }
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
