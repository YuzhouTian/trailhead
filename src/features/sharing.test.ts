// The QR half of a share, tested the only way that means anything: draw the
// code at the sizes the share panel would draw it, then read it back with the
// same decoder Trailhead's own scanner uses. Before #44 a long route rendered
// something that looked like a QR code and decoded as nothing.

import jsQR from 'jsqr';
import qrcode from 'qrcode-generator';
import { beforeAll, describe, expect, it } from 'vitest';
import type { LatLng } from '../geo';
import { buildShareUrl } from '../share';
import type { SavedRoute } from '../state';
import { qrRender } from './sharing';

beforeAll(() => {
  Object.defineProperty(globalThis, 'location', {
    value: { origin: 'https://yuzhoutian.github.io', pathname: '/trailhead/' },
    configurable: true
  });
});

/** The widths that matter: the share panel, a phone held full-screen, a laptop. */
const PANEL = 292;
const PHONE = 343;
const LAPTOP = 768;

/** A full day's GPS track — the case that used to produce an unscannable code. */
const dayTrack = (n: number): LatLng[] =>
  Array.from({ length: n }, (_, i) => [
    54.4 + Math.sin(i / 40) * 0.03 + i * 0.00004,
    -3.2 + Math.cos(i / 55) * 0.03,
    Math.round(300 + Math.sin(i / 30) * 400)
  ]);

const routeOf = (coords: LatLng[]): SavedRoute => ({
  id: '1',
  name: 'Scafell Pike full day',
  waypoints: null,
  coords,
  distanceM: 18000,
  ascentM: 1200,
  descentM: 1200,
  createdAt: 0
});

/**
 * Paint the code as a decoder would see it on screen — one flat colour per
 * whole pixel, quiet zone included — and hand it to jsQR. This is the same
 * geometry `qrRender` gives `createSvgTag`, so what passes here is what the
 * panel puts in front of a camera.
 */
function decodeAt(url: string, avail: number): { text: string | null; cellSize: number } {
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  const modules = qr.getModuleCount();
  const { cellSize, margin } = qrRender(modules, avail);
  const side = modules * cellSize + margin * 2;
  const px = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let row = 0; row < modules; row++) {
    for (let col = 0; col < modules; col++) {
      if (!qr.isDark(row, col)) continue;
      for (let y = 0; y < cellSize; y++) {
        for (let x = 0; x < cellSize; x++) {
          const i = ((margin + row * cellSize + y) * side + margin + col * cellSize + x) * 4;
          px[i] = px[i + 1] = px[i + 2] = 0;
        }
      }
    }
  }
  const found = jsQR(px, side, side, { inversionAttempts: 'dontInvert' });
  return { text: found?.data ?? null, cellSize };
}

describe('the QR code a share panel draws', () => {
  it.each([
    ['a waypoint route', null],
    ['a 300-point track', 300],
    ['a 1,500-point track', 1500],
    ['a 4,000-point track', 4000]
  ])('scans %s when enlarged on a phone', (_label, n) => {
    const r =
      n === null
        ? { ...routeOf([]), waypoints: dayTrack(8) as LatLng[], coords: dayTrack(8) }
        : routeOf(dayTrack(n));
    const url = buildShareUrl(r, 'hiking-mountain');
    const { text, cellSize } = decodeAt(url, PHONE);
    // Three pixels a module is the floor a camera can work with, and the code
    // has to come back as the link itself — not merely "something decoded".
    expect(cellSize).toBeGreaterThanOrEqual(3);
    expect(text).toBe(url);
  });

  it('scans the densest allowed route on a laptop', () => {
    const url = buildShareUrl(routeOf(dayTrack(4000)), 'hiking');
    const { text, cellSize } = decodeAt(url, LAPTOP);
    expect(cellSize).toBeGreaterThanOrEqual(6);
    expect(text).toBe(url);
  });

  it('never draws a module on a fractional pixel', () => {
    // Fractional modules were half the failure: the browser antialiased every
    // edge into grey and the code stopped being black and white.
    for (const avail of [PANEL, PHONE, LAPTOP, 200, 1000]) {
      const { cellSize, margin } = qrRender(105, avail);
      expect(Number.isInteger(cellSize)).toBe(true);
      expect(Number.isInteger(margin)).toBe(true);
      expect(105 * cellSize + margin * 2).toBeLessThanOrEqual(avail);
    }
  });

  it('carries a quiet zone that scales with the code', () => {
    // A flat two-pixel margin is no quiet zone; a decoder needs four modules of
    // white to find the code in the first place.
    for (const avail of [PANEL, PHONE, LAPTOP]) {
      const { cellSize, margin } = qrRender(105, avail);
      expect(margin).toBe(cellSize * 4);
    }
  });

  it('admits when the panel is too narrow rather than shrinking to fit', () => {
    // The panel cannot show a dense code at a scannable size, and the fix is to
    // say so and enlarge — not to scale the SVG down, which is what made an
    // unreadable code look like a readable one.
    const dense = qrRender(105, PANEL);
    expect(dense.cellSize).toBeLessThan(3);
    expect(qrRender(105, PHONE).cellSize).toBeGreaterThanOrEqual(3);
  });
});
