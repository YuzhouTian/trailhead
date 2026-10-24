// @vitest-environment jsdom

// The bottom sheet and its three panels. panels.ts owns none of the behaviour
// behind its rows — every one calls into the feature that does — so what is
// worth pinning is the wiring: that each row reflects the setting it shows,
// that a change lands in the setting and reaches the feature that acts on it,
// and that the shell leaves things square however a sheet is opened or shut.
//
// Every feature module is replaced by a recorder. That keeps this about the
// panels, and is also the only way to see the half of the Plan handshake the
// planner's own tests cannot: that opening a sheet steps out of Plan.

import indexHtml from '../../index.html?raw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BASE_LAYERS, BROUTER_PROFILES, ROUTE_COLOURS } from '../config';
import { POI_CATEGORIES } from '../poi';
import type { Pin, SavedRoute, Settings } from '../state';
import { gridText } from './format';

const leaflet = vi.hoisted(async () => {
  const { createLeafletStub } = await import('../testing/leaflet-stub');
  return createLeafletStub();
});

/** What Nearby says is on, as each test wants it. */
const nearby = vi.hoisted(() => ({ on: new Set<string>() }));

vi.mock('../map/map', async () => ({
  map: (await leaflet).map,
  applyLayers: vi.fn(),
  setOsNativeScale: vi.fn()
}));
vi.mock('../features/pins', () => ({
  catMeta: () => ({ icon: 'c-summit' }),
  deletePin: vi.fn(async () => true),
  getPins: vi.fn(() => []),
  hidePinCard: vi.fn(),
  openSavedPin: vi.fn(),
  sharePin: vi.fn(async () => {})
}));
vi.mock('../features/planner', () => ({ endPlanning: vi.fn(), updatePlanStats: vi.fn() }));
vi.mock('../features/qr', () => ({ startQrScan: vi.fn() }));
vi.mock('../features/search', () => ({
  nearbyOn: (kind: string) => nearby.on.has(kind),
  toggleNearby: vi.fn()
}));
vi.mock('../features/sharing', () => ({ openSharePanel: vi.fn(), pasteSharedRoute: vi.fn() }));
vi.mock('../features/storage', async (importOriginal) => ({
  // The real byte formatting; only the Cache API is replaced.
  ...(await importOriginal<typeof import('../features/storage')>()),
  offlineUsage: vi.fn(),
  clearOfflineTiles: vi.fn()
}));
vi.mock('../features/tracking', () => ({ pauseFollow: vi.fn() }));
vi.mock('../legend', () => ({ legendHtml: (id: string) => `<h3>Key for ${id}</h3>` }));
vi.mock('../state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../state')>()),
  saveSettings: vi.fn()
}));
vi.mock('./routeCard', () => ({
  climbText: (up: number) => `↑ ${up} m`,
  updateRouteCard: vi.fn()
}));
vi.mock('./sheet', () => ({ initSheetDrag: vi.fn(() => vi.fn()) }));
vi.mock('./confirm', () => ({ askConfirm: vi.fn(async () => true) }));

/** The sheet, the tab bar, and what the panels reach for — from index.html. */
const PAGE = (() => {
  const doc = new DOMParser().parseFromString(indexHtml, 'text/html');
  return ['panel', 'panelScrim', 'btnMap', 'btnRoutes', 'btnSettings', 'gpxFile', 'toast']
    .map((id) => doc.getElementById(id)!.outerHTML)
    .join('');
})();

const route = (over: Partial<SavedRoute> = {}): SavedRoute => ({
  id: 'r1',
  name: 'Striding Edge',
  waypoints: null,
  coords: [],
  distanceM: 8400,
  ascentM: 412,
  createdAt: 1,
  ...over
});

const pin = (over: Partial<Pin> = {}): Pin => ({
  id: 'p1',
  name: 'Red Tarn',
  category: 'water',
  lat: 54.53,
  lng: -3.0,
  ele: 718,
  createdAt: 1,
  ...over
});

let stub: Awaited<typeof leaflet>;

/** An offline-usage read the panel has asked for and the test has not answered. */
let usageReads: ((u: { tiles: number; bytes: number | null }) => void)[];

/**
 * A panels module with nothing behind it. Every mock is fetched after the
 * registry reset, because those are the instances the fresh module calls.
 */
async function boot(opts: { routes?: SavedRoute[]; pins?: Pin[]; settings?: Partial<Settings> } = {}) {
  vi.resetModules();
  document.body.innerHTML = PAGE;
  stub.reset();
  nearby.on.clear();
  usageReads = [];

  const panels = await import('./panels');
  const mapMod = await import('../map/map');
  const pinsMod = await import('../features/pins');
  const planner = await import('../features/planner');
  const qr = await import('../features/qr');
  const search = await import('../features/search');
  const sharing = await import('../features/sharing');
  const storage = await import('../features/storage');
  const tracking = await import('../features/tracking');
  const state = await import('../state');
  const routeCard = await import('./routeCard');
  const sheet = await import('./sheet');
  const confirm = await import('./confirm');

  let routes = opts.routes ?? [];
  vi.mocked(pinsMod.getPins).mockReturnValue(opts.pins ?? []);
  vi.mocked(storage.offlineUsage).mockImplementation(() => new Promise((r) => usageReads.push(r)));
  vi.mocked(confirm.askConfirm).mockResolvedValue(true);
  vi.mocked(pinsMod.deletePin).mockResolvedValue(true);

  const settings: Settings = {
    osKey: '',
    osNative: false,
    baseLayer: 'freemap',
    profile: BROUTER_PROFILES[0].id,
    speedKmh: 4,
    theme: 'system',
    routeColour: ROUTE_COLOURS[0].colour,
    ...opts.settings
  };
  const deleteRoute = vi.fn(async (r: SavedRoute) => {
    routes = routes.filter((x) => x.id !== r.id);
    return true;
  });
  const getRoutes = vi.fn(() => routes);
  const setActiveRoute = vi.fn();
  const applyTheme = vi.fn();
  const applyRouteColour = vi.fn();
  panels.initPanels({ settings, getRoutes, deleteRoute, setActiveRoute, applyTheme, applyRouteColour });

  const $ = (id: string) => document.getElementById(id)!;
  const shown = (id: string) => !$(id).classList.contains('hidden');
  const content = () => $('panelContent');
  return {
    panels,
    settings,
    getRoutes,
    deleteRoute,
    setActiveRoute,
    applyTheme,
    applyRouteColour,
    applyLayers: vi.mocked(mapMod.applyLayers),
    setOsNativeScale: vi.mocked(mapMod.setOsNativeScale),
    pins: vi.mocked(pinsMod),
    planner: vi.mocked(planner),
    startQrScan: vi.mocked(qr.startQrScan),
    toggleNearby: vi.mocked(search.toggleNearby),
    sharing: vi.mocked(sharing),
    storage: vi.mocked(storage),
    pauseFollow: vi.mocked(tracking.pauseFollow),
    saveSettings: vi.mocked(state.saveSettings),
    updateRouteCard: vi.mocked(routeCard.updateRouteCard),
    initSheetDrag: vi.mocked(sheet.initSheetDrag),
    /** The reset initSheetDrag handed back. */
    resetDrag: vi.mocked(sheet.initSheetDrag).mock.results[0].value as ReturnType<typeof vi.fn>,
    askConfirm: vi.mocked(confirm.askConfirm),
    $,
    shown,
    content,
    title: () => $('panelTitle').textContent,
    toast: () => $('toast').textContent,
    /** Let awaited handlers and storage reads run out. */
    settle: () => new Promise((r) => setTimeout(r, 0)),
    /** Change a form control as a thumb would: set it, then fire `change`. */
    change(id: string, value: string | boolean) {
      const el = $(id) as HTMLInputElement;
      if (typeof value === 'boolean') el.checked = value;
      else el.value = value;
      el.dispatchEvent(new Event('change'));
    },
    /** A row's button in the Saved panel, by the route or pin it belongs to. */
    act: (sel: string, act: string) =>
      content().querySelector<HTMLButtonElement>(`.routeItem[${sel}] [data-act="${act}"], .routeItem[${sel}] [data-pact="${act}"]`)!,
    names: () => [...content().querySelectorAll('.routeItem .name')].map((n) => n.textContent)
  };
}

beforeEach(async () => {
  stub = await leaflet;
  vi.clearAllMocks();
});

describe('the sheet', () => {
  it('opens with the content and the title it was given, scrolled to the top', async () => {
    const t = await boot();
    t.$('panel').scrollTop = 200;
    const content = t.panels.showPanel('<p id="x">Hello</p>', 'Map');
    expect(content).toBe(t.content());
    expect(t.content().innerHTML).toBe('<p id="x">Hello</p>');
    expect(t.title()).toBe('Map');
    expect(t.shown('panel')).toBe(true);
    expect(t.shown('panelScrim')).toBe(true);
    expect(t.$('panel').scrollTop).toBe(0);
  });

  it('steps out of Plan and puts away the pin card, so only one thing holds the bottom', async () => {
    const t = await boot();
    t.panels.showPanel('');
    expect(t.planner.endPlanning).toHaveBeenCalledOnce();
    expect(t.pins.hidePinCard).toHaveBeenCalledOnce();
  });

  it('un-lights the tab of the sheet it replaces, and settles a half-finished drag', async () => {
    const t = await boot();
    t.$('btnMap').classList.add('active');
    t.panels.showPanel('', 'Saved');
    expect(t.$('btnMap').classList.contains('active')).toBe(false);
    expect(t.resetDrag).toHaveBeenCalled();
  });

  it('is put away by the scrim, the close button and the drag, leaving no tab lit', async () => {
    const t = await boot();
    expect(t.initSheetDrag).toHaveBeenCalledWith({
      sheet: t.$('panel'),
      handle: t.$('panelHead'),
      scrim: t.$('panelScrim'),
      close: t.panels.hidePanel
    });
    for (const shut of [() => t.$('panelScrim').click(), () => t.$('panelClose').click(), () => t.panels.hidePanel()]) {
      t.panels.showPanel('');
      t.$('btnSettings').classList.add('active');
      t.resetDrag.mockClear();
      shut();
      expect([t.shown('panel'), t.shown('panelScrim')]).toEqual([false, false]);
      expect(t.$('btnSettings').classList.contains('active')).toBe(false);
      expect(t.resetDrag).toHaveBeenCalled();
    }
  });
});

describe('the Map panel', () => {
  const radios = () => [...document.querySelectorAll<HTMLInputElement>('input[name="base"]')];

  it('offers every layer but the hidden fallback, with the current one ticked', async () => {
    const t = await boot({ settings: { baseLayer: 'os-leisure' } });
    t.panels.openMapPanel();
    expect(t.title()).toBe('Map');
    expect(radios().map((r) => r.value)).toEqual(BASE_LAYERS.filter((l) => !l.hidden).map((l) => l.id));
    expect(radios().map((r) => r.value)).not.toContain('osm');
    expect(radios().filter((r) => r.checked).map((r) => r.value)).toEqual(['os-leisure']);
  });

  it('marks OS Explorer as needing a key until it has one', async () => {
    const noKey = await boot();
    noKey.panels.openMapPanel();
    expect(noKey.$('panelContent').querySelector('label[for="base-os-leisure"] .warn')?.textContent).toBe('(needs key)');

    const withKey = await boot({ settings: { osKey: 'K3Y' } });
    withKey.panels.openMapPanel();
    expect(withKey.$('panelContent').querySelector('.warn')).toBeNull();
  });

  it('switches layer when one is picked', async () => {
    const t = await boot();
    t.panels.openMapPanel();
    t.change('base-os-leisure', true);
    expect(t.settings.baseLayer).toBe('os-leisure');
    expect(t.applyLayers).toHaveBeenCalledOnce();
  });

  it("opens the key for the layer you're on, which titles itself", async () => {
    const t = await boot({ settings: { baseLayer: 'os-leisure' } });
    t.panels.openMapPanel();
    t.$('keyBtn').click();
    expect(t.content().innerHTML).toBe('<h3>Key for os-leisure</h3>');
    expect(t.title()).toBe('');
  });

  describe('Nearby chips', () => {
    const chip = (kind: string) => document.querySelector<HTMLButtonElement>(`.nearbyChips [data-kind="${kind}"]`)!;
    const lit = (kind: string) => [chip(kind).classList.contains('on'), chip(kind).getAttribute('aria-pressed')];

    it('has one per category, lit for those already on the map', async () => {
      const t = await boot();
      nearby.on.add('water');
      t.panels.openMapPanel();
      expect([...document.querySelectorAll<HTMLElement>('.nearbyChips .pc-chip')].map((c) => c.dataset.kind)).toEqual(
        POI_CATEGORIES.map((c) => c.id)
      );
      expect(lit('water')).toEqual([true, 'true']);
      expect(lit('summit')).toEqual([false, 'false']);
    });

    it('lights at once on a tap, and goes out again if the search turns it off', async () => {
      const t = await boot();
      let finish!: () => void;
      t.toggleNearby.mockImplementation(async (kind) => {
        nearby.on.add(kind);
        await new Promise<void>((r) => (finish = r));
        nearby.on.delete(kind); // nothing found
      });
      t.panels.openMapPanel();
      chip('summit').click();
      expect(t.toggleNearby).toHaveBeenCalledWith('summit');
      expect(lit('summit')).toEqual([true, 'true']);
      finish();
      await t.settle();
      expect(lit('summit')).toEqual([false, 'false']);
      // The sheet stays up, so several can be ticked.
      expect(t.shown('panel')).toBe(true);
    });
  });
});

describe('the Settings panel', () => {
  it('marks the theme in use, and changes it on a tap', async () => {
    const t = await boot({ settings: { theme: 'dark' } });
    t.panels.openSettingsPanel();
    const sel = () => [...document.querySelectorAll<HTMLElement>('#themeSeg .sel')].map((b) => b.dataset.theme);
    expect(sel()).toEqual(['dark']);
    document.querySelector<HTMLElement>('#themeSeg [data-theme="light"]')!.click();
    expect(t.settings.theme).toBe('light');
    expect(t.saveSettings).toHaveBeenCalledWith(t.settings);
    expect(t.applyTheme).toHaveBeenCalledOnce();
    expect(sel()).toEqual(['light']);
  });

  it('marks the route colour in use, and changes it on a tap', async () => {
    const t = await boot({ settings: { routeColour: ROUTE_COLOURS[1].colour } });
    t.panels.openSettingsPanel();
    const checked = () =>
      [...document.querySelectorAll<HTMLElement>('#routeColours button')]
        .filter((b) => b.getAttribute('aria-checked') === 'true' && b.classList.contains('sel'))
        .map((b) => b.dataset.colour);
    expect(checked()).toEqual([ROUTE_COLOURS[1].colour]);
    document.querySelector<HTMLElement>(`#routeColours [data-colour="${ROUTE_COLOURS[3].colour}"]`)!.click();
    expect(t.settings.routeColour).toBe(ROUTE_COLOURS[3].colour);
    expect(t.saveSettings).toHaveBeenCalledWith(t.settings);
    expect(t.applyRouteColour).toHaveBeenCalledOnce();
    expect(checked()).toEqual([ROUTE_COLOURS[3].colour]);
  });

  it('saves the OS key trimmed, redraws the layers, and says what it did', async () => {
    const t = await boot();
    t.panels.openSettingsPanel();
    t.change('osKeyInput', '  K3Y \n');
    expect(t.settings.osKey).toBe('K3Y');
    expect(t.saveSettings).toHaveBeenCalledWith(t.settings);
    expect(t.applyLayers).toHaveBeenCalledOnce();
    expect(t.toast()).toBe('OS key saved — pick OS Explorer in Map');

    t.change('osKeyInput', '   ');
    expect(t.settings.osKey).toBe('');
    expect(t.toast()).toBe('OS key cleared');
  });

  it("shows the saved key, and hands the OS-scale switch to the map", async () => {
    const t = await boot({ settings: { osKey: 'K3Y', osNative: true } });
    t.panels.openSettingsPanel();
    expect((t.$('osKeyInput') as HTMLInputElement).value).toBe('K3Y');
    expect((t.$('osNative') as HTMLInputElement).checked).toBe(true);
    t.change('osNative', false);
    expect(t.setOsNativeScale).toHaveBeenCalledWith(false);
  });

  it('saves the routing profile picked', async () => {
    const t = await boot();
    t.panels.openSettingsPanel();
    expect((t.$('profileSel') as HTMLSelectElement).value).toBe(BROUTER_PROFILES[0].id);
    t.change('profileSel', BROUTER_PROFILES[1].id);
    expect(t.settings.profile).toBe(BROUTER_PROFILES[1].id);
    expect(t.saveSettings).toHaveBeenCalledWith(t.settings);
  });

  it('takes a new walking speed, and refreshes every time estimate on screen', async () => {
    const t = await boot();
    t.panels.openSettingsPanel();
    t.change('speedInput', '3.5');
    expect(t.settings.speedKmh).toBe(3.5);
    expect(t.saveSettings).toHaveBeenCalledWith(t.settings);
    expect(t.planner.updatePlanStats).toHaveBeenCalledOnce();
    expect(t.updateRouteCard).toHaveBeenCalledOnce();
  });

  it('ignores a walking speed that is not one', async () => {
    const t = await boot();
    t.panels.openSettingsPanel();
    for (const v of ['', '0', '-2', 'fast']) t.change('speedInput', v);
    expect(t.settings.speedKmh).toBe(4);
    expect(t.saveSettings).not.toHaveBeenCalled();
    expect(t.updateRouteCard).not.toHaveBeenCalled();
  });

  describe('offline maps', () => {
    const usage = () => document.getElementById('offlineUsage')!.textContent;

    it('says how much is saved, and that the size is the whole app and a rough one', async () => {
      const t = await boot();
      t.panels.openSettingsPanel();
      expect(usage()).toBe('Checking…');
      usageReads[0]({ tiles: 12345, bytes: 150e6 });
      await t.settle();
      expect(usage()).toBe('12,345 map tiles saved · about 150 MB of app data in total');
    });

    it('leaves the size out when the browser will not say', async () => {
      const t = await boot();
      t.panels.openSettingsPanel();
      usageReads[0]({ tiles: 40, bytes: null });
      await t.settle();
      expect(usage()).toBe('40 map tiles saved');
    });

    it('says when nothing is saved', async () => {
      const t = await boot();
      t.panels.openSettingsPanel();
      usageReads[0]({ tiles: 0, bytes: 2e6 });
      await t.settle();
      expect(usage()).toBe('No map saved for offline use yet.');
    });

    it('does not write a late figure into the panel that replaced Settings', async () => {
      const t = await boot();
      t.panels.openSettingsPanel();
      t.panels.openMapPanel();
      usageReads[0]({ tiles: 12345, bytes: null });
      await t.settle();
      expect(t.content().textContent).not.toContain('map tiles saved');
    });

    it('has nothing to clear when nothing is saved, and asks nothing', async () => {
      const t = await boot();
      t.panels.openSettingsPanel();
      t.$('offlineClear').click();
      usageReads[1]({ tiles: 0, bytes: null });
      await t.settle();
      expect(t.toast()).toBe('There is no saved map to clear');
      expect(t.askConfirm).not.toHaveBeenCalled();
      expect(t.storage.clearOfflineTiles).not.toHaveBeenCalled();
    });

    it('asks first, saying routes and pins are kept, and clears nothing on a no', async () => {
      const t = await boot();
      t.askConfirm.mockResolvedValueOnce(false);
      t.panels.openSettingsPanel();
      t.$('offlineClear').click();
      usageReads[1]({ tiles: 1200, bytes: null });
      await t.settle();
      expect(t.askConfirm).toHaveBeenCalledWith('Delete all 1,200 saved map tiles? Your routes and pins are kept.', {
        action: 'Clear',
        danger: true
      });
      expect(t.storage.clearOfflineTiles).not.toHaveBeenCalled();
    });

    it('clears on a yes, holding the button while it works, then reads the figures again', async () => {
      const t = await boot();
      let cleared!: (n: number) => void;
      t.storage.clearOfflineTiles.mockImplementation(() => new Promise((r) => (cleared = r)));
      t.panels.openSettingsPanel();
      const btn = t.$('offlineClear') as HTMLButtonElement;
      btn.click();
      usageReads[1]({ tiles: 1200, bytes: null });
      await t.settle();
      expect(btn.disabled).toBe(true);
      expect(t.toast()).toBe('Clearing offline maps…');

      cleared(1200);
      await t.settle();
      expect(btn.disabled).toBe(false);
      expect(t.toast()).toBe('Cleared 1,200 map tiles');
      usageReads[2]({ tiles: 0, bytes: null });
      await t.settle();
      expect(usage()).toBe('No map saved for offline use yet.');
    });
  });
});

describe('the Saved panel', () => {
  it('lists the routes with their length and climb, names written as text', async () => {
    const t = await boot({ routes: [route(), route({ id: 'r2', name: '<b>Flat</b> one', distanceM: 3200, ascentM: 0 })] });
    t.panels.openRoutesPanel();
    expect(t.title()).toBe('Saved');
    expect(t.names()).toEqual(['Striding Edge', '<b>Flat</b> one']);
    const subs = [...t.content().querySelectorAll('.routeItem[data-id] .sub')].map((s) => s.textContent);
    expect(subs[0]).toMatch(/ · ↑ 412 m$/);
    expect(subs[1]).not.toContain('↑');
    expect(t.content().querySelector('b')).toBeNull();
  });

  it('lists the pins with their grid ref and height', async () => {
    const t = await boot({ pins: [pin(), pin({ id: 'p2', name: 'No height', ele: null })] });
    t.panels.openRoutesPanel();
    const subs = [...t.content().querySelectorAll('.routeItem[data-pin] .sub')].map((s) => s.textContent);
    expect(subs).toEqual([`${gridText(54.53, -3.0)} · 718 m`, gridText(54.53, -3.0)]);
  });

  it('says how to get some when there are no routes or pins', async () => {
    const t = await boot();
    t.panels.openRoutesPanel();
    const hints = [...t.content().querySelectorAll('.hint')].map((h) => h.textContent);
    expect(hints).toEqual([
      'No saved routes yet. Import a GPX or plan one with the pencil tool.',
      'No pins yet. Long-press the map to drop one.'
    ]);
  });

  describe('a route', () => {
    it('loads, and the sheet gets out of the way', async () => {
      const r = route();
      const t = await boot({ routes: [r] });
      t.panels.openRoutesPanel();
      t.act('data-id="r1"', 'load').click();
      expect(t.setActiveRoute).toHaveBeenCalledWith(r);
      expect(t.shown('panel')).toBe(false);
    });

    it('opens its share sheet', async () => {
      const r = route();
      const t = await boot({ routes: [r] });
      t.panels.openRoutesPanel();
      t.act('data-id="r1"', 'share').click();
      expect(t.sharing.openSharePanel).toHaveBeenCalledWith(r);
    });

    it('drops out of the list once deleted', async () => {
      const t = await boot({ routes: [route(), route({ id: 'r2', name: 'Swirral Edge' })] });
      t.panels.openRoutesPanel();
      t.act('data-id="r1"', 'del').click();
      await t.settle();
      expect(t.names()).toEqual(['Swirral Edge']);
    });

    it('stays when the delete is called off', async () => {
      const t = await boot({ routes: [route()] });
      t.deleteRoute.mockResolvedValueOnce(false);
      t.panels.openRoutesPanel();
      t.getRoutes.mockClear();
      t.act('data-id="r1"', 'del').click();
      await t.settle();
      expect(t.getRoutes).not.toHaveBeenCalled();
      expect(t.names()).toEqual(['Striding Edge']);
    });
  });

  describe('a pin', () => {
    it('takes you there: sheet away, following paused before the move, its card open', async () => {
      const t = await boot({ pins: [pin()] });
      let movesBeforePause = -1;
      t.pauseFollow.mockImplementation(() => { movesBeforePause = stub.map.views.length; });
      t.panels.openRoutesPanel();
      t.act('data-pin="p1"', 'go').click();
      await t.settle();
      expect(t.shown('panel')).toBe(false);
      expect(movesBeforePause).toBe(0);
      expect(stub.map.views).toEqual([{ center: [54.53, -3.0], zoom: 15, options: {} }]);
      expect(t.pins.openSavedPin).toHaveBeenCalledWith('p1');
    });

    it('keeps a closer zoom than 15', async () => {
      const t = await boot({ pins: [pin()] });
      stub.map.zoom = 17;
      t.panels.openRoutesPanel();
      t.act('data-pin="p1"', 'go').click();
      await t.settle();
      expect(stub.map.views[0].zoom).toBe(17);
    });

    it('shares', async () => {
      const p = pin();
      const t = await boot({ pins: [p] });
      t.panels.openRoutesPanel();
      t.act('data-pin="p1"', 'share').click();
      expect(t.pins.sharePin).toHaveBeenCalledWith(p);
    });

    it('drops out of the list once deleted, and stays when the delete is called off', async () => {
      const t = await boot({ pins: [pin(), pin({ id: 'p2', name: 'Hole-in-the-Wall' })] });
      t.panels.openRoutesPanel();
      t.pins.deletePin.mockResolvedValueOnce(false);
      t.act('data-pin="p1"', 'del').click();
      await t.settle();
      expect(t.pins.getPins).toHaveBeenCalledTimes(1);

      t.pins.getPins.mockReturnValue([pin({ id: 'p2', name: 'Hole-in-the-Wall' })]);
      t.act('data-pin="p1"', 'del').click();
      await t.settle();
      expect(t.pins.deletePin).toHaveBeenLastCalledWith('p1');
      expect(t.names()).toEqual(['Hole-in-the-Wall']);
    });
  });

  it('offers the three ways of getting a route in', async () => {
    const t = await boot();
    t.panels.openRoutesPanel();
    const picked = vi.fn();
    t.$('gpxFile').addEventListener('click', picked);
    t.$('scanQr').click();
    t.$('pasteRoute').click();
    t.$('importBtn').click();
    expect(t.startQrScan).toHaveBeenCalledOnce();
    expect(t.sharing.pasteSharedRoute).toHaveBeenCalledOnce();
    expect(picked).toHaveBeenCalledOnce();
  });
});
