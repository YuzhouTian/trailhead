// @vitest-environment jsdom
import { afterEach, describe, it, expect } from 'vitest';
import L from '../leaflet-setup';
import { osGridCrs, osTileSize, setOsNative, setOsReference } from './osgrid';

/** Which OS tile (x, y) a point falls in at app zoom z, as Leaflet works it out. */
function tileAt(lat: number, lng: number, z: number): [number, number] {
  const p = osGridCrs.latLngToPoint(L.latLng(lat, lng), z);
  const size = osTileSize();
  return [Math.floor(p.x / size), Math.floor(p.y / size)];
}

/** Screen pixels between two points 0.01° of longitude apart, on a CRS. */
function pixelsAcross(crs: L.CRS, lat: number, lng: number, z: number): number {
  const a = crs.latLngToPoint(L.latLng(lat, lng - 0.005), z);
  const b = crs.latLngToPoint(L.latLng(lat, lng + 0.005), z);
  return a.distanceTo(b);
}

describe('OS grid', () => {
  it('asks for the OS tile a point is actually in', () => {
    // Helvellyn, NY 34150 15150. At OS level 7 (7 m/px, 1792 m tiles) from the
    // matrix origin (-238375, 1376256) that is tile 319, 480 — worked by hand
    // and checked against the live tiles in the spike.
    setOsReference(54.527, -3.016);
    expect(tileAt(54.5271, -3.0164, 14)).toEqual([319, 480]);
  });

  it('shows the same ground per pixel as the standard map, wherever it is matched', () => {
    for (const [lat, lng] of [[50.68, -4.01], [54.53, -3.02], [57.12, -3.64], [52.95, 1.3]]) {
      setOsReference(lat, lng);
      for (const z of [12, 14, 16]) {
        const os = pixelsAcross(osGridCrs, lat, lng, z);
        const web = pixelsAcross(L.CRS.EPSG3857, lat, lng, z);
        expect(Math.abs(os / web - 1)).toBeLessThan(1e-4);
      }
    }
  });

  it('draws OS tiles larger the further north the match, as the standard zooms get finer', () => {
    setOsReference(50.2, -5.0);
    const cornwall = osTileSize();
    setOsReference(54.5, -3.0);
    const lakes = osTileSize();
    setOsReference(58.0, -4.5);
    const sutherland = osTileSize();
    expect(cornwall).toBeGreaterThan(285);
    expect(cornwall).toBeLessThan(lakes);
    expect(lakes).toBeLessThan(sutherland);
    expect(sutherland).toBeLessThan(360);
  });

  it('round-trips a point through the grid to within a metre', () => {
    setOsReference(53.07, -4.08);
    const summit = L.latLng(53.068497, -4.076218);
    const back = osGridCrs.pointToLatLng(osGridCrs.latLngToPoint(summit, 16), 16);
    expect(summit.distanceTo(back)).toBeLessThan(1);
  });

  it('hands back a fresh point each time, so a cached projection is never scaled twice', () => {
    const { projection } = osGridCrs as L.CRS & { projection: L.Projection };
    const p = L.latLng(53.1, -4.0);
    const a = projection.project(p);
    a.x = 0;
    const b = projection.project(p);
    expect(b.x).not.toBe(0);
  });

  describe("at OS's own scale", () => {
    afterEach(() => setOsNative(false));

    it('draws every tile at 256 px, one OS pixel to one screen pixel, wherever it is', () => {
      setOsNative(true);
      for (const [lat, lng] of [[50.2, -5.0], [54.5, -3.0], [60.8, -0.85]]) {
        setOsReference(lat, lng);
        expect(osTileSize()).toBe(256);
        // App zoom 14 is OS level 7, 7 m per pixel.
        expect(osGridCrs.scale(14)).toBe(1 / 7);
        expect(osGridCrs.zoom(osGridCrs.scale(15))).toBeCloseTo(15, 9);
      }
    });

    it('still asks for the OS tile a point is actually in', () => {
      setOsNative(true);
      expect(tileAt(54.5271, -3.0164, 14)).toEqual([319, 480]);
    });

    it('shows more ground than the standard map at the same zoom, more so going north', () => {
      setOsNative(true);
      const ratio = (lat: number, lng: number) =>
        pixelsAcross(L.CRS.EPSG3857, lat, lng, 14) / pixelsAcross(osGridCrs, lat, lng, 14);
      expect(ratio(50.2, -5.0)).toBeCloseTo(1.14, 2);
      expect(ratio(54.5, -3.0)).toBeCloseTo(1.26, 2);
      expect(ratio(60.8, -0.85)).toBeCloseTo(1.5, 2);
    });
  });
});
