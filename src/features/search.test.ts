// @vitest-environment jsdom

// The search box and Nearby, as the walker drives them. What the search
// engine finds is src/search.ts's question and tested there; this is the
// other half — when a query goes out, what the list shows, what a tap on a
// hit does to the map, and how a Nearby category gets on and off the map
// while its query is still out.
//
// Both kinds of slow answer are held until the test lets them go, because the
// cases worth testing are the ones where the walker moves first: typing over a
// search in flight, a refined list arriving after a place has been picked,
// unticking a category before its markers come back.

import indexHtml from '../../index.html?raw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nearbyBox, type Poi } from '../poi';
import type { SearchHit, SearchOptions } from '../search';
import type { Settings } from '../state';

const leaflet = vi.hoisted(async () => {
  const { createLeafletStub } = await import('../testing/leaflet-stub');
  return createLeafletStub();
});

/** The GPS fix tracking hands out, as each test wants it. */
const gps = vi.hoisted(() => ({ fix: null as [number, number] | null }));

vi.mock('../leaflet-setup', async () => ({ default: (await leaflet).L }));
vi.mock('../map/map', async () => ({ map: (await leaflet).map }));
// The card a hit opens is pins.ts's, tested there; here it only matters what
// it was asked to open.
vi.mock('./pins', () => ({ PLAN_PASS_THROUGH: 'planPassThrough', openNewPin: vi.fn() }));
vi.mock('./tracking', () => ({ getLastFix: () => gps.fix, pauseFollow: vi.fn() }));
vi.mock('../search', () => ({ search: vi.fn() }));
// The real category table and box arithmetic; only the network is held.
vi.mock('../poi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../poi')>()),
  fetchPois: vi.fn()
}));

type Spot = [lat: number, lng: number];

const GLENRIDDING: Spot = [54.544, -2.95];
const HELVELLYN: Spot = [54.5271, -3.0164];

const hit = (name: string, pos: Spot, detail = 'Cumbria'): SearchHit => ({ name, detail, pos });

/** The search box, its list, and what a hit opens over — from index.html. */
const PAGE = (() => {
  const doc = new DOMParser().parseFromString(indexHtml, 'text/html');
  return ['searchInput', 'searchClear', 'searchResults', 'pinCard', 'toast']
    .map((id) => doc.getElementById(id)!.outerHTML)
    .join('');
})();

let stub: Awaited<typeof leaflet>;

/** A search the module has asked for and the test has not answered yet. */
interface Asked {
  query: string;
  opts: SearchOptions;
  answer: (hits: SearchHit[]) => Promise<void>;
  fail: (e: Error) => Promise<void>;
}

/** A Nearby query out, likewise. */
interface Looking {
  box: Parameters<typeof nearbyBox>[0];
  kind: string;
  signal: AbortSignal;
  answer: (pois: Poi[]) => Promise<void>;
  fail: (e: Error) => Promise<void>;
}

let asked: Asked[];
let looking: Looking[];

/**
 * A search module with nothing behind it. The reset matters: the search pin,
 * the Nearby layers and the said-it-once flag for OS are module state.
 */
async function boot() {
  vi.resetModules();
  document.body.innerHTML = PAGE;
  document.documentElement.style.removeProperty('--plan-lift');
  stub.reset();
  gps.fix = null;
  asked = [];
  looking = [];

  const mod = await import('./search');
  // Fetched after the reset: the instances the fresh module will call.
  const { search } = await import('../search');
  const { fetchPois } = await import('../poi');
  const { openNewPin } = await import('./pins');
  const { pauseFollow } = await import('./tracking');

  // Each answer lets the module's own awaits run out before the test goes on.
  const settle = async () => { await vi.advanceTimersByTimeAsync(0); };
  vi.mocked(search).mockImplementation(
    (query, opts = {}) =>
      new Promise((resolve, reject) => {
        // A real search gives up the moment it is called off.
        opts.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        asked.push({
          query,
          opts,
          answer: (hits) => (resolve(hits), settle()),
          fail: (e) => (reject(e), settle())
        });
      })
  );
  vi.mocked(fetchPois).mockImplementation(
    (box, kind, signal) =>
      new Promise((resolve, reject) => {
        looking.push({
          box,
          kind,
          signal: signal!,
          answer: (pois) => (resolve(pois), settle()),
          fail: (e) => (reject(e), settle())
        });
      })
  );

  const settings = { osKey: '' } as Settings;
  mod.initSearch({ settings });
  const $ = (id: string) => document.getElementById(id)!;
  const shown = (id: string) => !$(id).classList.contains('hidden');
  return {
    mod,
    settings,
    search: vi.mocked(search),
    openNewPin: vi.mocked(openNewPin),
    pauseFollow: vi.mocked(pauseFollow),
    $,
    shown,
    toast: () => $('toast').textContent,
    toastUp: () => shown('toast'),
    /** Type into the box: every keystroke is an input event. */
    type(text: string) {
      ($('searchInput') as HTMLInputElement).value = text;
      $('searchInput').dispatchEvent(new Event('input'));
    },
    /** Let the box's pause after the last keystroke run out. */
    pause: () => vi.advanceTimersByTimeAsync(400),
    /** The rows in the results list, as shown. */
    rows: () => [...$('searchResults').querySelectorAll<HTMLElement>('.hit')],
    names: () => [...$('searchResults').querySelectorAll('.n')].map((n) => n.textContent),
    /** The pin a picked hit leaves on the map. */
    get pin() {
      return stub.map.layers.find((l) => String((l.options.icon as { html?: string })?.html).includes('searchPin'));
    },
    get groups() {
      return stub.map.layers.filter((l) => l.kind === 'group');
    }
  };
}

/** Type, wait out the pause, and answer the search with `hits`. */
async function searchFor(t: Awaited<ReturnType<typeof boot>>, text: string, hits: SearchHit[]) {
  t.type(text);
  await t.pause();
  await asked[asked.length - 1].answer(hits);
}

beforeEach(async () => {
  stub = await leaflet;
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('typing a search', () => {
  it('asks once the typing stops, for what the box says by then', async () => {
    const t = await boot();
    t.type('He');
    await vi.advanceTimersByTimeAsync(300);
    t.type('Helv');
    await vi.advanceTimersByTimeAsync(300);
    t.type('Helvellyn');
    expect(t.search).not.toHaveBeenCalled();
    await t.pause();
    expect(t.search).toHaveBeenCalledOnce();
    expect(asked[0].query).toBe('Helvellyn');
  });

  it('asks nothing for one letter, and puts the list away', async () => {
    const t = await boot();
    await searchFor(t, 'Helvellyn', [hit('Helvellyn', HELVELLYN)]);
    expect(t.shown('searchResults')).toBe(true);

    t.type(' H ');
    await t.pause();
    expect(t.search).toHaveBeenCalledOnce();
    expect(t.shown('searchResults')).toBe(false);
  });

  it('shows the clear button only while there is something to clear', async () => {
    const t = await boot();
    t.type('H');
    expect(t.shown('searchClear')).toBe(true);
    t.type('');
    expect(t.shown('searchClear')).toBe(false);
  });

  it('searches near the GPS fix, or the middle of the map without one', async () => {
    const t = await boot();
    stub.map.center = HELVELLYN;
    t.type('Red Tarn');
    await t.pause();
    expect(asked[0].opts.near).toEqual(HELVELLYN);

    gps.fix = GLENRIDDING;
    t.type('Red Tarn ');
    await t.pause();
    expect(asked[1].opts.near).toEqual(GLENRIDDING);
  });

  it('uses the OS key as it is when the search goes out, not when the box was wired', async () => {
    const t = await boot();
    t.settings.osKey = 'K3Y';
    t.type('Helvellyn');
    await t.pause();
    expect(asked[0].opts.osKey).toBe('K3Y');
  });

  it('calls off a search in flight when you type over it, and says nothing of it', async () => {
    const t = await boot();
    t.type('Helv');
    await t.pause();
    t.type('Helvellyn');
    expect(asked[0].opts.signal!.aborted).toBe(true);
    await t.pause();
    await asked[1].answer([hit('Helvellyn', HELVELLYN)]);
    expect(t.names()).toEqual(['Helvellyn']);
    expect(t.toastUp()).toBe(false);
  });

  it('says so when a search fails', async () => {
    const t = await boot();
    t.type('Helvellyn');
    await t.pause();
    await asked[0].fail(new Error('HTTP 503'));
    expect(t.toast()).toBe('Search failed: HTTP 503');
  });
});

describe('the results list', () => {
  it('lists each hit with its detail, written as text', async () => {
    const t = await boot();
    await searchFor(t, 'tarn', [hit('Red Tarn', HELVELLYN), hit('<i>Grisedale</i> Tarn', GLENRIDDING, 'Lake <District>')]);
    expect(t.names()).toEqual(['Red Tarn', '<i>Grisedale</i> Tarn']);
    expect(t.rows()[1].querySelector('.d')!.textContent).toBe('Lake <District>');
    expect(t.$('searchResults').querySelector('i')).toBeNull();
  });

  it('says there are no matches rather than showing nothing', async () => {
    const t = await boot();
    await searchFor(t, 'xyzzy', []);
    expect(t.shown('searchResults')).toBe(true);
    expect(t.$('searchResults').textContent).toBe('No matches');
  });

  it('takes a better order when one arrives, while the list is still up', async () => {
    const t = await boot();
    await searchFor(t, 'tarn', [hit('Red Tarn', HELVELLYN), hit('Grisedale Tarn', GLENRIDDING)]);
    asked[0].opts.onRefine!([hit('Grisedale Tarn', GLENRIDDING), hit('Red Tarn', HELVELLYN)]);
    expect(t.names()).toEqual(['Grisedale Tarn', 'Red Tarn']);
  });

  it('does not pop back open for a better order once a place is picked', async () => {
    const t = await boot();
    await searchFor(t, 'tarn', [hit('Red Tarn', HELVELLYN)]);
    t.rows()[0].click();
    asked[0].opts.onRefine!([hit('Red Tarn', HELVELLYN)]);
    expect(t.shown('searchResults')).toBe(false);
  });

  it('does not draw a better order for a search already typed over', async () => {
    const t = await boot();
    await searchFor(t, 'tarn', [hit('Red Tarn', HELVELLYN)]);
    t.type('tarns');
    asked[0].opts.onRefine!([hit('Stale', GLENRIDDING)]);
    expect(t.names()).toEqual(['Red Tarn']);
  });

  it('tells you once a session that OS refused the key, not on every search', async () => {
    const t = await boot();
    await searchFor(t, 'tarn', []);
    asked[0].opts.onOsRejected!(401);
    expect(t.toast()).toMatch(/^OS Names refused the key/);

    t.$('toast').textContent = '';
    await searchFor(t, 'tarns', []);
    asked[1].opts.onOsRejected!(401);
    expect(t.toast()).toBe('');
  });
});

describe('picking a hit', () => {
  it('stops following before it moves the map, so the next fix cannot pull it back', async () => {
    const t = await boot();
    let movesBeforePause = -1;
    t.pauseFollow.mockImplementation(() => { movesBeforePause = stub.map.views.length; });
    await searchFor(t, 'Helvellyn', [hit('Helvellyn', HELVELLYN)]);
    t.rows()[0].click();
    expect(movesBeforePause).toBe(0);
    expect(stub.map.views).toEqual([{ center: HELVELLYN, zoom: 15, options: { animate: false } }]);
  });

  it('keeps the map closer in than 15 if it already is', async () => {
    const t = await boot();
    stub.map.zoom = 17;
    await searchFor(t, 'Helvellyn', [hit('Helvellyn', HELVELLYN)]);
    t.rows()[0].click();
    expect(stub.map.views[0].zoom).toBe(17);
  });

  it("drops its own pin, opens the place's card without a second one, and puts the list away", async () => {
    const t = await boot();
    await searchFor(t, 'Helvellyn', [hit('Helvellyn', HELVELLYN)]);
    t.rows()[0].click();
    expect(t.pin?.latlng).toEqual(HELVELLYN);
    expect((t.pin!.options.icon as { className: string }).className).toBe('planPassThrough');
    expect(t.openNewPin).toHaveBeenCalledWith(...HELVELLYN, { name: 'Helvellyn', marker: false });
    expect(t.shown('searchResults')).toBe(false);
  });

  it('brings the card back when its pin is tapped again', async () => {
    const t = await boot();
    await searchFor(t, 'Helvellyn', [hit('Helvellyn', HELVELLYN)]);
    t.rows()[0].click();
    t.openNewPin.mockClear();
    t.pin!.fire('click');
    expect(t.openNewPin).toHaveBeenCalledWith(...HELVELLYN, { name: 'Helvellyn', marker: false });
  });

  it('moves the pin to the next place picked rather than leaving one at each', async () => {
    const t = await boot();
    await searchFor(t, 'Helvellyn', [hit('Helvellyn', HELVELLYN)]);
    t.rows()[0].click();
    await searchFor(t, 'Glenridding', [hit('Glenridding', GLENRIDDING)]);
    t.rows()[0].click();
    const pins = stub.map.layers.filter((l) => l.kind === 'marker');
    expect(pins.map((p) => p.latlng)).toEqual([GLENRIDDING]);
  });

  describe('with the bottom of the map covered', () => {
    /** Lay the map out as a phone would: a map 800 px tall, the card from `cardTop`. */
    function layout(t: Awaited<ReturnType<typeof boot>>, cardTop: number) {
      stub.map.getContainer().getBoundingClientRect = () => ({ top: 0, bottom: 800 }) as DOMRect;
      t.$('pinCard').getBoundingClientRect = () => ({ top: cardTop }) as DOMRect;
    }

    it('centres the place above the card it opened', async () => {
      const t = await boot();
      layout(t, 560);
      await searchFor(t, 'Helvellyn', [hit('Helvellyn', HELVELLYN)]);
      t.rows()[0].click();
      expect(stub.map.pans).toEqual([[0, 120]]);
    });

    it('centres it above the plan sheet while planning', async () => {
      const t = await boot();
      layout(t, 0); // the card is hidden while planning
      document.documentElement.style.setProperty('--plan-lift', '300px');
      await searchFor(t, 'Helvellyn', [hit('Helvellyn', HELVELLYN)]);
      t.rows()[0].click();
      expect(stub.map.pans).toEqual([[0, 150]]);
    });

    it('leaves the map be when nothing covers it', async () => {
      const t = await boot();
      layout(t, 0);
      await searchFor(t, 'Helvellyn', [hit('Helvellyn', HELVELLYN)]);
      t.rows()[0].click();
      expect(stub.map.pans).toEqual([]);
    });
  });
});

describe('clearing the box', () => {
  it('empties it, puts the list away and takes the pin off the map', async () => {
    const t = await boot();
    await searchFor(t, 'Helvellyn', [hit('Helvellyn', HELVELLYN)]);
    t.rows()[0].click();
    t.$('searchClear').click();
    expect((t.$('searchInput') as HTMLInputElement).value).toBe('');
    expect(t.shown('searchClear')).toBe(false);
    expect(t.shown('searchResults')).toBe(false);
    expect(t.pin).toBeUndefined();
  });
});

describe('Nearby', () => {
  const SUMMITS: Poi[] = [
    { kind: 'summit', name: 'Helvellyn', pos: HELVELLYN, ele: 950 },
    { kind: 'summit', name: 'Catstye Cam', pos: [54.531, -3.004], ele: 890 }
  ];

  it('reads as on at once, and searches the map on screen rather than the GPS fix', async () => {
    const t = await boot();
    gps.fix = [51.5, -0.12];
    stub.map.bounds = { south: 54.5, west: -3.05, north: 54.56, east: -2.95 };
    void t.mod.toggleNearby('summit');
    expect(t.mod.nearbyOn('summit')).toBe(true);
    expect(t.toast()).toBe('Looking for summits…');
    expect(looking[0].box).toEqual(nearbyBox(stub.map.bounds));
  });

  it('draws what it finds as one layer, and says how many', async () => {
    const t = await boot();
    const done = t.mod.toggleNearby('summit');
    await looking[0].answer(SUMMITS);
    await done;
    expect(t.groups).toHaveLength(1);
    expect(t.groups[0].children.map((m) => m.latlng)).toEqual([HELVELLYN, [54.531, -3.004]]);
    expect(t.toast()).toBe('Summits: 2 found — tap a marker for detail');
  });

  it("opens a point's card as its own kind, with OpenStreetMap's height", async () => {
    const t = await boot();
    const done = t.mod.toggleNearby('summit');
    await looking[0].answer(SUMMITS);
    await done;
    t.groups[0].children[0].fire('click');
    expect(t.openNewPin).toHaveBeenCalledWith(...HELVELLYN, {
      name: 'Helvellyn',
      category: 'summit',
      ele: 950,
      marker: false
    });
  });

  it('turns itself back off when nothing is mapped here', async () => {
    const t = await boot();
    const done = t.mod.toggleNearby('water');
    await looking[0].answer([]);
    await done;
    expect(t.mod.nearbyOn('water')).toBe(false);
    expect(t.groups).toEqual([]);
    expect(t.toast()).toBe('No water mapped in this part of the map');
  });

  it('turns itself back off, and says try again, when the servers are busy', async () => {
    const t = await boot();
    const done = t.mod.toggleNearby('summit');
    await looking[0].fail(new Error('HTTP 429'));
    await done;
    expect(t.mod.nearbyOn('summit')).toBe(false);
    expect(t.toast()).toBe('Map data servers busy (HTTP 429) — try again in a moment');
  });

  it('can be unticked while it is still looking, and the late answer draws nothing', async () => {
    const t = await boot();
    const done = t.mod.toggleNearby('summit');
    await t.mod.toggleNearby('summit');
    expect(looking[0].signal.aborted).toBe(true);
    expect(t.mod.nearbyOn('summit')).toBe(false);
    // The "Looking for…" toast has no timeout of its own, so it goes now.
    expect(t.toastUp()).toBe(false);

    await looking[0].answer(SUMMITS);
    await done;
    expect(t.groups).toEqual([]);
    expect(t.toastUp()).toBe(false);
  });

  it('takes its markers off the map when unticked, and asks nothing', async () => {
    const t = await boot();
    const done = t.mod.toggleNearby('summit');
    await looking[0].answer(SUMMITS);
    await done;
    await t.mod.toggleNearby('summit');
    expect(t.groups).toEqual([]);
    expect(t.mod.nearbyOn('summit')).toBe(false);
    expect(looking).toHaveLength(1);
  });

  it('keeps each category to itself', async () => {
    const t = await boot();
    const summits = t.mod.toggleNearby('summit');
    const water = t.mod.toggleNearby('water');
    await looking[0].answer(SUMMITS);
    await looking[1].answer([{ kind: 'water', name: 'Spring', pos: GLENRIDDING }]);
    await Promise.all([summits, water]);
    await t.mod.toggleNearby('summit');
    expect(t.mod.nearbyOn('water')).toBe(true);
    expect(t.groups.map((g) => g.children.length)).toEqual([1]);
  });

  it('ignores a category it does not know', async () => {
    const t = await boot();
    await t.mod.toggleNearby('volcano' as never);
    expect(t.mod.nearbyOn('volcano' as never)).toBe(false);
    expect(looking).toEqual([]);
  });
});
