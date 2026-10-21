// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import L from '../leaflet-setup';
import { osGridCrs, osTileSize, setOsReference } from './osgrid';

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
});
