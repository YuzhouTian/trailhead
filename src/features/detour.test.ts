// "Directions to" is orchestration, not arithmetic: which point it routes from,
// what it does when the router is unreachable, and what it refuses to do to the
// route you were already on. So the collaborators are stubbed and the tests are
// about those decisions — the ones the feature would be wrong without.

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('../routing', () => ({ routeMixed: vi.fn() }));
vi.mock('./tracking', () => ({
  getLastFix: vi.fn(),
  getKnownPosition: vi.fn(),
  setKnownPosition: vi.fn()
}));
vi.mock('../ui/dom', () => ({ toast: vi.fn() }));

import { haversine, type LatLng } from '../geo';
import { routeMixed } from '../routing';
import type { SavedRoute, Settings } from '../state';
import { toast } from '../ui/dom';
import { directionsTo, initDetour } from './detour';
import { getKnownPosition, getLastFix, setKnownPosition } from './tracking';

const HERE: LatLng = [54.4271, -3.2472];
const ELSEWHERE: LatLng = [54.4, -3.3];
const TARN = { name: 'Sprinkling Tarn', lat: 54.468, lng: -3.21 };
const SUMMIT = { name: 'Great Gable', lat: 54.4823, lng: -3.2192 };

/** What BRouter would have come back with. */
const ROUTED = {
  coords: [HERE, [54.45, -3.23], [TARN.lat, TARN.lng]] as LatLng[],
  distanceM: 5400,
  ascentM: 420,
  descentM: 80
};

/** The app's own setActiveRoute, which is where a finished detour leaves. */
type SetActive = (r: SavedRoute | null, fit?: boolean, persist?: boolean) => void;

let active: SavedRoute | null;
let setActive: Mock<SetActive>;
let said: (string | null)[];
const label = (text: string | null): void => void said.push(text);

/** The device's own answer to "where are you", or its refusal. */
function stubGeolocation(answer: { at: LatLng } | 'fails' | 'absent'): void {
  Object.defineProperty(globalThis, 'navigator', {
    value:
      answer === 'absent'
        ? {}
        : {
            geolocation: {
              getCurrentPosition: (ok: (p: unknown) => void, fail: () => void) =>
                answer === 'fails'
                  ? fail()
                  : ok({ coords: { latitude: answer.at[0], longitude: answer.at[1] } })
            }
          },
    configurable: true
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  active = null;
  setActive = vi.fn<SetActive>((r) => {
    active = r;
  });
  said = [];
  initDetour({
    settings: { profile: 'hiking-mountain' } as Settings,
    getActiveRoute: () => active,
    setActiveRoute: setActive
  });
  vi.mocked(getLastFix).mockReturnValue(HERE);
  vi.mocked(routeMixed).mockResolvedValue(ROUTED);
  globalThis.confirm = vi.fn(() => true);
  stubGeolocation('absent');
});

/** The route handed to setActiveRoute by the call under test. */
const planted = (): SavedRoute => setActive.mock.calls[0][0] as SavedRoute;

describe('the route a set of directions produces', () => {
  it('is named for where it leads, and marked as the way there', async () => {
    expect(await directionsTo(TARN, label)).toBe(true);
    expect(planted().name).toBe('Directions to Sprinkling Tarn');
    // detourTo carries the name, not a bare flag, so the arrival banner can say
    // where you arrived without taking the route's own name apart.
    expect(planted().detourTo).toBe('Sprinkling Tarn');
    expect(planted().straightLine).toBeFalsy();
  });

  it('carries the two waypoints it was built from, so it reopens in the planner', async () => {
    await directionsTo(TARN, label);
    expect(planted().waypoints).toEqual([HERE, [TARN.lat, TARN.lng]]);
  });

  it('passes the router the profile the app is set to', async () => {
    await directionsTo(TARN, label);
    expect(vi.mocked(routeMixed).mock.calls[0][2]).toBe('hiking-mountain');
  });

  it('reports what it is doing, then puts the caller back', async () => {
    await directionsTo(TARN, label);
    expect(said).toEqual(['Finding you…', 'Routing…', null]);
  });
});

describe('when the router cannot be reached', () => {
  beforeEach(() => {
    vi.mocked(routeMixed).mockRejectedValue(new Error('Failed to fetch'));
  });

  it('says so in the route it draws, not only in a toast', async () => {
    // A toast is gone in five seconds. A solid line between two points on a
    // hillside claims a way through that nobody has checked, so the fallback
    // has to be legible in the route itself.
    expect(await directionsTo(TARN, label)).toBe(true);
    expect(planted().name).toBe('Straight line to Sprinkling Tarn');
    expect(planted().straightLine).toBe(true);
    expect(toast).toHaveBeenCalled();
  });

  it('draws the bearing itself, and claims no climb along it', async () => {
    await directionsTo(TARN, label);
    expect(planted().coords).toEqual([HERE, [TARN.lat, TARN.lng]]);
    expect(planted().distanceM).toBeCloseTo(haversine(HERE, [TARN.lat, TARN.lng]), 6);
    // Nothing is known about the ground between the two points, so claiming a
    // climb figure would be inventing one.
    expect(planted().ascentM).toBe(0);
    expect(planted().descentM).toBe(0);
  });

  it('still counts as directions, so the caller closes its card', async () => {
    expect(await directionsTo(TARN, label)).toBe(true);
  });
});

describe('a request that was cancelled', () => {
  it('plants nothing, so a straight line is not left behind by a stale tap', async () => {
    // The abort path runs through the same catch as an unreachable router. If
    // it fell through to the fallback, cancelling would draw a bearing you
    // never asked for.
    const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' });
    vi.mocked(routeMixed).mockRejectedValue(aborted);
    expect(await directionsTo(TARN, label)).toBe(false);
    expect(setActive).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it('gives way to the tap that replaced it', async () => {
    const first = directionsTo(TARN, label);
    const second = await directionsTo(SUMMIT, label);
    expect(await first).toBe(false);
    expect(second).toBe(true);
    // The first never got as far as routing, and only one route was planted.
    expect(routeMixed).toHaveBeenCalledTimes(1);
    expect(setActive).toHaveBeenCalledTimes(1);
    expect(planted().detourTo).toBe('Great Gable');
  });
});

describe('the route you were already on', () => {
  const walking = (): SavedRoute =>
    ({ id: '1', name: 'Scafell Pike', waypoints: null, coords: [HERE], distanceM: 1, ascentM: 0, createdAt: 0 }) as SavedRoute;

  it('is not closed without asking, since an unsaved one would be gone', async () => {
    active = walking();
    globalThis.confirm = vi.fn(() => false);
    expect(await directionsTo(TARN, label)).toBe(false);
    expect(routeMixed).not.toHaveBeenCalled();
    expect(setActive).not.toHaveBeenCalled();
    expect(active).toEqual(walking());
  });

  it('is named in the question, alongside where you are asking to go', async () => {
    active = walking();
    await directionsTo(TARN, label);
    expect(vi.mocked(globalThis.confirm).mock.calls[0][0]).toContain('Scafell Pike');
    expect(vi.mocked(globalThis.confirm).mock.calls[0][0]).toContain('Sprinkling Tarn');
  });

  it('goes unmentioned when there is none, rather than asking about nothing', async () => {
    await directionsTo(TARN, label);
    expect(globalThis.confirm).not.toHaveBeenCalled();
  });
});

describe('the point it routes from', () => {
  it('is the live fix when there is one, without troubling the device', async () => {
    // A live fix is seconds old and always wins.
    stubGeolocation({ at: ELSEWHERE });
    await directionsTo(TARN, label);
    expect(vi.mocked(routeMixed).mock.calls[0][0][0]).toEqual(HERE);
  });

  it('is asked of the device when no fix has landed yet', async () => {
    // Routing from the wrong place is worse than waiting a moment.
    vi.mocked(getLastFix).mockReturnValue(null);
    vi.mocked(getKnownPosition).mockReturnValue(ELSEWHERE);
    stubGeolocation({ at: HERE });
    await directionsTo(TARN, label);
    expect(vi.mocked(routeMixed).mock.calls[0][0][0]).toEqual(HERE);
    // And what it learns is kept, so the next caller need not ask again.
    expect(setKnownPosition).toHaveBeenCalledWith(HERE);
  });

  it('falls back to where you last were when the fix never arrives', async () => {
    vi.mocked(getLastFix).mockReturnValue(null);
    vi.mocked(getKnownPosition).mockReturnValue(ELSEWHERE);
    stubGeolocation('fails');
    await directionsTo(TARN, label);
    expect(vi.mocked(routeMixed).mock.calls[0][0][0]).toEqual(ELSEWHERE);
  });

  it('gives up and says so when nothing knows where you are', async () => {
    vi.mocked(getLastFix).mockReturnValue(null);
    vi.mocked(getKnownPosition).mockReturnValue(null);
    stubGeolocation('fails');
    expect(await directionsTo(TARN, label)).toBe(false);
    expect(setActive).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalled();
    // The caller's button is put back rather than left saying "Finding you…".
    expect(said[said.length - 1]).toBe(null);
  });
});
