import { describe, expect, it } from 'vitest';
import { decodePolyline, encodePolyline } from './polyline';

/**
 * The worked example from Google's Encoded Polyline Algorithm Format:
 * (38.5, -120.2), (40.7, -120.95), (43.252, -126.453) encodes to the string
 * below. It is the reference implementation's published output, so it checks
 * our encoder against the format rather than against itself.
 */
const GOOGLE_POINTS: [number, number][] = [
  [38.5, -120.2],
  [40.7, -120.95],
  [43.252, -126.453]
];
const GOOGLE_ENCODED = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';

describe('encodePolyline', () => {
  it('matches the published reference example', () => {
    expect(encodePolyline(GOOGLE_POINTS)).toBe(GOOGLE_ENCODED);
  });

  it('encodes an empty route as an empty string', () => {
    expect(encodePolyline([])).toBe('');
  });
});

describe('decodePolyline', () => {
  it('decodes the published reference example', () => {
    const points = decodePolyline(GOOGLE_ENCODED);
    expect(points).toHaveLength(3);
    points.forEach(([lat, lng], i) => {
      expect(lat).toBeCloseTo(GOOGLE_POINTS[i][0], 5);
      expect(lng).toBeCloseTo(GOOGLE_POINTS[i][1], 5);
    });
  });

  it('decodes an empty string to no points', () => {
    expect(decodePolyline('')).toEqual([]);
  });
});

describe('encode/decode round trip', () => {
  it('survives negative latitudes and longitudes', () => {
    // Both hemispheres and both signs of delta, since the zig-zag encoding
    // treats negatives differently from positives.
    const points: [number, number][] = [
      [-33.8688, 151.2093],
      [-34.0, -58.3816],
      [51.5074, -0.1278],
      [0, 0]
    ];
    const out = decodePolyline(encodePolyline(points));
    out.forEach(([lat, lng], i) => {
      expect(lat).toBeCloseTo(points[i][0], 5);
      expect(lng).toBeCloseTo(points[i][1], 5);
    });
  });

  it('is exact at precision 5 and rounds anything finer', () => {
    // Precision 5 is 1e-5 degrees, about a metre of latitude. A coordinate
    // already on that grid must come back bit-identical; one below it is
    // rounded to the nearest 1e-5 rather than truncated.
    expect(decodePolyline(encodePolyline([[54.45421, -3.21156]]))).toEqual([[54.45421, -3.21156]]);
    expect(decodePolyline(encodePolyline([[54.454216, -3.211564]]))).toEqual([[54.45422, -3.21156]]);
  });

  it('carries elevations when used as a 1-D channel at precision 0', () => {
    // share.ts abuses the encoder for elevation profiles: metres in the first
    // slot, a constant 0 in the second, precision 0 so values are integers.
    const eles: [number, number][] = [
      [978, 0],
      [1102, 0],
      [-3, 0]
    ];
    expect(decodePolyline(encodePolyline(eles, 0), 0)).toEqual(eles);
  });

  it('keeps a long route stable end to end', () => {
    const points: [number, number][] = Array.from({ length: 500 }, (_, i) => [
      54.4 + i * 0.0007,
      -3.2 + Math.sin(i / 9) * 0.01
    ]);
    const out = decodePolyline(encodePolyline(points));
    expect(out).toHaveLength(points.length);
    out.forEach(([lat, lng], i) => {
      expect(lat).toBeCloseTo(points[i][0], 5);
      expect(lng).toBeCloseTo(points[i][1], 5);
    });
  });
});
