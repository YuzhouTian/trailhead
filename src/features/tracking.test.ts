// What the walker is told about where they are. The precedence is the whole
// point: at the tarn you asked for, "OFF ROUTE" is technically true and useless.
//
// tracking.ts owns the map marker and the GPS watch, so it drags Leaflet and the
// map in with it — stubbed here, because none of that has anything to do with
// the reading bannerFor takes of a fix.

vi.mock('../leaflet-setup', () => ({ default: { divIcon: () => ({}) } }));
vi.mock('../map/map', () => ({ map: {} }));
vi.mock('../ui/dom', () => ({ $: () => ({}), svgUse: () => '', toast: () => {} }));
vi.mock('../ui/routeCard', () => ({
  climbText: () => '',
  updateRouteCard: () => {}
}));

import { describe, expect, it, vi } from 'vitest';
import { ARRIVAL_M, OFF_ROUTE_THRESHOLD_M } from '../config';
import { haversine, type LatLng, type RouteProgress } from '../geo';
import type { SavedRoute } from '../state';
import { bannerFor } from './tracking';

const TARN: LatLng = [54.468, -3.21];

/** A point `m` metres north of `p` — the simplest way to sit a known distance
    from somewhere. Checked against the real haversine below, so the crude
    degrees-per-metre here can't quietly put a case on the wrong side of a
    threshold. */
const northOf = (p: LatLng, m: number): LatLng => [p[0] + m / 111_320, p[1]];

/** A "Directions to" route: what matters is detourTo and where it ends. */
const directions = (): SavedRoute =>
  ({
    id: '1',
    name: 'Directions to Sprinkling Tarn',
    waypoints: null,
    coords: [[54.4271, -3.2472], [54.45, -3.23], TARN],
    distanceM: 5400,
    ascentM: 420,
    detourTo: 'Sprinkling Tarn',
    createdAt: 0
  }) as SavedRoute;

/** An ordinary saved walk, which happens to end in the same place. */
const walk = (): SavedRoute => ({ ...directions(), name: 'Scafell Pike', detourTo: undefined });

const at = (offRouteM: number): RouteProgress => ({ alongM: 100, offRouteM }) as RouteProgress;

describe('arriving', () => {
  it('is announced by name once you are inside the threshold', () => {
    const banner = bannerFor(northOf(TARN, 20), directions(), at(5));
    expect(banner.text).toBe('Arrived at Sprinkling Tarn');
    expect(banner.className).toBe('arrive');
  });

  it('outranks the line, which is the entire reason it is checked first', () => {
    // Standing at the tarn, 500 m from where the router's path happened to run.
    // "OFF ROUTE" here is true and completely unhelpful.
    expect(bannerFor(northOf(TARN, 10), directions(), at(500)).text).toBe(
      'Arrived at Sprinkling Tarn'
    );
  });

  it('is not claimed from just outside the threshold', () => {
    const short = northOf(TARN, ARRIVAL_M - 5);
    const long = northOf(TARN, ARRIVAL_M + 5);
    // The helper's arithmetic is crude, so pin both sides against the real one.
    expect(haversine(TARN, short)).toBeLessThan(ARRIVAL_M);
    expect(haversine(TARN, long)).toBeGreaterThan(ARRIVAL_M);
    expect(bannerFor(short, directions(), at(500)).className).toBe('arrive');
    expect(bannerFor(long, directions(), at(500)).className).toBe('off');
  });

  it('is measured to the destination, not to the nearest point of the line', () => {
    // Hard against the line and barely started: on route, nowhere near arriving.
    const start: LatLng = [54.4271, -3.2472];
    expect(bannerFor(start, directions(), at(2)).text).toBe('On route · 2 m from line');
  });

  it('is never claimed for a route that leads nowhere in particular', () => {
    // A walk that ends where you are standing is a walk you finished, not a
    // destination you were sent to — and there is no name to announce.
    const banner = bannerFor(northOf(TARN, 5), walk(), at(5));
    expect(banner.className).toBe('');
    expect(banner.text).not.toContain('Arrived');
    expect(banner.text).not.toContain('undefined');
  });
});

describe('while still walking', () => {
  it('says how far off the line you are, to the metre', () => {
    expect(bannerFor(northOf(TARN, 900), directions(), at(12.4)).text).toBe(
      'On route · 12 m from line'
    );
  });

  it('holds "on route" right up to the threshold, and gives way past it', () => {
    const far = northOf(TARN, 900);
    expect(bannerFor(far, directions(), at(OFF_ROUTE_THRESHOLD_M)).className).toBe('');
    expect(bannerFor(far, directions(), at(OFF_ROUTE_THRESHOLD_M + 0.1)).className).toBe('off');
  });

  it('switches to a formatted distance once off the line, where metres stop helping', () => {
    const banner = bannerFor(northOf(TARN, 900), directions(), at(2500));
    expect(banner.className).toBe('off');
    expect(banner.text).toMatch(/^OFF ROUTE · .+ away$/);
    expect(banner.text).toContain('km');
  });

  it('still says something when the fix cannot be placed on the route at all', () => {
    // No projection rather than a distant one. Saying nothing would leave the
    // banner holding whatever it said last.
    const banner = bannerFor(northOf(TARN, 900), directions(), null);
    expect(banner.className).toBe('off');
    expect(banner.text).toContain('OFF ROUTE');
  });
});
