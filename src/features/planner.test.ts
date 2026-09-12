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

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '../state';

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

/** The ids the planner reaches for, as index.html spells them. */
const PAGE = `
  <button id="btnPlan"></button>
  <div id="planBar" class="hidden">
    <span id="planStats"></span>
    <button id="planSnap"></button>
    <button id="planUndo"></button>
    <button id="planClear"></button>
    <button id="planDone"></button>
  </div>
  <input id="gpxFile" type="file"/>`;

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
  const hidePanel = vi.fn();
  planner.initPlanner({
    settings: { speedKmh: 4, profile: 'hiking-beta' } as Settings,
    saveRoute: vi.fn(),
    setActiveRoute: vi.fn(),
    hidePanel
  });
  const $ = (id: string) => document.getElementById(id)!;
  return {
    planner,
    hidePanel,
    /** Tap the Plan tab, as a thumb would. */
    tapPlan: () => $('btnPlan').click(),
    /** Tap the map where a finger would, adding a waypoint. */
    tapMap: (lat: number, lng: number) => stub.map.fire('click', { latlng: { lat, lng } }),
    tabLit: () => $('btnPlan').classList.contains('active'),
    barUp: () => !$('planBar').classList.contains('hidden'),
    /** The waypoint markers still drawn — the sketch, as the map holds it. */
    get sketch() {
      return stub.map.layers.filter((l) => l.kind === 'marker');
    }
  };
}

beforeEach(async () => {
  stub = await leaflet;
  vi.clearAllMocks();
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
