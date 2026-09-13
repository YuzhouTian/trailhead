// @vitest-environment jsdom

// Plan is a mode, not a screen, and that is the whole difficulty: the other
// three tabs open a sheet over the map, Plan wants the map itself. Only ever
// one of the four is on, and the two halves of that rule live in different
// modules — entering Plan puts away an open sheet from here, and a sheet
// opening steps out of Plan through endPlanning().
//
// So this boots the real planner against a Leaflet that draws nothing, and asks
// what it did to the tab bar, to the sheet and to the sketch. The half that
// belongs to ui/panels.ts — that showPanel() calls endPlanning() — cannot be
// seen from here. What can, and matters more, is that the way out this offers
// is one a half-drawn route survives.

import indexHtml from '../../index.html?raw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedRoute, Settings } from '../state';

const leaflet = vi.hoisted(async () => {
  const { createLeafletStub } = await import('../testing/leaflet-stub');
  return createLeafletStub();
});

vi.mock('../leaflet-setup', async () => ({ default: (await leaflet).L }));
vi.mock('../map/map', async () => ({ map: (await leaflet).map }));
// The card is a different module's job; that the planner asks it to refresh is
// already covered where the card lives.
vi.mock('../ui/routeCard', () => ({ climbText: () => '', updateRouteCard: vi.fn() }));
// The router is the network, and nothing here turns on what comes back from it.
vi.mock('../routing', () => ({ routeMixed: vi.fn(async () => null) }));

/**
 * What the planner reaches for, lifted out of the real index.html rather than
 * copied into here: the sheet has a dozen ids, and a copy that drifted from the
 * page would test a sheet nobody ships.
 */
const PAGE = (() => {
  const doc = new DOMParser().parseFromString(indexHtml, 'text/html');
  return ['btnPlan', 'planSheet', 'gpxFile', 'toast']
    .map((id) => doc.getElementById(id)!.outerHTML)
    .join('');
})();

/** A route as the router would hand one back, climbing as it goes. */
const ROUTED = {
  coords: [[54.45, -3.21, 100], [54.46, -3.22, 300]] as [number, number, number][],
  distanceM: 8400,
  ascentM: 412,
  descentM: 398
};

let stub: Awaited<typeof leaflet>;

/**
 * A planner with nothing behind it. The module reset is the part that matters:
 * the waypoints, the markers and the mode itself are module state held for the
 * life of the session, so the only way back to zero is to throw the module away
 * and import it again.
 */
async function boot() {
  vi.resetModules();
  document.body.innerHTML = PAGE;
  document.body.className = '';
  stub.reset();
  const planner = await import('./planner');
  // The mock is rebuilt with the module registry, so it is fetched after the
  // reset: this is the instance the fresh planner will call.
  const { routeMixed } = await import('../routing');
  const hidePanel = vi.fn();
  const saveRoute = vi.fn<(r: SavedRoute) => void>();
  const setActiveRoute = vi.fn<(r: SavedRoute | null, fit?: boolean, persist?: boolean) => void>();
  planner.initPlanner({
    settings: { speedKmh: 4, profile: 'hiking-beta' } as Settings,
    saveRoute,
    setActiveRoute,
    hidePanel
  });
  const $ = (id: string) => document.getElementById(id)!;
  const shown = (id: string) => !$(id).classList.contains('hidden');
  return {
    planner,
    hidePanel,
    saveRoute,
    setActiveRoute,
    routeMixed: vi.mocked(routeMixed),
    $,
    shown,
    tap: (id: string) => $(id).click(),
    /** Let the router's debounce run out and its answer land. */
    settle: () => vi.advanceTimersByTimeAsync(400),
    /** Tap the Plan tab, as a thumb would. */
    tapPlan: () => $('btnPlan').click(),
    /** Tap the map where a finger would, adding a waypoint. */
    tapMap: (lat: number, lng: number) => stub.map.fire('click', { latlng: { lat, lng } }),
    tabLit: () => $('btnPlan').classList.contains('active'),
    barUp: () => shown('planSheet'),
    /** The waypoint markers still drawn — the sketch, as the map holds it. */
    get sketch() {
      return stub.map.layers.filter((l) => l.kind === 'marker');
    }
  };
}

beforeEach(async () => {
  stub = await leaflet;
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('entering Plan', () => {
  it('puts away a sheet another tab left open', async () => {
    const p = await boot();
    p.tapPlan();
    expect(p.hidePanel).toHaveBeenCalledTimes(1);
    expect(p.planner.isPlanning()).toBe(true);
    expect(p.barUp()).toBe(true);
  });

  it('leaves its own tab lit, though hidePanel un-lights the sheet tabs', async () => {
    // hidePanel() clears btnMap/btnRoutes/btnSettings and runs a moment *after*
    // the Plan tab is lit. If it ever swept Plan up with them, the tab would go
    // dark the instant you entered the mode.
    const p = await boot();
    p.tapPlan();
    expect(p.tabLit()).toBe(true);
  });

  it('does not reach for the sheet on the way back out', async () => {
    const p = await boot();
    p.tapPlan();
    p.tapPlan();
    expect(p.hidePanel).toHaveBeenCalledTimes(1);
    expect(p.planner.isPlanning()).toBe(false);
  });
});

describe('endPlanning', () => {
  it('steps out of the mode and hands the map back', async () => {
    const p = await boot();
    p.tapPlan();
    p.planner.endPlanning();
    expect(p.planner.isPlanning()).toBe(false);
    expect(p.tabLit()).toBe(false);
    expect(p.barUp()).toBe(false);
    expect(document.body.classList.contains('planning')).toBe(false);
  });

  it('does nothing at all when no route is being sketched', async () => {
    const p = await boot();
    p.planner.endPlanning();
    expect(p.planner.isPlanning()).toBe(false);
    expect(p.barUp()).toBe(false);
  });

  it('keeps the sketch, so opening a sheet mid-route costs you nothing', async () => {
    const p = await boot();
    p.tapPlan();
    p.tapMap(54.45, -3.21);
    p.tapMap(54.46, -3.22);
    expect(p.sketch).toHaveLength(2);

    p.planner.endPlanning(); // what showPanel() does when a sheet opens

    // Still drawn, and still the planner's: only Done and Clear throw a plan
    // away. Tapping Plan again picks it straight back up.
    expect(p.sketch).toHaveLength(2);
    p.tapPlan();
    expect(p.planner.isPlanning()).toBe(true);
    expect(p.sketch).toHaveLength(2);
    p.tapMap(54.47, -3.23);
    expect(p.sketch).toHaveLength(3);
  });

  it('stops the map taking taps as waypoints once it is off', async () => {
    const p = await boot();
    p.tapPlan();
    p.tapMap(54.45, -3.21);
    p.planner.endPlanning();
    p.tapMap(54.47, -3.25); // a tap meant for the map, not the sketch
    expect(p.sketch).toHaveLength(1);
  });
});

describe('the Plan sheet', () => {
  /** Into Plan with a two-point route that the router has already answered. */
  async function routed() {
    const p = await boot();
    p.routeMixed.mockResolvedValue(ROUTED);
    p.tapPlan();
    p.tapMap(54.45, -3.21);
    p.tapMap(54.46, -3.22);
    await p.settle();
    return p;
  }

  it('closes like any other sheet, and the sketch survives it', async () => {
    const p = await boot();
    p.tapPlan();
    p.tapMap(54.45, -3.21);
    p.tap('planClose');
    expect(p.planner.isPlanning()).toBe(false);
    expect(p.barUp()).toBe(false);
    expect(p.tabLit()).toBe(false);
    expect(p.sketch).toHaveLength(1);
  });

  it('will not save until there is a route to save', async () => {
    const p = await boot();
    p.routeMixed.mockResolvedValue(ROUTED);
    p.tapPlan();
    const save = p.$('planSave') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect((p.$('planUndo') as HTMLButtonElement).disabled).toBe(true);

    p.tapMap(54.45, -3.21);
    p.tapMap(54.46, -3.22);
    expect(save.disabled).toBe(true); // asked, not yet answered
    await p.settle();

    expect(save.disabled).toBe(false);
    expect(p.$('planDist').textContent).toBe('8.4 km');
    expect(p.$('planDistSub').textContent).toBe('5.2 mi');
    expect(p.$('planUp').textContent).toBe('↑ 412 m');
    expect(p.shown('planHint')).toBe(false);
  });

  it('names and keeps the route in the sheet, then shows it', async () => {
    const p = await routed();
    p.tap('planSave');
    expect(p.shown('planName')).toBe(true);
    expect(p.shown('planDraw')).toBe(false);
    p.tapMap(54.47, -3.23); // a stray tap while naming must not change the route
    expect(p.sketch).toHaveLength(2);

    (p.$('planNameInput') as HTMLInputElement).value = '  Stickle Tarn  ';
    p.tap('planSaveConfirm');

    expect(p.saveRoute).toHaveBeenCalledTimes(1);
    const saved = p.saveRoute.mock.calls[0][0];
    expect(saved.name).toBe('Stickle Tarn');
    expect(p.setActiveRoute).toHaveBeenLastCalledWith(saved, false);
    expect(p.planner.isPlanning()).toBe(false);
    expect(p.sketch).toHaveLength(0);
  });

  it('saves under a default name when the box is left empty', async () => {
    const p = await routed();
    p.tap('planSave');
    p.tap('planSaveConfirm');
    expect(p.saveRoute.mock.calls[0][0].name).toBe('My route');
  });

  it('can show the route without keeping it', async () => {
    const p = await routed();
    p.tap('planSave');
    p.tap('planShowOnly');
    expect(p.saveRoute).not.toHaveBeenCalled();
    expect(p.setActiveRoute.mock.lastCall?.[0]?.name).toBe('Unsaved route');
    expect(p.planner.isPlanning()).toBe(false);
  });

  it('goes back to drawing from the name step, and reopens on drawing', async () => {
    const p = await routed();
    p.tap('planSave');
    p.tap('planBack');
    expect(p.shown('planDraw')).toBe(true);
    p.tapMap(54.47, -3.23);
    expect(p.sketch).toHaveLength(3);

    await p.settle();
    p.tap('planSave');
    p.tapPlan(); // out, mid-naming
    p.tapPlan(); // and back
    expect(p.shown('planDraw')).toBe(true);
    expect(p.shown('planName')).toBe(false);
  });

  it('switches how the next points join, and shows which is on', async () => {
    const p = await boot();
    p.tapPlan();
    p.tap('planSnapStraight');
    expect(p.$('planSnapStraight').getAttribute('aria-pressed')).toBe('true');
    expect(p.$('planSnapPaths').classList.contains('sel')).toBe(false);
    p.tap('planSnapPaths');
    expect(p.$('planSnapPaths').getAttribute('aria-pressed')).toBe('true');
  });
});
