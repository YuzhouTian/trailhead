/* Trailhead service worker: offline app shell + map tile cache. */
// v2: install now caches the app's script and stylesheet as well as the page,
// and a deploy evicts the builds before the last one. Bumping drops the old
// bundles v1 kept forever (one set per deploy, never deleted).
const STATIC_CACHE = 'trailhead-static-v2';
// v2: v1 could contain opaque error responses cached as if they were tiles
// (permanent grey squares) — bumping the name discards them.
// v3: the default layer moved to Freemap, which sends no CORS header, so its
// tiles are opaque and cached on trust again (see the fetch handler). Bumping
// discards anything the previous rules let through.
const TILE_CACHE = 'trailhead-tiles-v3';

/* index.html is not listed: refreshShell stores it together with the files it
   needs, so there is never a cached page whose script is missing. `./` used to
   be cached here too, as a second copy of the page that nothing ever refreshed
   — once its build was evicted it would have opened blank. */
const PRECACHE = ['./manifest.webmanifest'];

/* Held open for the same reason as the tile cache below: every launch and every
   script and stylesheet goes through it. */
let staticCachePromise = null;
const staticCache = () => (staticCachePromise ??= caches.open(STATIC_CACHE));

/* Install caches the whole app, not just the page. The page's own script and
   stylesheet are fetched before this worker exists, so nothing else would store
   them until a later online launch — a first install followed by no signal
   opened on a blank screen. If the latest build cannot be fetched in full, the
   install fails and the browser tries again on the next load. */
self.addEventListener('install', (event) => {
  event.waitUntil(
    staticCache()
      .then((c) => c.addAll(PRECACHE))
      .then(refreshShell)
      .then((html) => {
        if (!html) throw new Error('index.html unavailable');
        return self.skipWaiting();
      })
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

const htmlResponse = (html) =>
  new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });

/* Fetch the latest index.html and make it the shell the next load is served.
   Resolves to its text, or null if the server answered with an error.

   `no-cache` because GitHub Pages marks every file fresh for ten minutes, and
   a plain fetch would quietly hand back the browser's own copy of the old page
   for that long — that was a large part of why a deploy took several reopens
   to appear. `no-cache` still lets an unchanged page come back as a tiny 304.

   The new build's script and stylesheet are cached *before* the shell is
   swapped over. Swapping first meant a phone that updated its shell and then
   lost signal opened on a page whose script it had never downloaded: a blank
   app on a hill. Shared between the launch refresh and the page's own check so
   the two do not download the same build twice at once.

   When the shell did change, older builds are evicted (see evictOldBuilds). */
let refreshing = null;
function refreshShell() {
  return (refreshing ??= (async () => {
    const res = await fetch('./index.html', { cache: 'no-cache' });
    if (!res.ok) return null;
    const html = await res.text();
    const cache = await staticCache();
    const assets = [...html.matchAll(/(?:src|href)="(\.\/assets\/[^"]+)"/g)].map((m) => m[1]);
    await Promise.all(
      assets.map(async (a) => {
        if (await cache.match(a)) return;
        const r = await fetch(a);
        if (!r.ok) throw new Error(`${a}: ${r.status}`);
        await cache.put(a, r);
      })
    );
    const previous = await cache.match('./index.html');
    const previousHtml = previous ? await previous.text() : null;
    await cache.put('./index.html', htmlResponse(html));
    // Cleanup only: a failure here must not undo an update that already landed.
    if (previousHtml !== html) await evictOldBuilds(cache, [html, previousHtml]).catch(() => {});
    return html;
  })().finally(() => {
    refreshing = null;
  }));
}

const ASSETS_URL = new URL('./assets/', self.location).href;

/* Relative file names quoted in a page, script or stylesheet: the page's
   `./assets/…` src and href, and the `./name-hash.js` a script imports lazily
   (the QR decoder is named nowhere else, so it has to be found here). */
const referencedFiles = (text, base) =>
  [...text.matchAll(/["'(](\.\/[\w./-]+\.(?:js|css|png|jpe?g|svg|webp|woff2?))["')]/g)].map(
    (m) => new URL(m[1], base).href
  );

/* Delete every cached file under assets/ that neither the new build nor the one
   before it refers to, directly or through a script it loads. Vite names each
   file after a hash of its contents, so without this every deploy left a full
   copy of the app behind for good.

   The build before is kept because a page may still be running it. A launch
   is served the cached (old) page while this refresh runs, so that page's
   script and stylesheet requests can arrive after the eviction. And an app
   brought back to the foreground finds the deploy and offers "Update ready",
   but until that is tapped it is the old script, which can still lazily load
   its own copy of the QR decoder — already removed from the server by the
   deploy. Two builds at most, a few hundred KB. Nothing outside assets/ (the
   page, the manifest, the icons) is ever touched. */
async function evictOldBuilds(cache, shells) {
  const keep = new Set();
  const pending = shells.filter(Boolean).flatMap((html) => referencedFiles(html, self.location.href));
  while (pending.length) {
    const url = pending.pop();
    if (keep.has(url)) continue;
    keep.add(url);
    const hit = /\.(js|css)$/.test(url) && (await cache.match(url));
    if (hit) pending.push(...referencedFiles(await hit.text(), url));
  }
  const stale = (await cache.keys()).filter((r) => r.url.startsWith(ASSETS_URL) && !keep.has(r.url));
  await Promise.all(stale.map((r) => cache.delete(r)));
}

/* The page asks this on launch and whenever it comes back to the foreground —
   an iPhone often only pauses a "closed" app, and resuming loads nothing, so
   no launch refresh ever runs. Replies with the latest build's entry script;
   the page compares it with the one it is running. */
self.addEventListener('message', (event) => {
  const port = event.ports[0];
  if (event.data?.type !== 'check-update' || !port) return;
  event.waitUntil(
    refreshShell()
      .catch(() => null)
      .then((html) => {
        const m = html && html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/);
        port.postMessage({ entry: m ? m[1] : null });
      })
  );
});

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
  // map paints without waiting on the network, and refresh it in the background.
  // The page then asks (see the message handler) whether that refresh found a
  // newer build, and reloads onto it. Falls back to the network on a cold
  // cache, and errors only when both are unavailable (truly offline first run).
  if (req.mode === 'navigate' && url.origin === self.location.origin) {
    const update = refreshShell().catch(() => null);
    // Keep the worker alive until the background refresh finishes.
    event.waitUntil(update);
    event.respondWith(
      staticCache().then(async (cache) => {
        const cached = await cache.match('./index.html');
        if (cached) return cached;
        const html = await update;
        if (html) return htmlResponse(html);
        throw new Error('offline');
      })
    );
    return;
  }

  // Other same-origin files (hashed JS/CSS, icons): stale-while-revalidate.
  if (url.origin === self.location.origin) {
    event.respondWith(
      staticCache().then(async (cache) => {
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
