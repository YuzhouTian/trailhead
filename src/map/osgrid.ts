// The British National Grid as a Leaflet CRS, for the OS Leisure (Explorer)
// layer, which OS only serves in EPSG:27700.
//
// Scale-matched to the standard map: at a reference latitude, app zoom z shows
// exactly as many metres per pixel as Freemap does at zoom z there, so switching
// between the two layers never changes the scale. OS's own levels are fixed
// metres per pixel everywhere, while the standard levels get finer going north,
// so the match is made by drawing each OS tile larger than 256 px (see
// osTileSize) rather than by pairing levels differently. docs/os-leisure-plan.md
// §3 has the reasoning and the numbers.
//
// Projection goes through osgb.ts (Helmert + Transverse Mercator), so it is good
// to a few metres — and needs no proj4.

import L from '../leaflet-setup';
import { eastingNorthingToLatLng, latLngToEastingNorthing } from '../osgb';

/** Top-left corner of OS's EPSG:27700 tile matrix, in eastings/northings. */
export const OS_TILE_ORIGIN = { e: -238375, n: 1376256 };
/** Metres per pixel of OS level 0; each level halves it. */
const OS_LEVEL0_RES = 896;
/** OS level k is app zoom k + this. */
export const OS_ZOOM_OFFSET = 7;
/**
 * Grid metres per degree of longitude at the reference point, along its
 * parallel. Matching on longitude rather than on a formula for metres keeps it
 * exact: a standard-map pixel at zoom z always spans 360 / (256 · 2^z) degrees
 * of longitude, and this turns that into OS grid metres — the ellipsoid and the
 * grid's own scale factor included, which a cos(lat) formula gets 0.2% wrong.
 */
let gridMetresPerDegLng = 0;
let referenceLat = 54;
let referenceLng = -2;

function gridMetresPerDegLngAt(lat: number, lng: number): number {
  const a = latLngToEastingNorthing(lat, lng - 0.005);
  const b = latLngToEastingNorthing(lat, lng + 0.005);
  return Math.hypot(b.e - a.e, b.n - a.n) / 0.01;
}

/** OS grid metres per pixel at app zoom z, matched to the standard map. */
function resolution(z: number): number {
  return (gridMetresPerDegLng * 360) / (256 * 2 ** z);
}

/**
 * Screen size of one OS tile, in pixels, at the current match. The same at
 * every zoom: OS tiles and standard zooms both halve per level. About 291 px in
 * Cornwall, 319 in the Lakes, 354 in Sutherland.
 */
export function osTileSize(): number {
  const osResAtZoom0 = OS_LEVEL0_RES * 2 ** OS_ZOOM_OFFSET;
  return (256 * osResAtZoom0) / resolution(0);
}

/** Where the grid is currently matched. */
export function osReference(): { lat: number; lng: number } {
  return { lat: referenceLat, lng: referenceLng };
}

/** Re-match the grid's scale to Freemap's at a point. The caller resets the view. */
export function setOsReference(lat: number, lng: number): void {
  referenceLat = lat;
  referenceLng = lng;
  gridMetresPerDegLng = gridMetresPerDegLngAt(lat, lng);
}
setOsReference(referenceLat, referenceLng);

/** Grid positions by LatLng object; see project(). Weak, so a route that is
 *  cleared takes its entries with it. */
const projected = new WeakMap<L.LatLng, { e: number; n: number }>();

export const osGridCrs: L.CRS = L.extend({}, L.CRS.Earth, {
  code: 'EPSG:27700',
  // GB never wraps, and asking Leaflet to wrap longitudes would move points
  // that are already where they should be.
  wrapLng: undefined,
  infinite: false,
  projection: {
    project(latlng: L.LatLng): L.Point {
      // Leaflet re-projects every point of every route on each zoom, and
      // through osgb.ts that is about three times the work of Web Mercator —
      // a visible hitch at the end of a zoom on a long route. A route keeps the
      // same LatLng objects for as long as it is drawn, so remember each one's
      // grid position. A fresh Point each time: Leaflet scales it in place.
      let en = projected.get(latlng);
      if (!en) {
        en = latLngToEastingNorthing(latlng.lat, latlng.lng);
        projected.set(latlng, en);
      }
      return L.point(en.e, en.n);
    },
    unproject(p: L.Point): L.LatLng {
      const [lat, lng] = eastingNorthingToLatLng(p.x, p.y);
      return L.latLng(lat, lng);
    },
    // The National Grid's own extent. Keeps Leaflet from asking for tiles past
    // it, which OS answers with errors that would trip the layer fallback.
    bounds: L.bounds(L.point(0, 0), L.point(700000, 1300000))
  },
  // Pixel (0, 0) is the top-left of OS's tile matrix; y grows southwards.
  transformation: new L.Transformation(1, -OS_TILE_ORIGIN.e, -1, OS_TILE_ORIGIN.n),
  scale(zoom: number): number {
    return 1 / resolution(zoom);
  },
  zoom(scale: number): number {
    return Math.log2((scale * gridMetresPerDegLng * 360) / 256);
  }
});
