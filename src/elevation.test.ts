// @vitest-environment jsdom

// The elevation profile's scrubber, which is the only stateful thing in this
// module. What it has to get right is stubbornness: the marker exists so you
// can look away from the chart and at the map, so lifting a finger must not
// take it away, and neither must the profile being repainted underneath it —
// which happens on every GPS fix while you walk.

import { describe, expect, it, vi } from 'vitest';
import { renderProfile, type Scrub } from './elevation';
import type { LatLng } from './geo';

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

function pointer(svg: SVGSVGElement, type: string, clientX: number): void {
  svg.dispatchEvent(new PointerEvent(type, { clientX, pointerId: 1, bubbles: true }));
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

  it('ignores a pointer that is only passing over', () => {
    const onScrub = vi.fn<(s: Scrub | null) => void>();
    const container = mount();
    renderProfile(container, coords, onScrub);
    const svg = measured(container);

    pointer(svg, 'pointermove', xAt(0.5));

    expect(visible(container)).toBe(false);
    expect(onScrub).not.toHaveBeenCalled();
  });

  it('redraws where it was left when the profile is repainted', () => {
    const first = vi.fn<(s: Scrub | null) => void>();
    const container = mount();
    renderProfile(container, coords, first);
    pointer(measured(container), 'pointerdown', xAt(0.5));
    const dropped = first.mock.calls[0][0]!;

    // What a GPS fix does: the same route, rendered from scratch.
    const again = vi.fn<(s: Scrub | null) => void>();
    renderProfile(container, coords, again, null, dropped.alongM);

    expect(visible(container)).toBe(true);
    expect(again).toHaveBeenCalledTimes(1);
    expect(again.mock.calls[0][0]).toEqual(dropped);
  });

  it('reports the scrubber gone when the route no longer reaches it', () => {
    const onScrub = vi.fn<(s: Scrub | null) => void>();
    const container = mount();

    renderProfile(container, coords, onScrub, null, 50_000);

    expect(visible(container)).toBe(false);
    expect(onScrub).toHaveBeenCalledWith(null);
  });
});
