// @vitest-environment jsdom

// The elevation profile's scrubber, and the "you are here" mark that moves
// along it as you walk. What the scrubber has to get right is stubbornness: the
// marker exists so you can look away from the chart and at the map, so lifting
// a finger must not take it away, and neither must the profile being repainted
// underneath it — a turned phone, a chart closed and opened again.
//
// The other half is that a mouse and a finger are scrubbed differently: a mouse
// hovers, a finger has to press. Both leave the marker behind when they go.

import { describe, expect, it, vi } from 'vitest';
import { moveHere, renderProfile, type Scrub } from './elevation';
import { haversine, type LatLng } from './geo';

const W = 360;
const padL = 38;
const padR = 10;

/** A climb: five samples up a line of longitude, rising 100 m at a time. */
const coords: LatLng[] = [
  [54.45, -3.21, 300],
  [54.451, -3.21, 400],
  [54.452, -3.21, 500],
  [54.453, -3.21, 600],
  [54.454, -3.21, 700]
];

function mount(): HTMLElement {
  const container = document.createElement('div');
  document.body.append(container);
  return container;
}

/** Give the SVG the on-screen box jsdom will not lay out for us. */
function measured(container: HTMLElement): SVGSVGElement {
  const svg = container.querySelector('svg')!;
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: W, height: 110 }) as DOMRect;
  return svg;
}

/** Fraction along the chart's plotting area, as a clientX. */
function xAt(fraction: number): number {
  return padL + (W - padL - padR) * fraction;
}

function pointer(
  svg: SVGSVGElement,
  type: string,
  clientX: number,
  pointerType = 'touch'
): void {
  svg.dispatchEvent(
    new PointerEvent(type, { clientX, pointerId: 1, pointerType, bubbles: true })
  );
}

const visible = (container: HTMLElement): boolean =>
  container.querySelector<SVGGElement>('.scrub')!.style.display !== 'none';

describe('renderProfile scrubber', () => {
  it('stays put when the pointer is released', () => {
    const onScrub = vi.fn<(s: Scrub | null) => void>();
    const container = mount();
    renderProfile(container, coords, onScrub);
    const svg = measured(container);

    pointer(svg, 'pointerdown', xAt(0.5));
    pointer(svg, 'pointermove', xAt(0.75));
    pointer(svg, 'pointerup', xAt(0.75));

    expect(visible(container)).toBe(true);
    expect(onScrub).not.toHaveBeenCalledWith(null);
    expect(onScrub).toHaveBeenCalledTimes(2);
  });

  it('ignores a finger that is only passing over', () => {
    const onScrub = vi.fn<(s: Scrub | null) => void>();
    const container = mount();
    renderProfile(container, coords, onScrub);
    const svg = measured(container);

    // A stray touchmove over the chart — no press, so nothing to scrub with.
    pointer(svg, 'pointermove', xAt(0.5));

    expect(visible(container)).toBe(false);
    expect(onScrub).not.toHaveBeenCalled();
  });

  it('follows a hovering mouse with no button held', () => {
    const onScrub = vi.fn<(s: Scrub | null) => void>();
    const container = mount();
    renderProfile(container, coords, onScrub);
    const svg = measured(container);

    pointer(svg, 'pointermove', xAt(0.25), 'mouse');
    pointer(svg, 'pointermove', xAt(0.75), 'mouse');

    expect(visible(container)).toBe(true);
    expect(onScrub).toHaveBeenCalledTimes(2);
    const [first, second] = onScrub.mock.calls.map((c) => c[0]!);
    expect(second.alongM).toBeGreaterThan(first.alongM);
  });

  it('stays where the mouse last hovered after it leaves the chart', () => {
    const onScrub = vi.fn<(s: Scrub | null) => void>();
    const container = mount();
    renderProfile(container, coords, onScrub);
    const svg = measured(container);

    pointer(svg, 'pointermove', xAt(0.5), 'mouse');
    const left = onScrub.mock.calls[0][0]!;
    svg.dispatchEvent(new PointerEvent('pointerleave', { pointerId: 1, bubbles: true }));
    svg.dispatchEvent(new PointerEvent('pointerout', { pointerId: 1, bubbles: true }));

    // A hover is a real scrub, so leaving takes nothing away — and the caller
    // can hand the position back on the next repaint like any other.
    expect(visible(container)).toBe(true);
    expect(onScrub).not.toHaveBeenCalledWith(null);
    expect(onScrub).toHaveBeenCalledTimes(1);

    const again = vi.fn<(s: Scrub | null) => void>();
    renderProfile(container, coords, again, null, left.alongM);
    expect(again.mock.calls[0][0]).toEqual(left);
  });

  it('redraws where it was left when the profile is repainted', () => {
    const first = vi.fn<(s: Scrub | null) => void>();
    const container = mount();
    renderProfile(container, coords, first);
    pointer(measured(container), 'pointerdown', xAt(0.5));
    const dropped = first.mock.calls[0][0]!;

    // What a rotation or a reopened chart does: the same route, from scratch.
    const again = vi.fn<(s: Scrub | null) => void>();
    renderProfile(container, coords, again, null, dropped.alongM);

    expect(visible(container)).toBe(true);
    expect(again).toHaveBeenCalledTimes(1);
    expect(again.mock.calls[0][0]).toEqual(dropped);
  });

  it('keeps a finger drag alive across a repaint', () => {
    const first = vi.fn<(s: Scrub | null) => void>();
    const container = mount();
    renderProfile(container, coords, first);
    const before = measured(container);
    pointer(before, 'pointerdown', xAt(0.25));
    const pressed = first.mock.calls[0][0]!;

    // The phone turns mid-drag and the chart is rebuilt under the finger.
    const again = vi.fn<(s: Scrub | null) => void>();
    renderProfile(container, coords, again, null, pressed.alongM);
    const after = measured(container);

    // The finger has not lifted, so its next move is still a scrub.
    pointer(after, 'pointermove', xAt(0.75));

    expect(visible(container)).toBe(true);
    const last = again.mock.lastCall![0]!;
    expect(last.alongM).toBeGreaterThan(pressed.alongM);
  });

  it('draws on the live chart when iOS keeps sending the drag to the old one', () => {
    // WebKit routes a touch's events to the element it started on, even after
    // that element has been thrown away. Those events must not read positions
    // off a chart that no longer has a box, nor draw on one nobody can see.
    const first = vi.fn<(s: Scrub | null) => void>();
    const container = mount();
    renderProfile(container, coords, first);
    const old = measured(container);
    pointer(old, 'pointerdown', xAt(0.25));
    const pressed = first.mock.calls[0][0]!;

    const again = vi.fn<(s: Scrub | null) => void>();
    renderProfile(container, coords, again, null, pressed.alongM);
    measured(container);
    // Detached: no layout, so its own box reads as empty.
    old.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0 }) as DOMRect;

    pointer(old, 'pointermove', xAt(0.5));

    expect(visible(container)).toBe(true);
    const last = again.mock.lastCall![0]!;
    expect(last.alongM).toBeGreaterThan(pressed.alongM);
    expect(last.alongM).toBeLessThan(pressed.alongM * 3);

    // And lifting on the old chart still ends the drag on the live one.
    pointer(old, 'pointerup', xAt(0.5));
    pointer(container.querySelector('svg')!, 'pointermove', xAt(0.9));
    expect(again.mock.lastCall![0]).toEqual(last);
  });

  it('reports the scrubber gone when the route no longer reaches it', () => {
    const onScrub = vi.fn<(s: Scrub | null) => void>();
    const container = mount();

    renderProfile(container, coords, onScrub, null, 50_000);

    expect(visible(container)).toBe(false);
    expect(onScrub).toHaveBeenCalledWith(null);
  });
});

describe('moveHere', () => {
  // A GPS fix moves the "you are here" mark and nothing else. Drawing the whole
  // profile again every second to do that was the cost worth removing, so what
  // matters is that the mark lands exactly where a full draw would put it, and
  // that the chart knows when a full draw is needed instead.

  /** Metres along to each sample, measured the way the chart measures. */
  const along = coords.map((_, i) =>
    coords.slice(1, i + 1).reduce((m, c, j) => m + haversine(coords[j], c), 0)
  );
  const dist = along[along.length - 1];
  const xOf = (m: number): string => (padL + (m / dist) * (W - padL - padR)).toFixed(1);

  const here = (container: HTMLElement) => container.querySelector<SVGGElement>('.here')!;
  const hereX = (container: HTMLElement) => here(container).querySelector('circle')!.getAttribute('cx');
  const hereShown = (container: HTMLElement) => here(container).style.display !== 'none';

  it('puts the mark where drawing the profile with that position would', () => {
    const drawn = mount();
    renderProfile(drawn, coords, undefined, along[3]);

    const moved = mount();
    renderProfile(moved, coords);
    const svg = moved.querySelector('svg');
    expect(hereShown(moved)).toBe(false);

    expect(moveHere(moved, coords, along[3])).toBe(true);
    expect(hereShown(moved)).toBe(true);
    expect(hereX(moved)).toBe(hereX(drawn));
    expect(hereX(moved)).toBe(xOf(along[3]));
    // Moved, not redrawn.
    expect(moved.querySelector('svg')).toBe(svg);
  });

  it('snaps to the nearest sample, and to the earlier one on a tie', () => {
    const container = mount();
    renderProfile(container, coords);

    moveHere(container, coords, along[1] + 0.4 * (along[2] - along[1]));
    expect(hereX(container)).toBe(xOf(along[1]));
    moveHere(container, coords, along[1] + 0.6 * (along[2] - along[1]));
    expect(hereX(container)).toBe(xOf(along[2]));
    moveHere(container, coords, (along[1] + along[2]) / 2);
    expect(hereX(container)).toBe(xOf(along[1]));
  });

  it('takes the mark away for an unknown position or one off the route', () => {
    const container = mount();
    renderProfile(container, coords, undefined, along[2]);
    expect(hereShown(container)).toBe(true);

    moveHere(container, coords, null);
    expect(hereShown(container)).toBe(false);

    moveHere(container, coords, along[2]);
    moveHere(container, coords, dist + 1);
    expect(hereShown(container)).toBe(false);
  });

  it('leaves the scrubber alone', () => {
    const onScrub = vi.fn<(s: Scrub | null) => void>();
    const container = mount();
    renderProfile(container, coords, onScrub);
    pointer(measured(container), 'pointerdown', xAt(0.25));
    onScrub.mockClear();

    moveHere(container, coords, along[3]);

    expect(visible(container)).toBe(true);
    expect(onScrub).not.toHaveBeenCalled();
  });

  it('asks for a full draw when there is nothing it can move', () => {
    const container = mount();
    // Nothing drawn here yet.
    expect(moveHere(container, coords, 0)).toBe(false);

    renderProfile(container, coords);
    // A different route, even one with the same points: a new walk.
    expect(moveHere(container, [...coords], 0)).toBe(false);

    // The container has changed width since the chart was drawn.
    Object.defineProperty(container, 'clientWidth', { configurable: true, value: 500 });
    expect(moveHere(container, coords, 0)).toBe(false);
    renderProfile(container, coords);
    expect(moveHere(container, coords, 0)).toBe(true);

    // The route has no elevation to draw, so there is no chart any more.
    const flat: LatLng[] = coords.map(([lat, lng]): LatLng => [lat, lng]);
    renderProfile(container, flat);
    expect(moveHere(container, flat, 0)).toBe(false);
    expect(moveHere(container, coords, 0)).toBe(false);
  });
});
