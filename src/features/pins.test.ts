// @vitest-environment jsdom

// Saved pins, from the long-press that opens the "what's here" card to the
// marker you tap to get it back. Most of what can go wrong here is timing: a
// height or a fix that answers after its card has gone, a click trailing the
// long-press that would shut the card it just opened, a save made before the
// markers have been drawn. So this boots the real module against a Leaflet
// that draws nothing and holds every slow answer until the test lets it go.

import indexHtml from '../../index.html?raw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compassDir, formatDistance, haversine } from '../geo';
import { loadPins, savePins, type Pin } from '../state';
import { gridText } from '../ui/format';

const leaflet = vi.hoisted(async () => {
  const { createLeafletStub } = await import('../testing/leaflet-stub');
  return createLeafletStub();
});

/** Where tracking says you are, as each test wants it. */
const you = vi.hoisted(() => ({ here: null as [number, number] | null }));

vi.mock('../leaflet-setup', async () => ({ default: (await leaflet).L }));
vi.mock('../map/map', async () => ({ map: (await leaflet).map }));
vi.mock('./tracking', () => ({
  getKnownPosition: () => you.here,
  setKnownPosition: vi.fn((p: [number, number]) => { you.here = p; }),
  pauseFollow: vi.fn()
}));
vi.mock('./planner', () => ({ isPlanning: vi.fn(() => false) }));
// Routing there is detour.ts's job, tested where it lives; here it only
// matters what the card asks for and what it does with the answer.
vi.mock('./detour', () => ({ directionsTo: vi.fn(async () => true) }));
vi.mock('../elevation', () => ({ fetchElevation: vi.fn() }));
vi.mock('../ui/confirm', () => ({ askConfirm: vi.fn(async () => true) }));

/** A place with no height, so it spreads into (lat, lng) arguments. */
type Spot = [lat: number, lng: number];

const GLENRIDDING: Spot = [54.544, -2.95];
const HELVELLYN: Spot = [54.5271, -3.0164];
/** A kilometre or so south of the summit, where the walker is standing. */
const BELOW: Spot = [54.518, -3.0164];

/** The card and the toast, lifted out of the real index.html. */
const PAGE = (() => {
  const doc = new DOMParser().parseFromString(indexHtml, 'text/html');
  return ['pinCard', 'toast'].map((id) => doc.getElementById(id)!.outerHTML).join('');
})();

const pin = (over: Partial<Pin> = {}): Pin => ({
  id: 'p1',
  name: 'Helvellyn',
  category: 'summit',
  lat: HELVELLYN[0],
  lng: HELVELLYN[1],
  ele: 950,
  createdAt: 1,
  ...over
});

let stub: Awaited<typeof leaflet>;
const lastView = () => stub.map.views[stub.map.views.length - 1];

/** Height lookups the module has asked for and the test has not answered yet. */
let heights: { answer: (m: number | null) => void; signal: AbortSignal }[];
/** One-shot fixes asked for, likewise. */
let fixes: { ok: (p: Spot) => void; fail: () => void }[];

/**
 * A pins module fresh from storage. The reset matters: the list, the markers
 * and the open card are module state, so the only way back to zero is to
 * throw the module away and import it again.
 */
async function boot(saved: Pin[] = []) {
  vi.resetModules();
  localStorage.clear();
  if (saved.length) savePins(saved);
  document.body.innerHTML = PAGE;
  stub.reset();
  you.here = null;
  heights = [];
  fixes = [];

  const pins = await import('./pins');
  // The mocks are rebuilt with the registry, so these are fetched after the
  // reset: the instances the fresh module will call.
  const { fetchElevation } = await import('../elevation');
  vi.mocked(fetchElevation).mockImplementation(
    (_lat, _lng, signal) => new Promise((answer) => heights.push({ answer, signal: signal! }))
  );
  const { isPlanning } = await import('./planner');
  const { directionsTo } = await import('./detour');
  const { askConfirm } = await import('../ui/confirm');
  // clearAllMocks keeps a test's mockReturnValue, so each boot says it afresh.
  vi.mocked(isPlanning).mockReturnValue(false);
  vi.mocked(directionsTo).mockResolvedValue(true);
  vi.mocked(askConfirm).mockResolvedValue(true);
  const tracking = await import('./tracking');

  pins.initPins();
  const $ = (id: string) => document.getElementById(id);
  const card = () => $('pinCard')!;
  return {
    pins,
    fetchElevation: vi.mocked(fetchElevation),
    isPlanning: vi.mocked(isPlanning),
    directionsTo: vi.mocked(directionsTo),
    askConfirm: vi.mocked(askConfirm),
    pauseFollow: vi.mocked(tracking.pauseFollow),
    $,
    card,
    cardOpen: () => !card().classList.contains('hidden'),
    eyebrow: () => card().querySelector('.pc-eyebrow')?.textContent,
    toast: () => $('toast')!.textContent,
    /** Long-press the map, as a thumb would. */
    longPress: ([lat, lng]: Spot) => stub.map.fire('contextmenu', { latlng: { lat, lng } }),
    /** Let the idle-time marker drawing and any awaited handler finish. */
    settle: () => vi.advanceTimersByTimeAsync(0),
    /** The red pin dropped on an unsaved spot, if it is drawn. */
    get drop() {
      return stub.map.layers.find((l) => String((l.options.icon as { html: string }).html).includes('dropPin'));
    },
    /** Saved pins' markers, as the map holds them. */
    get markers() {
      return stub.map.layers.filter((l) => String((l.options.icon as { html: string }).html).includes('savedPin'));
    }
  };
}

beforeEach(async () => {
  stub = await leaflet;
  vi.clearAllMocks();
  vi.useFakeTimers();
  Object.defineProperty(navigator, 'geolocation', {
    value: {
      getCurrentPosition: (ok: PositionCallback, fail: PositionErrorCallback) =>
        fixes.push({
          ok: ([latitude, longitude]) => ok({ coords: { latitude, longitude } } as GeolocationPosition),
          fail: () => fail({ code: 3 } as GeolocationPositionError)
        })
    },
    configurable: true
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a long-press', () => {
  it("opens the what's-here card, with the grid ref, and drops a pin there", async () => {
    const t = await boot();
    t.longPress(GLENRIDDING);
    expect(t.cardOpen()).toBe(true);
    expect(t.eyebrow()).toBe("What's here");
    expect(t.card().querySelector('.pc-grid')!.textContent).toMatch(/^NY \d{4} \d{4}$/);
    expect(t.card().querySelector('.pc-ll')!.textContent).toBe('54.54400, -2.95000');
    expect(t.drop?.latlng).toEqual(GLENRIDDING);
  });

  it('does nothing while a route is being drawn', async () => {
    const t = await boot();
    t.isPlanning.mockReturnValue(true);
    t.longPress(GLENRIDDING);
    expect(t.cardOpen()).toBe(false);
    expect(t.drop).toBeUndefined();
  });

  it('is not undone by the click that can trail it, but a later tap closes it', async () => {
    const t = await boot();
    t.longPress(GLENRIDDING);
    t.pins.dismissPinCard();
    expect(t.cardOpen()).toBe(true);

    await vi.advanceTimersByTimeAsync(400);
    t.pins.dismissPinCard();
    expect(t.cardOpen()).toBe(false);
    expect(t.drop).toBeUndefined();
  });
});

describe('the height', () => {
  it('fills in when the lookup answers', async () => {
    const t = await boot();
    t.longPress(GLENRIDDING);
    expect(t.$('pcEle')!.classList.contains('loading')).toBe(true);
    heights[0].answer(152.6);
    await t.settle();
    expect(t.$('pcEle')!.textContent).toBe('153 m');
  });

  it('drops the row when there is no answer to give', async () => {
    const t = await boot();
    t.longPress(GLENRIDDING);
    heights[0].answer(null);
    await t.settle();
    expect(t.$('pcEle')).toBeNull();
  });

  it('is not looked up when the place came with one', async () => {
    const t = await boot();
    t.pins.openNewPin(...HELVELLYN, { name: 'Helvellyn', ele: 950 });
    expect(t.fetchElevation).not.toHaveBeenCalled();
    expect(t.card().querySelector('.pc-facts')!.textContent).toContain('950 m');
  });

  it("is called off when the card closes, and a late answer cannot reach the next card's", async () => {
    const t = await boot();
    t.longPress(GLENRIDDING);
    t.longPress(HELVELLYN);
    expect(heights[0].signal.aborted).toBe(true);
    heights[0].answer(152);
    await t.settle();
    expect(t.$('pcEle')!.classList.contains('loading')).toBe(true);
    heights[1].answer(950);
    await t.settle();
    expect(t.$('pcEle')!.textContent).toBe('950 m');
  });
});

describe('the distance', () => {
  /** What the card should say from `from` to the summit. */
  const said = (from: Spot) => `${formatDistance(haversine(from, HELVELLYN))} ${compassDir(from, HELVELLYN)}`;

  it('reads from where you are, and keeps up as you walk', async () => {
    const t = await boot();
    you.here = GLENRIDDING;
    t.pins.openNewPin(...HELVELLYN);
    expect(t.$('pcDist')!.textContent).toBe(said(GLENRIDDING));

    you.here = BELOW;
    t.pins.refreshCardDistance();
    expect(t.$('pcDist')!.textContent).toBe(said(BELOW));
  });

  it('asks for a fix when it does not know where you are, and keeps the answer', async () => {
    const t = await boot();
    t.pins.openNewPin(...HELVELLYN);
    expect(t.$('pcDist')!.classList.contains('loading')).toBe(true);
    fixes[0].ok(BELOW);
    expect(t.$('pcDist')!.textContent).toBe(said(BELOW));
    // Kept for the next card, and for tracking.
    expect(you.here).toEqual(BELOW);
  });

  it('drops the row when no fix comes, rather than loading forever', async () => {
    const t = await boot();
    t.pins.openNewPin(...HELVELLYN);
    fixes[0].fail();
    expect(t.$('pcDist')).toBeNull();
  });
});

describe('saving', () => {
  it('keeps the name, the chip and the height, and turns the card into the saved one', async () => {
    const t = await boot();
    t.longPress(GLENRIDDING);
    heights[0].answer(152);
    await t.settle();
    (t.$('pcName') as HTMLInputElement).value = '  Car park  ';
    t.card().querySelector<HTMLElement>('[data-cat="parking"]')!.click();
    t.$('pcSave')!.click();

    expect(loadPins()).toMatchObject([{ name: 'Car park', category: 'parking', lat: 54.544, lng: -2.95, ele: 152 }]);
    expect(t.eyebrow()).toBe('Saved pin');
    expect(t.toast()).toBe('Pin saved');
    // The red pin gives way to the saved pin's own marker.
    expect(t.drop).toBeUndefined();
    expect(t.markers.map((m) => m.latlng)).toEqual([GLENRIDDING]);
  });

  it("names an unnamed pin after its chip", async () => {
    const t = await boot();
    t.longPress(GLENRIDDING);
    t.card().querySelector<HTMLElement>('[data-cat="water"]')!.click();
    t.$('pcSave')!.click();
    expect(loadPins()[0].name).toBe('Water');
  });

  it('adds to the pins already saved, even before their markers are drawn', async () => {
    // initPins draws the markers once the browser is idle, which this has not
    // let happen; a save in that gap must not start the list from empty.
    const t = await boot([pin()]);
    t.longPress(GLENRIDDING);
    t.$('pcSave')!.click();
    expect(loadPins().map((p) => p.name)).toEqual(['Helvellyn', 'Other']);
    expect(t.markers).toHaveLength(2);
  });
});

describe('a saved pin', () => {
  it('is drawn once the browser is idle, and lets a tap through while planning', async () => {
    const t = await boot([pin()]);
    expect(t.markers).toHaveLength(0);
    await t.settle();
    expect(t.markers).toHaveLength(1);
    expect((t.markers[0].options.icon as { className: string }).className).toBe(t.pins.PLAN_PASS_THROUGH);
  });

  it('opens its card when its marker is tapped, with the name shown as written', async () => {
    const t = await boot([pin({ name: '<b>Red Tarn</b>' })]);
    await t.settle();
    t.markers[0].fire('click');
    expect(t.eyebrow()).toBe('Saved pin');
    const nm = t.card().querySelector('.nm')!;
    expect(nm.textContent).toBe('<b>Red Tarn</b>');
    expect(nm.querySelector('b')).toBeNull();
  });

  it('goes, from storage and the map, once the delete is confirmed', async () => {
    const t = await boot([pin()]);
    await t.settle();
    t.pins.openSavedPin('p1');
    t.$('pcDel')!.click();
    await t.settle();
    expect(t.askConfirm).toHaveBeenCalledWith('Delete “Helvellyn”?', { action: 'Delete', danger: true });
    expect(loadPins()).toEqual([]);
    expect(t.markers).toHaveLength(0);
    expect(t.cardOpen()).toBe(false);
    expect(t.toast()).toBe('Pin deleted');
  });

  it('stays when the delete is declined', async () => {
    const t = await boot([pin()]);
    await t.settle();
    t.askConfirm.mockResolvedValueOnce(false);
    t.pins.openSavedPin('p1');
    t.$('pcDel')!.click();
    await t.settle();
    expect(loadPins()).toHaveLength(1);
    expect(t.markers).toHaveLength(1);
    expect(t.cardOpen()).toBe(true);
  });
});

describe('directions', () => {
  it("routes to an unsaved spot by its grid ref, or by the name you've started typing", async () => {
    const t = await boot();
    t.longPress(GLENRIDDING);
    t.$('pcDirections')!.click();
    expect(t.directionsTo.mock.calls[0][0]).toEqual({ name: gridText(...GLENRIDDING), lat: 54.544, lng: -2.95 });

    (t.$('pcName') as HTMLInputElement).value = 'Bus stop';
    t.$('pcDirections')!.click();
    expect(t.directionsTo.mock.calls[1][0].name).toBe('Bus stop');
  });

  it('routes to a saved pin by its name, and puts the card away once the route is on', async () => {
    const t = await boot([pin()]);
    t.pins.openSavedPin('p1');
    t.$('pcDirections')!.click();
    expect(t.directionsTo.mock.calls[0][0]).toEqual({ name: 'Helvellyn', lat: HELVELLYN[0], lng: HELVELLYN[1] });
    await t.settle();
    expect(t.cardOpen()).toBe(false);
  });

  it('keeps the card when no route was started', async () => {
    const t = await boot([pin()]);
    t.directionsTo.mockResolvedValueOnce(false);
    t.pins.openSavedPin('p1');
    t.$('pcDirections')!.click();
    await t.settle();
    expect(t.cardOpen()).toBe(true);
  });

  it('shows the router busy on the button while it works', async () => {
    const t = await boot([pin()]);
    t.pins.openSavedPin('p1');
    t.$('pcDirections')!.click();
    const label = t.directionsTo.mock.calls[0][1];
    const btn = t.$('pcDirections') as HTMLButtonElement;
    label('Finding a route…');
    expect([btn.disabled, btn.textContent]).toEqual([true, 'Finding a route…']);
    label(null);
    expect([btn.disabled, btn.textContent]).toEqual([false, 'Directions']);
  });
});

describe('sharing', () => {
  let shared: ShareData[];
  let copied: string[];

  /** A phone's share sheet, or none; and a clipboard that may refuse. */
  function install(sheet: ((d: ShareData) => Promise<void>) | undefined, clipboardOk = true) {
    shared = [];
    copied = [];
    Object.defineProperty(navigator, 'share', {
      value: sheet && (async (d: ShareData) => { shared.push(d); await sheet(d); }),
      configurable: true
    });
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async (s: string) => { if (!clipboardOk) throw new Error('denied'); copied.push(s); } },
      configurable: true
    });
  }

  it('hands the share sheet the place written out, and a link back into the app', async () => {
    const t = await boot();
    install(async () => {});
    await t.pins.sharePin(pin());
    expect(shared).toHaveLength(1);
    expect(shared[0].title).toBe('Helvellyn');
    expect(shared[0].text).toBe(`Helvellyn\n${gridText(...HELVELLYN)}\n54.52710, -3.01640\n950 m`);
    expect(shared[0].url).toBe(`${location.origin}${location.pathname}#p=54.52710,-3.01640,Helvellyn`);
    expect(copied).toEqual([]);
  });

  it('names an unnamed spot by its grid ref in the link', async () => {
    const t = await boot();
    install(async () => {});
    await t.pins.sharePin({ lat: GLENRIDDING[0], lng: GLENRIDDING[1] });
    expect(shared[0].url).toContain(`#p=54.54400,-2.95000,${encodeURIComponent(gridText(...GLENRIDDING))}`);
  });

  it('leaves it there when you back out of the share sheet', async () => {
    const t = await boot();
    install(async () => { throw new DOMException('closed', 'AbortError'); });
    await t.pins.sharePin(pin());
    expect(copied).toEqual([]);
  });

  it('copies it instead when there is no share sheet, or it fails', async () => {
    const t = await boot();
    install(undefined);
    await t.pins.sharePin(pin());
    expect(copied[0]).toMatch(/^Helvellyn\n[\s\S]*#p=54\.52710,-3\.01640,Helvellyn$/);
    expect(t.toast()).toBe('Copied');

    install(async () => { throw new Error('NotAllowedError'); });
    await t.pins.sharePin(pin());
    expect(copied).toHaveLength(1);
  });

  it('falls back to a prompt when the clipboard refuses too', async () => {
    const t = await boot();
    install(undefined, false);
    const prompt = vi.fn();
    vi.stubGlobal('prompt', prompt);
    await t.pins.sharePin(pin());
    expect(prompt).toHaveBeenCalledWith('Copy:', expect.stringContaining('#p=54.52710,-3.01640,Helvellyn'));
    vi.unstubAllGlobals();
  });
});

describe('a shared pin link', () => {
  it('opens the link sharePin made, named, and centred close in', async () => {
    const t = await boot();
    let link = '';
    Object.defineProperty(navigator, 'share', {
      value: async (d: ShareData) => { link = String(d.url); },
      configurable: true
    });
    await t.pins.sharePin(pin({ name: 'Red Tarn & beck' }));
    history.replaceState(null, '', new URL(link).hash);

    expect(t.pins.openSharedPin()).toBe(true);
    expect(t.eyebrow()).toBe("What's here");
    expect((t.$('pcName') as HTMLInputElement).value).toBe('Red Tarn & beck');
    expect(lastView()).toMatchObject({ center: [54.5271, -3.0164], zoom: 15 });
    expect(t.pauseFollow).toHaveBeenCalled();
    // Used up, so a reload does not open it again.
    expect(location.hash).toBe('');
  });

  it('keeps a closer zoom than 15 if the map already has one', async () => {
    const t = await boot();
    stub.map.zoom = 17;
    history.replaceState(null, '', '#p=54.52710,-3.01640');
    t.pins.openSharedPin();
    expect(lastView().zoom).toBe(17);
    expect((t.$('pcName') as HTMLInputElement).value).toBe('');
  });

  it('leaves any other link alone', async () => {
    const t = await boot();
    history.replaceState(null, '', '#r=abc');
    expect(t.pins.openSharedPin()).toBe(false);
    expect(t.cardOpen()).toBe(false);
    expect(location.hash).toBe('#r=abc');
    history.replaceState(null, '', location.pathname);
  });
});
