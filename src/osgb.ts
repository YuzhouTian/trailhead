/**
 * OS National Grid references (GB only).
 *
 * WGS84 (GPS) -> OSGB36 via a Helmert transform, then the National Grid
 * transverse Mercator projection. The Helmert approximation is accurate to
 * a few metres, which is far finer than the grid refs we print.
 */

import type { LatLng } from './geo';

const RAD = Math.PI / 180;

// Airy 1830 (OSGB36) and WGS84 ellipsoids.
const AIRY = { a: 6377563.396, b: 6356256.909 };
const WGS84 = { a: 6378137, b: 6356752.3142 };

// WGS84 -> OSGB36 Helmert parameters.
const HELMERT = {
  tx: -446.448, ty: 125.157, tz: -542.06,
  rx: -0.1502 / 3600 * RAD, ry: -0.247 / 3600 * RAD, rz: -0.8421 / 3600 * RAD,
  s: 20.4894e-6
};

// National Grid projection constants.
const F0 = 0.9996012717;
const LAT0 = 49 * RAD;
const LON0 = -2 * RAD;
const E0 = 400000;
const N0 = -100000;

function toCartesian(lat: number, lon: number, h: number, ell: { a: number; b: number }) {
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const eSq = (ell.a ** 2 - ell.b ** 2) / ell.a ** 2;
  const nu = ell.a / Math.sqrt(1 - eSq * sinLat * sinLat);
  return {
    x: (nu + h) * cosLat * Math.cos(lon),
    y: (nu + h) * cosLat * Math.sin(lon),
    z: ((1 - eSq) * nu + h) * sinLat
  };
}

function toGeodetic(p: { x: number; y: number; z: number }, ell: { a: number; b: number }) {
  const eSq = (ell.a ** 2 - ell.b ** 2) / ell.a ** 2;
  const p2 = Math.sqrt(p.x * p.x + p.y * p.y);
  let lat = Math.atan2(p.z, p2 * (1 - eSq));
  let latPrev = 2 * Math.PI;
  let nu = ell.a;
  for (let i = 0; i < 10 && Math.abs(lat - latPrev) > 1e-12; i++) {
    nu = ell.a / Math.sqrt(1 - eSq * Math.sin(lat) ** 2);
    latPrev = lat;
    lat = Math.atan2(p.z + eSq * nu * Math.sin(lat), p2);
  }
  return { lat, lon: Math.atan2(p.y, p.x), h: p2 / Math.cos(lat) - nu };
}

function helmert(p: { x: number; y: number; z: number }, inverse: boolean) {
  const s = inverse ? -HELMERT.s : HELMERT.s;
  const [tx, ty, tz] = inverse
    ? [-HELMERT.tx, -HELMERT.ty, -HELMERT.tz]
    : [HELMERT.tx, HELMERT.ty, HELMERT.tz];
  const [rx, ry, rz] = inverse
    ? [-HELMERT.rx, -HELMERT.ry, -HELMERT.rz]
    : [HELMERT.rx, HELMERT.ry, HELMERT.rz];
  return {
    x: tx + p.x * (1 + s) - p.y * rz + p.z * ry,
    y: ty + p.x * rz + p.y * (1 + s) - p.z * rx,
    z: tz - p.x * ry + p.y * rx + p.z * (1 + s)
  };
}

/** WGS84 lat/lng -> National Grid easting/northing (metres). */
export function latLngToEastingNorthing(lat: number, lng: number): { e: number; n: number } {
  const osgb = toGeodetic(helmert(toCartesian(lat * RAD, lng * RAD, 0, WGS84), false), AIRY);
  const { a, b } = AIRY;
  const eSq = (a * a - b * b) / (a * a);
  const n = (a - b) / (a + b);
  const sinLat = Math.sin(osgb.lat);
  const cosLat = Math.cos(osgb.lat);
  const tanLat = Math.tan(osgb.lat);
  const nu = (a * F0) / Math.sqrt(1 - eSq * sinLat * sinLat);
  const rho = (a * F0 * (1 - eSq)) / (1 - eSq * sinLat * sinLat) ** 1.5;
  const eta2 = nu / rho - 1;

  const dLat = osgb.lat - LAT0;
  const sLat = osgb.lat + LAT0;
  const M =
    b * F0 * (
      (1 + n + 1.25 * n * n + 1.25 * n ** 3) * dLat -
      (3 * n + 3 * n * n + 2.625 * n ** 3) * Math.sin(dLat) * Math.cos(sLat) +
      (1.875 * n * n + 1.875 * n ** 3) * Math.sin(2 * dLat) * Math.cos(2 * sLat) -
      (35 / 24) * n ** 3 * Math.sin(3 * dLat) * Math.cos(3 * sLat)
    );

  const I = M + N0;
  const II = (nu / 2) * sinLat * cosLat;
  const III = (nu / 24) * sinLat * cosLat ** 3 * (5 - tanLat ** 2 + 9 * eta2);
  const IIIA = (nu / 720) * sinLat * cosLat ** 5 * (61 - 58 * tanLat ** 2 + tanLat ** 4);
  const IV = nu * cosLat;
  const V = (nu / 6) * cosLat ** 3 * (nu / rho - tanLat ** 2);
  const VI = (nu / 120) * cosLat ** 5 * (5 - 18 * tanLat ** 2 + tanLat ** 4 + 14 * eta2 - 58 * tanLat ** 2 * eta2);

  const dLon = osgb.lon - LON0;
  return {
    n: I + II * dLon ** 2 + III * dLon ** 4 + IIIA * dLon ** 6,
    e: E0 + IV * dLon + V * dLon ** 3 + VI * dLon ** 5
  };
}

/** National Grid easting/northing -> WGS84 lat/lng. */
export function eastingNorthingToLatLng(e: number, n: number): LatLng {
  const { a, b } = AIRY;
  const eSq = (a * a - b * b) / (a * a);
  const n0 = (a - b) / (a + b);

  let lat = LAT0;
  let M = 0;
  do {
    lat = (n - N0 - M) / (a * F0) + lat;
    const dLat = lat - LAT0;
    const sLat = lat + LAT0;
    M =
      b * F0 * (
        (1 + n0 + 1.25 * n0 * n0 + 1.25 * n0 ** 3) * dLat -
        (3 * n0 + 3 * n0 * n0 + 2.625 * n0 ** 3) * Math.sin(dLat) * Math.cos(sLat) +
        (1.875 * n0 * n0 + 1.875 * n0 ** 3) * Math.sin(2 * dLat) * Math.cos(2 * sLat) -
        (35 / 24) * n0 ** 3 * Math.sin(3 * dLat) * Math.cos(3 * sLat)
      );
  } while (Math.abs(n - N0 - M) >= 0.00001);

  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const tanLat = Math.tan(lat);
  const nu = (a * F0) / Math.sqrt(1 - eSq * sinLat * sinLat);
  const rho = (a * F0 * (1 - eSq)) / (1 - eSq * sinLat * sinLat) ** 1.5;
  const eta2 = nu / rho - 1;

  const t2 = tanLat ** 2;
  const t4 = t2 * t2;
  const t6 = t4 * t2;
  const VII = tanLat / (2 * rho * nu);
  const VIII = (tanLat / (24 * rho * nu ** 3)) * (5 + 3 * t2 + eta2 - 9 * t2 * eta2);
  const IX = (tanLat / (720 * rho * nu ** 5)) * (61 + 90 * t2 + 45 * t4);
  const X = 1 / (cosLat * nu);
  const XI = (1 / (6 * cosLat * nu ** 3)) * (nu / rho + 2 * t2);
  const XII = (1 / (120 * cosLat * nu ** 5)) * (5 + 28 * t2 + 24 * t4);
  const XIIA = (1 / (5040 * cosLat * nu ** 7)) * (61 + 662 * t2 + 1320 * t4 + 720 * t6);

  const dE = e - E0;
  const osgbLat = lat - VII * dE ** 2 + VIII * dE ** 4 - IX * dE ** 6;
  const osgbLon = LON0 + X * dE - XI * dE ** 3 + XII * dE ** 5 - XIIA * dE ** 7;

  const wgs = toGeodetic(helmert(toCartesian(osgbLat, osgbLon, 0, AIRY), true), WGS84);
  return [wgs.lat / RAD, wgs.lon / RAD];
}

// Grid squares are lettered A-Z omitting 'I', laid out 5x5 with A in the
// north-west, so letter index -> position needs 'I' shuffled out.
const letterToIndex = (ch: string): number => {
  const i = ch.charCodeAt(0) - 65;
  return i > 7 ? i - 1 : i; // skip 'I'
};
const indexToLetter = (i: number): string => String.fromCharCode(65 + (i > 7 ? i + 1 : i));

/**
 * Format as a standard grid reference, e.g. "NY 2151 0737".
 * `digits` is per axis: 3 = 100 m, 4 = 10 m, 5 = 1 m precision.
 * Returns null outside the National Grid (i.e. outside GB).
 */
export function formatGridRef(lat: number, lng: number, digits: 3 | 4 | 5 = 4): string | null {
  const { e, n } = latLngToEastingNorthing(lat, lng);
  if (e < 0 || e >= 700000 || n < 0 || n >= 1300000) return null;

  const e100 = Math.floor(e / 100000);
  const n100 = Math.floor(n / 100000);
  const i1 = (19 - n100) - ((19 - n100) % 5) + Math.floor((e100 + 10) / 5);
  const i2 = (((19 - n100) * 5) % 25) + (e100 % 5);
  if (i1 < 0 || i1 > 24 || i2 < 0 || i2 > 24) return null;
  const letters = indexToLetter(i1) + indexToLetter(i2);

  const div = 10 ** (5 - digits);
  const eStr = String(Math.floor((e % 100000) / div)).padStart(digits, '0');
  const nStr = String(Math.floor((n % 100000) / div)).padStart(digits, '0');
  return `${letters} ${eStr} ${nStr}`;
}

/**
 * Parse a grid reference ("NY 215 073", "NY215073", "ny2151507377").
 * Returns the centre of the referenced square, or null if unparseable.
 */
export function parseGridRef(input: string): LatLng | null {
  const s = input.trim().toUpperCase().replace(/\s+/g, '');
  const m = s.match(/^([A-HJ-Z]{2})(\d*)$/);
  if (!m) return null;
  const [, letters, digitsStr] = m;
  if (digitsStr.length % 2 !== 0 || digitsStr.length > 10) return null;

  const l1 = letterToIndex(letters[0]);
  const l2 = letterToIndex(letters[1]);
  const e100 = ((l1 - 2) % 5) * 5 + (l2 % 5);
  const n100 = 19 - Math.floor(l1 / 5) * 5 - Math.floor(l2 / 5);
  if (e100 < 0 || e100 > 6 || n100 < 0 || n100 > 12) return null;

  const half = digitsStr.length / 2;
  const scale = half ? 10 ** (5 - half) : 100000;
  const e = e100 * 100000 + (half ? Number(digitsStr.slice(0, half)) * scale : 0);
  const n = n100 * 100000 + (half ? Number(digitsStr.slice(half)) * scale : 0);
  // Aim at the middle of the square the reference describes.
  return eastingNorthingToLatLng(e + scale / 2, n + scale / 2);
}
