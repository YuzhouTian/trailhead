// What Trailhead has put on this phone, and the one button that takes it back.
//
// Only map tiles are dealt with here. Routes, pins and settings live in
// localStorage, are a few kilobytes between them, and already have their own
// delete buttons in the Routes panel — it is the tile cache that grows to
// hundreds of megabytes with nothing in the app admitting it exists.
//
// Deliberately free of the DOM: this module answers "how much, and take it
// away", and ui/panels.ts decides how to say it.

/**
 * Cache Storage buckets holding map tiles. Matched by prefix rather than by the
 * exact name in public/sw.js: that name carries a version which is bumped
 * whenever bad tiles need discarding, and a prefix match both survives the next
 * bump without an edit here and sweeps up what an older version left behind.
 */
const TILE_CACHE_PREFIX = 'trailhead-tiles';

export interface OfflineUsage {
  /** Tiles held across every tile cache. */
  tiles: number;
  /**
   * Bytes for *everything* this app has stored — tiles, app shell, routes, the
   * lot — as the browser reports it. Null when it won't say. There is no
   * per-tile figure to be had: the default layer's tiles arrive opaque, so
   * their size is hidden from us, and this whole-origin estimate is the only
   * real number available.
   */
  bytes: number | null;
}

/** The tile caches currently on the device, newest naming scheme or older. */
async function tileCacheNames(): Promise<string[]> {
  if (typeof caches === 'undefined') return [];
  try {
    return (await caches.keys()).filter((name) => name.startsWith(TILE_CACHE_PREFIX));
  } catch {
    // Cache Storage is unavailable in some private-browsing modes. Nothing is
    // stored in that case either, so "none" is the honest answer.
    return [];
  }
}

/** How much map is saved, and how much room the app is taking up overall. */
export async function offlineUsage(): Promise<OfflineUsage> {
  let tiles = 0;
  for (const name of await tileCacheNames()) {
    const cache = await caches.open(name);
    tiles += (await cache.keys()).length;
  }

  let bytes: number | null = null;
  try {
    const est = await navigator.storage?.estimate?.();
    if (typeof est?.usage === 'number') bytes = est.usage;
  } catch {
    // Some browsers refuse the estimate rather than returning one. The tile
    // count above is still true, so report that and leave the size out.
  }
  return { tiles, bytes };
}

/**
 * Delete every saved tile. Returns how many went.
 *
 * Entries are removed one by one rather than with `caches.delete(name)`, which
 * would be faster but breaks the service worker: it holds a single open handle
 * to the tile cache for the life of the worker (public/sw.js), and deleting the
 * bucket leaves that handle pointing at nothing — every tile fetched afterwards
 * would be written into a cache that no longer exists, so the map would quietly
 * stop caching until the worker next restarted. Emptying the bucket in place
 * keeps that handle good.
 */
export async function clearOfflineTiles(): Promise<number> {
  let removed = 0;
  for (const name of await tileCacheNames()) {
    const cache = await caches.open(name);
    const keys = await cache.keys();
    await Promise.all(keys.map((key) => cache.delete(key)));
    removed += keys.length;
  }
  return removed;
}

/**
 * Bytes as a phone would put it. Decimal units rather than binary ones, so the
 * figure can be compared with what iOS itself shows under Settings → Storage
 * without the two disagreeing by a tenth.
 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e5) return '0.1 MB';
  return 'less than 0.1 MB';
}
