// The offline-maps figures, and what "clear" actually leaves behind.
//
// A fake Cache Storage stands in for the browser's: the interesting behaviour
// here isn't tile fetching, it's which buckets get counted and whether the
// service worker is told to let go of its handle when a bucket is deleted.

import { beforeEach, describe, expect, it } from 'vitest';
import { clearOfflineTiles, formatBytes, offlineUsage } from './storage';

/** Just enough of the Cache API for the two things storage.ts does with it. */
class FakeCache {
  constructor(public entries: string[]) {}
  async keys() {
    return [...this.entries];
  }
  async delete(key: string) {
    const i = this.entries.indexOf(key);
    if (i < 0) return false;
    this.entries.splice(i, 1);
    return true;
  }
}

let buckets: Map<string, FakeCache>;

function installCaches(contents: Record<string, string[]>) {
  buckets = new Map(Object.entries(contents).map(([k, v]) => [k, new FakeCache(v)]));
  Object.defineProperty(globalThis, 'caches', {
    value: {
      keys: async () => [...buckets.keys()],
      open: async (name: string) => buckets.get(name) ?? new FakeCache([]),
      delete: async (name: string) => buckets.delete(name)
    },
    configurable: true
  });
}

function installEstimate(usage: number | undefined) {
  Object.defineProperty(globalThis, 'navigator', {
    value: { storage: { estimate: async () => ({ usage }) } },
    configurable: true
  });
}

/** A page under a service worker, recording what it is told. */
function installWorker(): unknown[] {
  const told: unknown[] = [];
  Object.defineProperty(globalThis, 'navigator', {
    value: { serviceWorker: { controller: { postMessage: (m: unknown) => told.push(m) } } },
    configurable: true
  });
  return told;
}

const tiles = (n: number, z = 14) =>
  Array.from({ length: n }, (_, i) => `https://tiles.freemap.sk/T/${z}/100/${i}.jpeg`);

beforeEach(() => {
  installCaches({
    'trailhead-static-v1': ['./index.html', './'],
    'trailhead-tiles-v3': tiles(30)
  });
  installEstimate(412_000_000);
});

describe('offlineUsage', () => {
  it('counts tiles and leaves the app shell out of it', async () => {
    expect(await offlineUsage()).toEqual({ tiles: 30, bytes: 412_000_000 });
  });

  it('counts tiles left behind by an older cache version', async () => {
    // public/sw.js bumps its cache name to discard bad tiles, and the old
    // bucket is only deleted on the next activate. Until then it is still
    // taking up room, so it still has to be counted — and cleared.
    installCaches({
      'trailhead-tiles-v2': tiles(12, 13),
      'trailhead-tiles-v3': tiles(30)
    });
    expect((await offlineUsage()).tiles).toBe(42);
  });

  it('still reports the tile count when the browser will not estimate', async () => {
    installEstimate(undefined);
    expect(await offlineUsage()).toEqual({ tiles: 30, bytes: null });
  });

  it('reports nothing stored when Cache Storage is unavailable', async () => {
    Object.defineProperty(globalThis, 'caches', { value: undefined, configurable: true });
    expect((await offlineUsage()).tiles).toBe(0);
  });
});

describe('clearOfflineTiles', () => {
  it('deletes every tile bucket whole, and tells the service worker to let go', async () => {
    installCaches({
      'trailhead-static-v1': ['./index.html'],
      'trailhead-tiles-v2': tiles(12, 13),
      'trailhead-tiles-v3': tiles(30)
    });
    const told = installWorker();
    expect(await clearOfflineTiles()).toBe(42);
    expect((await offlineUsage()).tiles).toBe(0);
    // Gone in one go rather than entry by entry, which took minutes for
    // gigabytes. The worker then drops its handle to the deleted bucket, or
    // every tile it saved afterwards would be lost.
    expect([...buckets.keys()]).toEqual(['trailhead-static-v1']);
    expect(told).toEqual([{ type: 'tiles-cleared' }]);
    // And the app shell is untouched.
    expect(buckets.get('trailhead-static-v1')!.entries).toEqual(['./index.html']);
  });

  it('is a no-op when there is nothing saved', async () => {
    installCaches({ 'trailhead-static-v1': ['./'] });
    expect(await clearOfflineTiles()).toBe(0);
  });
});

describe('formatBytes', () => {
  it('reads the way a phone puts it', () => {
    expect(formatBytes(412_000_000)).toBe('412 MB');
    expect(formatBytes(1_400_000_000)).toBe('1.4 GB');
    expect(formatBytes(2_000_000)).toBe('2 MB');
    expect(formatBytes(120_000)).toBe('0.1 MB');
    expect(formatBytes(400)).toBe('less than 0.1 MB');
  });
});
