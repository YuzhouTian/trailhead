// @vitest-environment jsdom

// What the walker is told about where they are, and what the map does about it.
//
// Two halves. The readings — the banner's precedence and what a tap of Me means
// — are pure functions, tested by asking them questions. The wiring is not: a
// fix landing has to move the dot, recentre the map, repaint the button and
// refresh the card, and no amount of testing bannerFor in isolation says
// whether any of that is connected. So the second half boots the real module
// against a Leaflet that draws nothing and records everything, and drives it
// with the fixes a phone would produce.
//
// The map, the dot and the accuracy circle are all the stub's; the DOM is
// jsdom's, built from the same ids index.html uses. Nothing here renders, and
// nothing needs a hill.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const leaflet = vi.hoisted(async () => {
  const { createLeafletStub } = await import('../testing/leaflet-stub');
  return createLeafletStub();
});

vi.mock('../leaflet-setup', async () => ({ default: (await leaflet).L }));
vi.mock('../map/map', async () => ({ map: (await leaflet).map }));
// The card is a different module's job. What matters here is only that tracking
// asks for it after every fix, so the progress line cannot go stale.
vi.mock('../ui/routeCard', () => ({ climbText: () => '', updateRouteCard: vi.fn() }));

import { ARRIVAL_M, OFF_ROUTE_THRESHOLD_M } from '../config';
import { haversine, type LatLng, type RouteProgress } from '../geo';
import type { SavedRoute } from '../state';
import { $ } from '../ui/dom';
import { bannerFor, locateAction } from './tracking';

const stub = await leaflet;

const TARN: LatLng = [54.468, -3.21];
const START: LatLng = [54.4271, -3.2472];

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
    coords: [START, [54.45, -3.23], TARN],
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
    expect(bannerFor(START, directions(), at(2)).text).toBe('On route · 2 m from line');
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

// What a tap of Me does. The button has no off step, so the whole of its
// behaviour is this precedence: fix the watch, else come back to me, else turn
// the map. Get it wrong and a walker who tapped "take me back" gets a spinning
// map of somewhere they are not standing.
describe('the Me button', () => {
  const state = (o: Partial<Parameters<typeof locateAction>[0]> = {}) => ({
    failed: false,
    follow: true,
    headingOn: false,
    ...o
  });

  it('toggles rotation while the map is on you, in both directions', () => {
    expect(locateAction(state({ headingOn: false }))).toBe('heading-up');
    expect(locateAction(state({ headingOn: true }))).toBe('north-up');
  });

  it('brings you back once the map has moved off you', () => {
    expect(locateAction(state({ follow: false }))).toBe('recentre');
  });

  it('brings you back rather than rotating, which is the point of the order', () => {
    // Panned away in heading-up. Turning the map further is not what the tap
    // was for; the map is not even on you to turn around.
    expect(locateAction(state({ follow: false, headingOn: true }))).toBe('recentre');
  });

  it('offers a retry above everything once the watch has given up', () => {
    // With no off step, this is the only way back to a dot — so it has to win
    // from every combination of the others.
    for (const follow of [true, false]) {
      for (const headingOn of [true, false]) {
        expect(locateAction({ failed: true, follow, headingOn })).toBe('retry');
      }
    }
  });

  it('never switches GPS off, from any state', () => {
    const actions = new Set<string>();
    for (const failed of [true, false]) {
      for (const follow of [true, false]) {
        for (const headingOn of [true, false]) {
          actions.add(locateAction({ failed, follow, headingOn }));
        }
      }
    }
    expect([...actions].sort()).toEqual(['heading-up', 'north-up', 'recentre', 'retry']);
  });
});

// ---------------------------------------------------------------- the wiring

/** The parts of index.html that tracking writes to, and nothing else. */
const PAGE = `
  <div id="statusBanner" class="hidden"></div>
  <button id="btnLocate"><span class="ico" id="locateIco"></span></button>
  <div id="toast" class="hidden"></div>
`;

/**
 * navigator.geolocation, under the test's control. jsdom has none of its own,
 * and the real one is a phone on a hill: this hands back a watch that produces
 * exactly the fixes a test asks for, and fails when it says to.
 */
function stubGeolocation() {
  let onFix: ((p: GeolocationPosition) => void) | null = null;
  let onError: ((e: GeolocationPositionError) => void) | null = null;
  let watchId: number | null = null;
  let opened = 0;
  const cleared: number[] = [];
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: {
      watchPosition(fix: (p: GeolocationPosition) => void, err: (e: GeolocationPositionError) => void) {
        onFix = fix;
        onError = err;
        watchId = ++opened;
        return watchId;
      },
      clearWatch: (id: number) => void cleared.push(id),
      getCurrentPosition() {}
    }
  });
  return {
    /** Whether a watch is running that nobody has cleared. */
    get watching() {
      return watchId !== null && !cleared.includes(watchId);
    },
    /** Land a fix, as the phone would, every second or so. */
    fix(p: LatLng, accuracy = 8) {
      onFix?.({ coords: { latitude: p[0], longitude: p[1], accuracy } } as GeolocationPosition);
    },
    /** How many watches have been opened, restarts included. */
    get opened() {
      return opened;
    },
    /** Refuse permission, which is the one error the watch gives up on. */
    deny(message = 'User denied Geolocation') {
      onError?.({ code: 1, message } as GeolocationPositionError);
    },
    /** Lose the signal: a timeout (3) by default, or position unavailable (2). */
    fail(message = 'Timeout expired', code = 3) {
      onError?.({ code, message } as GeolocationPositionError);
    }
  };
}

/**
 * The compass, under the test's control. jsdom has neither half of it: not the
 * DeviceOrientationEvent static that tracking reads iOS's permission prompt
 * off, and not the events themselves. Its requestAnimationFrame is replaced
 * too, since the easing towards a new reading is spread over frames and
 * racing a real clock for them would make every assertion here a coin toss.
 * So readings land when a test says so, and frames run when a test says so.
 */
function stubCompass() {
  let permission = 'granted';
  Object.defineProperty(globalThis, 'DeviceOrientationEvent', {
    configurable: true,
    value: { requestPermission: async () => permission }
  });

  let frames: FrameRequestCallback[] = [];
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    frames.push(cb)) as typeof requestAnimationFrame;
  // Only ever one frame is in flight here, so dropping the lot is the same
  // thing as cancelling the id — and the id is never compared to anything.
  globalThis.cancelAnimationFrame = (() => void (frames = [])) as typeof cancelAnimationFrame;

  return {
    /** As a refused permission prompt, or a phone with no compass in it. */
    deny() {
      permission = 'denied';
    },
    /** Turn to face `deg` clockwise from north, and let the map catch up. */
    turn(deg: number) {
      const e = new Event('deviceorientation');
      Object.assign(e, { webkitCompassHeading: deg });
      window.dispatchEvent(e);
      // The easing chases by a quarter of what is left each frame and stops
      // inside a quarter-degree, so this always terminates well short of the cap.
      for (let i = 0; frames.length && i < 500; i++) {
        const due = frames;
        frames = [];
        for (const cb of due) cb(0);
      }
    }
  };
}

/**
 * A tracking module with nothing behind it: fresh module state, a blank page, a
 * map that has never moved, and a GPS that says nothing until asked.
 *
 * The module reset is the part that matters. tracking owns its watch, its
 * latest fix and its dot privately for the life of the session — right for
 * something that runs once, and the reason a test can only get back to zero by
 * throwing the module away and importing it again.
 */
async function boot(route: SavedRoute | null = null) {
  vi.resetModules();
  document.body.innerHTML = PAGE;
  stub.reset();
  const gps = stubGeolocation();
  const compass = stubCompass();
  const card = await import('../ui/routeCard');
  const tracking = await import('./tracking');
  let positions = 0;
  /** A hand on the map, which is what tells a walker's zoom from the app's. */
  const hand = (): void => void stub.map.getContainer().dispatchEvent(new Event('touchstart'));
  tracking.initTracking({
    getActiveRoute: () => route,
    onPosition: () => void positions++
  });
  return {
    tracking,
    gps,
    compass,
    map: stub.map,
    updateRouteCard: vi.mocked(card.updateRouteCard),
    /** The one marker and the one circle, once a fix has built them. */
    get dot() {
      return stub.created.find((l) => l.kind === 'marker');
    },
    get accuracy() {
      return stub.created.find((l) => l.kind === 'circle');
    },
    get banner() {
      return $('statusBanner');
    },
    get button() {
      return $('btnLocate');
    },
    /** Which of index.html's icon symbols the Me button is showing. The
        reference rather than the markup: jsdom re-serialises the self-closing
        <use/> svgUse writes, so comparing strings would fail on punctuation. */
    get glyph() {
      return $('locateIco').querySelector('use')?.getAttribute('href');
    },
    /** How many times anything that shows a distance from you was told to refresh. */
    get positions() {
      return positions;
    },
    hand,
    /** Zoom the map the way a thumb does: a hand on it, then the zoomstart
        Leaflet fires off the back of the gesture. */
    zoomByHand() {
      hand();
      stub.map.fire('zoomstart');
    },
    /** Tap Me and let the handler finish — turning the compass on awaits a
        permission prompt, so the button's work outlives the click itself. */
    async tap() {
      $('btnLocate').click();
      await new Promise((r) => setTimeout(r, 0));
    }
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the dot', () => {
  it('is not on the map until there is a fix to put it at', async () => {
    const t = await boot();
    expect(t.map.layers).toHaveLength(0);
    // The watch is running all the same — there is no first tap to wait for.
    expect(t.gps.watching).toBe(true);
  });

  it('appears on the first fix, with the accuracy circle around it', async () => {
    const t = await boot();
    t.gps.fix(START, 12);
    expect(t.dot?.latlng).toEqual(START);
    expect(t.dot?.onMap).toBe(true);
    expect(t.accuracy?.latlng).toEqual(START);
    expect(t.accuracy?.radius).toBe(12);
    expect(t.map.layers).toHaveLength(2);
  });

  it('moves on later fixes rather than being drawn again', async () => {
    // A fix a second for a six-hour walk: redrawing would leave 20,000 dots on
    // the map, and the one you are looking at would be the oldest.
    const t = await boot();
    const step: LatLng[] = [START, northOf(START, 30), northOf(START, 60)];
    for (const p of step) t.gps.fix(p, 9);
    expect(stub.created).toHaveLength(2);
    expect(t.dot?.track).toEqual(step);
    expect(t.dot?.latlng).toEqual(step[2]);
  });

  it('keeps the accuracy circle honest as the fix settles', async () => {
    const t = await boot();
    t.gps.fix(START, 40);
    expect(t.accuracy?.radius).toBe(40);
    t.gps.fix(START, 6);
    expect(t.accuracy?.radius).toBe(6);
  });

  it('reads out the latest position when tapped, not the one it was built at', async () => {
    // The popup is built lazily on open for exactly this reason — a grid ref
    // for where you stood an hour ago is worse than none at all.
    const t = await boot();
    t.gps.fix(START, 5);
    const first = t.dot?.popup?.();
    t.gps.fix(TARN, 5);
    const later = t.dot?.popup?.();
    expect(first).toBeTruthy();
    expect(later).not.toBe(first);
    expect(later).toContain('±5 m');
  });
});

describe('following you', () => {
  it('recentres on every fix, without animating', async () => {
    // Fixes arrive faster than a pan animation finishes, and queueing one per
    // fix is what made the map judder and then stall entirely in the background.
    const t = await boot();
    t.gps.fix(START);
    t.gps.fix(TARN);
    expect(t.map.views.map((v) => v.center)).toEqual([START, TARN]);
    expect(t.map.views.every((v) => v.options.animate === false)).toBe(true);
  });

  it('zooms in far enough to be useful, and no further out than you already were', async () => {
    const zoomedOut = await boot();
    zoomedOut.map.zoom = 11;
    zoomedOut.gps.fix(START);
    expect(zoomedOut.map.views[0].zoom).toBe(15);

    const zoomedIn = await boot();
    zoomedIn.map.zoom = 18;
    zoomedIn.gps.fix(START);
    expect(zoomedIn.map.views[0].zoom).toBe(18);
  });

  it('stops recentring once you drag the map, and keeps everything else', async () => {
    // The bug this rule exists for: open a pin, and the next fix a second later
    // drags the map straight back to you. A drag says the same "show me this".
    const t = await boot(directions());
    t.gps.fix(START);
    expect(t.map.views).toHaveLength(1);

    t.map.fire('dragstart');
    t.gps.fix(northOf(START, 40));

    expect(t.map.views).toHaveLength(1); // the map stayed where you put it
    expect(t.dot?.latlng).toEqual(northOf(START, 40)); // the dot did not
    expect(t.banner.classList.contains('hidden')).toBe(false);
    expect(t.positions).toBe(2);
  });

  it('stops recentring once you zoom the map, which says the same as a drag', async () => {
    // Pinching out to see where the ridge goes is looking away from yourself
    // exactly as a drag is. Leaving follow on there was the worse of the two:
    // the next fix hauled the map back to the dot and threw the zoom away with
    // it, so a wider view was not something you could get at all.
    const t = await boot();
    t.gps.fix(START);
    expect(t.map.views).toHaveLength(1);

    t.map.zoom = 12; // you pinched out
    t.zoomByHand();
    t.gps.fix(northOf(START, 40));

    expect(t.map.views).toHaveLength(1); // the map stayed where you left it
    expect(t.map.zoom).toBe(12); // at the scale you chose
    expect(t.dot?.latlng).toEqual(northOf(START, 40)); // the dot still moved
    expect(t.button.classList.contains('active')).toBe(false);
  });

  it('keeps following through a zoom the app made itself', async () => {
    // zoomstart is fired by the startup jump to your area, by the clamp after
    // a shallower base layer is chosen, and by following's own recentre. None
    // of those is you looking away, and dropping follow on them would turn Me
    // off with nothing on screen to explain why.
    const t = await boot();
    t.gps.fix(START);

    t.map.fire('zoomstart'); // no hand anywhere near the map
    t.gps.fix(TARN);

    expect(t.map.views.map((v) => v.center)).toEqual([START, TARN]);
    expect(t.button.classList.contains('active')).toBe(true);
  });

  it('zooms in on the fix that comes to get you, and not on the ones after it', async () => {
    // The floor belongs to coming back, not to keeping up. Re-applying it
    // every second is what took a wider view off the walker before they could
    // read it — so the pause rule above is the fix, and this is the belt to
    // its braces: even a zoom that slips past the hand test survives.
    const t = await boot();
    t.map.zoom = 11;
    t.gps.fix(START);
    expect(t.map.views[0].zoom).toBe(15);

    t.map.zoom = 12;
    t.gps.fix(TARN);
    expect(t.map.views[1].zoom).toBe(12);
  });

  it('does not claim the map is on you before the first fix, or after a drag', async () => {
    const t = await boot();
    expect(t.button.classList.contains('active')).toBe(false);
    expect(t.glyph).toBe('#i-locate');

    t.gps.fix(START);
    expect(t.button.classList.contains('active')).toBe(true);
    expect(t.glyph).toBe('#i-locate-on');

    t.map.fire('dragstart');
    expect(t.button.classList.contains('active')).toBe(false);
    expect(t.glyph).toBe('#i-locate');
  });
});

// Heading-up: the map turned so that up is the way you are facing. What the
// mode is for is reading the ground in front of you off the map without doing
// the rotation in your head, and that is worth exactly as much when you have
// pushed the map along to see what is coming as when it sits on your dot.
describe('turning the map with you', () => {
  /** On your dot in heading-up, facing `deg` clockwise from north. */
  const facing = async (deg: number) => {
    const t = await boot();
    t.gps.fix(START);
    await t.tap();
    t.compass.turn(deg);
    return t;
  };

  it('rotates to put the way you are facing at the top', async () => {
    const t = await facing(90);
    // Facing east, so the map turns a quarter anticlockwise to bring east up.
    expect(t.map.bearing).toBeCloseTo(-90, 0);
    expect(t.glyph).toBe('#i-compass');
    expect(t.button.classList.contains('active')).toBe(true);
  });

  it('keeps turning with you while you look around the map', async () => {
    const t = await facing(90);
    const squarings = () => t.map.bearings.filter((b) => b === 0).length;

    t.map.fire('dragstart');
    expect(t.map.bearing).toBeCloseTo(-90, 0); // the drag did not square it up
    expect(squarings()).toBe(0);

    t.compass.turn(180);
    expect(t.map.bearing).toBeCloseTo(-180, 0); // and it is still your body it follows
    // The drag used to announce the squaring-up it was doing. Nothing to say
    // now: the toast still holds the "tap again for north-up" from turning the
    // compass on, and no drag has added to it.
    expect($('toast').textContent).not.toContain('Back to north-up');
  });

  it('says it is still turning but no longer on you, one fact per channel', async () => {
    const t = await facing(90);
    t.map.fire('dragstart');
    expect(t.glyph).toBe('#i-compass'); // the shape: still turning with you
    expect(t.button.classList.contains('active')).toBe(false); // the colour: not on you
  });

  it('comes back heading-up, and squares to north only on the tap after that', async () => {
    // Two taps, two jobs, in the order the walker wants them: the first is
    // "take me back", which is no use if it also stops the rotation, and the
    // second is the one that means "stop turning".
    const t = await facing(90);
    t.map.fire('dragstart');
    const before = t.map.views.length;

    await t.tap();
    expect(t.map.views).toHaveLength(before + 1);
    expect(t.map.views[before].center).toEqual(START);
    expect(t.map.bearing).toBeCloseTo(-90, 0);
    expect(t.glyph).toBe('#i-compass');
    expect(t.button.classList.contains('active')).toBe(true);

    await t.tap();
    expect(t.map.bearing).toBe(0);
    expect(t.glyph).toBe('#i-locate-on');
  });

  it('stays north-up when the compass is refused, and keeps the dot', async () => {
    // The compass is the only thing that failed. Taking the dot away over it
    // would cost the walker something they had.
    const t = await boot();
    t.gps.fix(START);
    t.compass.deny();
    await t.tap();

    expect(t.map.bearing).toBe(0);
    expect(t.glyph).toBe('#i-locate-on');
    expect(t.dot?.onMap).toBe(true);
    expect($('toast').textContent).toContain('Compass not available');
  });
});

describe('when the signal is lost', () => {
  it('keeps the dot, following and the banner where they were', async () => {
    // A timeout is trees, a building, or a desktop slow to answer — not a
    // refusal. Taking the dot away over one left Me doing nothing visible.
    const t = await boot(directions());
    t.gps.fix(START);
    t.gps.fail();

    expect(t.dot?.onMap).toBe(true);
    expect(t.gps.watching).toBe(true);
    expect(t.button.classList.contains('failed')).toBe(false);
    expect(t.button.classList.contains('active')).toBe(true);
    expect(t.tracking.getLastFix()).toEqual(START);
    expect(t.banner.classList.contains('hidden')).toBe(false);
    expect($('toast').textContent).toContain('signal lost');
  });

  it('asks the device again after a pause, and picks up from the next fix', async () => {
    vi.useFakeTimers();
    try {
      const t = await boot();
      t.gps.fix(START);
      t.gps.fail('Position unavailable', 2);
      expect(t.gps.opened).toBe(1);

      vi.advanceTimersByTime(5000);
      expect(t.gps.opened).toBe(2);
      expect(t.gps.watching).toBe(true);

      t.gps.fix(TARN);
      expect(t.dot?.latlng).toEqual(TARN);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says so once per outage, not on every timeout', async () => {
    const t = await boot();
    t.gps.fix(START);
    t.gps.fail();
    $('toast').textContent = '';
    t.gps.fail();
    expect($('toast').textContent).toBe('');

    t.gps.fix(TARN); // back
    t.gps.fail(); // and lost again, which is news
    expect($('toast').textContent).toContain('signal lost');
  });
});

describe('when the watch gives up', () => {
  it('takes the dot away and leaves the button reading as a retry', async () => {
    const t = await boot(directions());
    t.gps.fix(START);
    t.gps.deny();

    expect(t.map.layers).toHaveLength(0);
    expect(t.dot?.onMap).toBe(false);
    expect(t.gps.watching).toBe(false);
    expect(t.button.classList.contains('failed')).toBe(true);
    expect(t.button.classList.contains('active')).toBe(false);
    expect(t.tracking.getLastFix()).toBeNull();
  });

  it('says what happened rather than going quiet', async () => {
    const t = await boot();
    t.gps.fix(START);
    t.gps.deny('User denied Geolocation');
    expect($('toast').classList.contains('hidden')).toBe(false);
    expect($('toast').textContent).toContain('User denied Geolocation');
  });

  it('keeps the last position it knew, so distances to pins survive it', async () => {
    // Deliberate: the banner and the progress readout should go quiet without a
    // live fix, but "how far is that pin" is still worth answering from where
    // you last were.
    const t = await boot();
    t.gps.fix(TARN);
    t.gps.deny();
    expect(t.tracking.getLastFix()).toBeNull();
    expect(t.tracking.getKnownPosition()).toEqual(TARN);
  });

  it('hides the banner, which would otherwise hold a stale reading', async () => {
    const t = await boot(directions());
    t.gps.fix(START);
    expect(t.banner.classList.contains('hidden')).toBe(false);
    t.gps.deny();
    expect(t.banner.classList.contains('hidden')).toBe(true);
  });
});

describe('the banner, as fixes land', () => {
  it('says nothing at all when there is no route to be on or off', async () => {
    const t = await boot(null);
    t.gps.fix(START);
    expect(t.banner.classList.contains('hidden')).toBe(true);
  });

  it('reaches the walker, which is the half bannerFor cannot show', async () => {
    const t = await boot(directions());
    t.gps.fix(northOf(START, 10));
    expect(t.banner.classList.contains('hidden')).toBe(false);
    expect(t.banner.className).toBe('');
    expect(t.banner.textContent).toMatch(/^On route · \d+ m from line$/);
  });

  it('turns over as you wander off the line and arrive at the end', async () => {
    const t = await boot(directions());
    t.gps.fix(northOf(START, 5));
    expect(t.banner.className).toBe('');

    t.gps.fix(northOf(START, 2000));
    expect(t.banner.className).toBe('off');
    expect(t.banner.textContent).toContain('OFF ROUTE');

    t.gps.fix(northOf(TARN, 10));
    expect(t.banner.className).toBe('arrive');
    expect(t.banner.textContent).toBe('Arrived at Sprinkling Tarn');
  });

  it('refreshes the route card on every fix, so the progress line cannot go stale', async () => {
    const t = await boot(directions());
    t.gps.fix(START);
    t.gps.fix(northOf(START, 30));
    expect(t.updateRouteCard).toHaveBeenCalledTimes(2);
  });
});
