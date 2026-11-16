// The service worker, exercised in Node.
//
// public/sw.js is a plain script, not a module: the browser loads it as a
// worker and it registers handlers against `self`, so there is nothing to
// import. The harness below runs its source with stub globals and dispatches
// events at whatever it registered — as close to a browser as this gets
// without one.
//
// Worth the awkwardness. The behaviour tested here only shows itself across a
// deploy, on a phone, with a map already downloaded; a regression there would
// be found by a walker with no signal, not by anyone at a keyboard.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Imported as text, the way the other tests take index.html and the routing
// profile, so the worker runs here as the same bytes a phone is served.
import SOURCE from '../public/sw.js?raw';

// The current bucket's name is deliberately never named here. It carries a
// version that gets bumped, and a test that knows the name would need an edit
// on every bump — so each one below asks what the worker *does* instead: serve
// this tile, save that one, forget the other.

/** A bucket left behind by an earlier version of the worker. v1 is history and
 *  can never be the current name again, so it stands in for "whatever the last
 *  bump replaced" without this file caring what that was. */
const OLD_TILE_CACHE = 'trailhead-tiles-v1';

const SCOPE = 'https://example.test/trailhead/';
const TILE = 'https://outdoor.tiles.freemap.sk/16/32416/21814.jpeg';

// --------------------------------------------------------------- cache stubs

/** Cache Storage keys entries by request URL; both a string and a Request are
 *  accepted wherever one is, exactly as the real thing does. */
const urlOf = (req: string | Request): string =>
  typeof req === 'string' ? new URL(req, SCOPE).href : req.url;

class FakeCache {
  readonly entries = new Map<string, Response>();

  async match(req: string | Request): Promise<Response | undefined> {
    return this.entries.get(urlOf(req))?.clone();
  }

  async put(req: string | Request, res: Response): Promise<void> {
    this.entries.set(urlOf(req), res);
  }

  async delete(req: string | Request): Promise<boolean> {
    return this.entries.delete(urlOf(req));
  }

  async addAll(urls: string[]): Promise<void> {
    for (const u of urls) this.entries.set(urlOf(u), new Response(''));
  }

  async keys(): Promise<{ url: string }[]> {
    return [...this.entries.keys()].map((url) => ({ url }));
  }
}

class FakeCacheStorage {
  readonly buckets = new Map<string, FakeCache>();

  async open(name: string): Promise<FakeCache> {
    let cache = this.buckets.get(name);
    if (!cache) this.buckets.set(name, (cache = new FakeCache()));
    return cache;
  }

  async keys(): Promise<string[]> {
    return [...this.buckets.keys()];
  }

  async delete(name: string): Promise<boolean> {
    return this.buckets.delete(name);
  }
}

// -------------------------------------------------------------- the harness

interface Worker {
  /** Dispatch `install` and wait for it; rejects if the install failed. */
  install(): Promise<void>;
  /** Open the app: a page load, answered with the page the worker serves. Waits
   *  for the background refresh the launch sets off. */
  launch(): Promise<Response>;
  /** Dispatch `activate` and wait for the work it took on. */
  activate(): Promise<void>;
  /** Dispatch `fetch` and return what the worker answered with. */
  fetch(url: string): Promise<Response>;
  caches: FakeCacheStorage;
  fetchStub: ReturnType<typeof vi.fn>;
}

/** Run public/sw.js with stub globals and hand back its handlers. */
function boot(): Worker {
  const listeners = new Map<string, (event: unknown) => void>();
  const caches = new FakeCacheStorage();
  // Tiles come back from the network unless a test says otherwise.
  const fetchStub = vi.fn(async () => new Response('fresh tile'));
  const self = {
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    location: new URL('sw.js', SCOPE),
    clients: { claim: async () => {} },
    skipWaiting: async () => {}
  };

  new Function('self', 'caches', 'fetch', SOURCE)(self, caches, fetchStub);

  const dispatch = (type: string, event: unknown) => {
    const fn = listeners.get(type);
    if (!fn) throw new Error(`the worker registered no ${type} handler`);
    fn(event);
  };

  return {
    caches,
    fetchStub,
    async install() {
      let work: Promise<unknown> = Promise.resolve();
      dispatch('install', { waitUntil: (p: Promise<unknown>) => (work = p) });
      await work;
    },
    async launch() {
      let answer: Promise<Response> | undefined;
      const waits: Promise<unknown>[] = [];
      dispatch('fetch', {
        // Node's Request refuses mode 'navigate', which only a browser may
        // set, so the worker is handed the three fields it reads.
        request: { method: 'GET', url: SCOPE, mode: 'navigate' },
        respondWith: (p: Promise<Response>) => (answer = p),
        waitUntil: (p: Promise<unknown>) => waits.push(p)
      });
      if (!answer) throw new Error('the worker did not answer the page load');
      const res = await answer;
      await Promise.all(waits);
      return res;
    },
    async activate() {
      let work: Promise<unknown> = Promise.resolve();
      dispatch('activate', { waitUntil: (p: Promise<unknown>) => (work = p) });
      await work;
    },
    async fetch(url: string) {
      let answer: Promise<Response> | undefined;
      const waits: Promise<unknown>[] = [];
      dispatch('fetch', {
        request: new Request(url),
        respondWith: (p: Promise<Response>) => (answer = p),
        waitUntil: (p: Promise<unknown>) => waits.push(p)
      });
      if (!answer) throw new Error(`the worker did not answer ${url}`);
      const res = await answer;
      await Promise.all(waits.map((p) => p.catch(() => {})));
      return res;
    }
  };
}

/** Put a tile in a bucket as a previous version of the worker would have. */
async function saveTile(w: Worker, bucket: string, body: string): Promise<void> {
  await (await w.caches.open(bucket)).put(TILE, new Response(body));
}

const bodies = async (cache: FakeCache | undefined): Promise<string[]> =>
  cache ? Promise.all([...cache.entries.values()].map((r) => r.clone().text())) : [];

// ------------------------------------------------------------------- tests

describe('service worker tile cache', () => {
  let w: Worker;

  beforeEach(() => {
    w = boot();
  });

  describe('after the tile cache version is bumped', () => {
    // The bug this file was written for: the bump was the only way to discard
    // bad tiles, and it took a deliberately downloaded map with it.
    it('still serves a tile saved under the old name when the network is gone', async () => {
      await saveTile(w, OLD_TILE_CACHE, 'downloaded tile');
      w.fetchStub.mockRejectedValue(new Error('offline'));
      await w.activate();

      const res = await w.fetch(TILE);

      expect(await res.text()).toBe('downloaded tile');
    });

    it('replaces that tile with a fresh one the first time it is viewed online', async () => {
      await saveTile(w, OLD_TILE_CACHE, 'stale tile');
      await w.activate();

      expect(await (await w.fetch(TILE)).text()).toBe('fresh tile');

      // Saved, not merely passed through: the same tile with the network gone
      // comes back fresh rather than stale.
      w.fetchStub.mockRejectedValue(new Error('offline'));
      expect(await (await w.fetch(TILE)).text()).toBe('fresh tile');
    });

    it('drops the stale copy as the fresh one lands, leaving one map on the phone', async () => {
      await saveTile(w, OLD_TILE_CACHE, 'stale tile');
      await w.activate();

      await w.fetch(TILE);

      expect(await bodies(w.caches.buckets.get(OLD_TILE_CACHE))).toEqual([]);
    });

    it('serves a saved tile when the server answers with an error', async () => {
      await saveTile(w, OLD_TILE_CACHE, 'downloaded tile');
      w.fetchStub.mockResolvedValue(new Response('nope', { status: 500 }));
      await w.activate();

      expect(await (await w.fetch(TILE)).text()).toBe('downloaded tile');
    });
  });

  it('serves a tile it already holds without going to the network', async () => {
    await w.fetch(TILE);
    w.fetchStub.mockClear();

    const res = await w.fetch(TILE);

    expect(await res.text()).toBe('fresh tile');
    expect(w.fetchStub).not.toHaveBeenCalled();
  });

  describe('activate', () => {
    it('keeps a tile bucket that still holds a map, and clears out what is not ours', async () => {
      await saveTile(w, OLD_TILE_CACHE, 'downloaded tile');
      await w.caches.open('leftover-cache');

      await w.activate();

      expect(await w.caches.keys()).toContain(OLD_TILE_CACHE);
      expect(await w.caches.keys()).not.toContain('leftover-cache');
    });

    it('drops an old tile bucket once it has given up every tile', async () => {
      await w.caches.open(OLD_TILE_CACHE);

      await w.activate();

      expect(await w.caches.keys()).not.toContain(OLD_TILE_CACHE);
    });
  });
});

// ---------------------------------------------------------------- app shell

/** A deployed build, as the files a server would hand out. The names are what
 *  Vite produces: the page names its script and stylesheet, and the script
 *  names the QR decoder it only loads when the scanner is opened. */
function build(tag: string): Record<string, string> {
  return {
    'index.html':
      `<script type="module" crossorigin src="./assets/index-${tag}.js"></script>` +
      `<link rel="stylesheet" crossorigin href="./assets/index-${tag}.css">`,
    [`assets/index-${tag}.css`]: 'body{}',
    // "./sw.js" is in the real script too, where the page registers this
    // worker. Read as a file next to the script, it names one that isn't there.
    [`assets/index-${tag}.js`]:
      `import("./jsQR-${tag}.js");navigator.serviceWorker.register("./sw.js")`,
    [`assets/jsQR-${tag}.js`]: `import"./index-${tag}.js";/* decoder ${tag} */`
  };
}

const pathOf = (req: unknown): string => urlOf(req as string | Request).slice(SCOPE.length);

/** Make the network serve these files and nothing else. */
function deploy(w: Worker, files: Record<string, string>): void {
  w.fetchStub.mockImplementation(async (...args: unknown[]) => {
    const path = pathOf(args[0]);
    return path in files ? new Response(files[path]) : new Response('', { status: 404 });
  });
}

/** Every file the worker holds for offline use, as paths under the app. */
async function held(w: Worker): Promise<string[]> {
  const urls: string[] = [];
  for (const [name, cache] of w.caches.buckets) {
    if (!name.startsWith('trailhead-tiles')) urls.push(...cache.entries.keys());
  }
  return urls.map((u) => u.slice(SCOPE.length)).sort();
}

describe('service worker app shell', () => {
  let w: Worker;

  beforeEach(() => {
    w = boot();
  });

  // #142: the decoder is fetched the first time the scanner is opened, so a
  // phone that had never scanned online could not scan on a hill.
  it('holds the QR decoder after install, before the scanner is ever opened', async () => {
    deploy(w, build('one'));

    await w.install();

    expect(await held(w)).toContain('assets/jsQR-one.js');
  });

  // How the fix reaches a phone that already has the app: the worker file
  // changed, so it installs again, over a build stored without its decoder.
  it('fetches the decoder on install when the build is already held without it', async () => {
    deploy(w, build('one'));
    await w.install();
    for (const cache of w.caches.buckets.values()) await cache.delete('assets/jsQR-one.js');

    await w.install();

    expect(await held(w)).toContain('assets/jsQR-one.js');
  });

  it('installs even though the script quotes a name that is not a file', async () => {
    deploy(w, build('one'));

    await expect(w.install()).resolves.toBeUndefined();

    expect(await held(w)).not.toContain('assets/sw.js');
  });

  it("holds the new build's decoder once a launch has picked up a deploy", async () => {
    deploy(w, build('one'));
    await w.install();
    deploy(w, build('two'));

    await w.launch();

    expect(await held(w)).toContain('assets/jsQR-two.js');
  });

  it('stays on the old build when the new decoder cannot be fetched', async () => {
    deploy(w, build('one'));
    await w.install();
    const two = build('two');
    w.fetchStub.mockImplementation(async (...args: unknown[]) => {
      const path = pathOf(args[0]);
      if (path === 'assets/jsQR-two.js') throw new Error('signal dropped');
      return new Response(two[path]);
    });
    await w.launch();

    // The next launch must not be a new page whose scanner cannot load.
    w.fetchStub.mockRejectedValue(new Error('offline'));
    const page = await w.launch();

    expect(await page.text()).toBe(build('one')['index.html']);
  });

  it('asks the network for nothing but the page on a launch with no deploy', async () => {
    deploy(w, build('one'));
    await w.install();
    w.fetchStub.mockClear();

    await w.launch();

    expect(w.fetchStub.mock.calls.map(([req]) => pathOf(req))).toEqual(['index.html']);
  });
});
