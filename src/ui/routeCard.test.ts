// @vitest-environment jsdom

// What the route card says: the route's totals when there is nothing to
// measure from, and what is left of it once you are walking. The card is built
// from index.html's own markup rather than a copy of it, so an id renamed on
// one side and not the other fails here instead of leaving a blank cell.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import indexHtml from '../../index.html?raw';

const leaflet = vi.hoisted(async () => {
  const { createLeafletStub } = await import('../testing/leaflet-stub');
  return createLeafletStub();
});

vi.mock('../leaflet-setup', async () => ({ default: (await leaflet).L }));
vi.mock('../map/map', async () => ({ map: (await leaflet).map }));
// The chart stays closed throughout; drawing it is elevation.ts's business.
vi.mock('../elevation', () => ({ moveHere: () => false, renderProfile: () => false }));

import type { LatLng } from '../geo';
import { $ } from './dom';
import { initRouteCard, updateRouteCard, type RouteCardView, type WalkProgress } from './routeCard';

// jsdom has no ResizeObserver; the card only uses it to publish its height.
globalThis.ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver;

const CARD = (() => {
  const doc = new DOMParser().parseFromString(indexHtml, 'text/html');
  return doc.getElementById('routeCard')!.outerHTML;
})();

/** Helvellyn via Striding Edge, as the mockups showed it: 13.8 km, 971 m up and down. */
const route = { coords: [[54.5, -3], [54.51, -3]] as LatLng[], distanceM: 13_800, ascentM: 971, descentM: 971 };

let view: RouteCardView;
const show = (progress: WalkProgress | null): void => {
  view = { src: route, name: 'Helvellyn via Striding Edge', progress, hereM: null, speedKmh: 4 };
  updateRouteCard();
};

const text = (id: string): string => $(id).textContent ?? '';
const cells = () => ({
  labels: [text('rcDistK'), text('rcUpK'), text('rcTimeK')],
  values: [text('rcDist'), text('rcUp'), text('rcTime')],
  subs: [text('rcDistSub'), text('rcDown'), text('rcTimeSub')]
});

beforeEach(() => {
  document.body.innerHTML = CARD;
  initRouteCard({ getView: () => view, onClose: () => {} });
});

describe('with no fix to measure from', () => {
  it('shows the route\'s totals in the same three cells Plan does', () => {
    show(null);
    expect(cells()).toEqual({
      labels: ['Distance', 'Climb', 'Time'],
      values: ['13.8 km', '↑ 971 m', '5 h 04'],
      subs: ['8.6 mi', '↓ 971 m', 'at 4 km/h']
    });
  });

  it('has no progress bar, since there is no progress to draw', () => {
    show(null);
    expect($('rcProgress').classList.contains('hidden')).toBe(true);
  });
});

describe('before the walk has started', () => {
  it('keeps the totals, with an empty bar and how far off the route you are', () => {
    show({ started: false, toRouteM: 350 });
    expect(cells().labels).toEqual(['Distance', 'Climb', 'Time']);
    expect($('rcProgress').classList.contains('hidden')).toBe(false);
    expect($('rcTrackFill').style.width).toBe('0%');
    expect([text('rcWalked'), text('rcOf')]).toEqual(['Not started', '350 m to the route']);
  });
});

describe('while walking', () => {
  const along: WalkProgress = {
    started: true, walkedM: 5_660, totalM: 13_800, remainingM: 8_140, ascentM: 240, descentM: 810
  };

  it('turns the cells to what is left, with the planned day kept under the time', () => {
    show(along);
    expect(cells()).toEqual({
      labels: ['To go', 'Climb left', 'Time left'],
      values: ['8.1 km', '↑ 240 m', '2 h 26'],
      subs: ['5.1 mi', '↓ 810 m', 'of 5 h 04']
    });
  });

  it('draws how far you have come, and says it for a screen reader too', () => {
    show(along);
    expect($('rcTrackFill').style.width).toBe('41%');
    expect($('rcTrack').getAttribute('aria-valuenow')).toBe('41');
    expect([text('rcWalked'), text('rcOf')]).toEqual(['5.7 km walked', '41% of 13.8 km']);
  });

  it('leaves the empty sub lines empty near the end: no miles under a kilometre, no descent once it is done', () => {
    show({ ...along, walkedM: 13_200, remainingM: 600, ascentM: 0, descentM: 0 });
    expect(cells().values.slice(0, 2)).toEqual(['600 m', '↑ 0 m']);
    expect(cells().subs.slice(0, 2)).toEqual(['', '']);
  });

  it('goes back to the totals when the fix is lost', () => {
    show(along);
    show(null);
    expect(cells().labels).toEqual(['Distance', 'Climb', 'Time']);
    expect($('rcProgress').classList.contains('hidden')).toBe(true);
  });
});

it('hides the card when there is no route', () => {
  view = { src: null, name: '', progress: null, hereM: null, speedKmh: 4 };
  updateRouteCard();
  expect($('routeCard').classList.contains('hidden')).toBe(true);
});
