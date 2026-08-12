// Saying where somewhere is. Two ways of writing the same thing: one line for
// a list row, two lines for a popup — both preferring an Ordnance Survey grid
// reference where Britain has one, and falling back to decimal degrees where it
// doesn't (at sea, or outside the OS grid entirely).
//
// This lives on its own because four modules need it and none of them owns it:
// the GPS dot's popup (tracking), pin cards and the Routes panel's pin list
// (pins), and search hits and nearby-POI popups (search).

import { formatGridRef } from '../osgb';
import { type LatLng } from '../geo';

/** Grid ref where Britain has one, otherwise decimal lat/lng. One line. */
export function gridText(lat: number, lng: number): string {
  return formatGridRef(lat, lng, 4) || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

/** Human-readable position line: grid ref where we have one, plus lat/lng. */
export function positionText(p: LatLng): string {
  const grid = formatGridRef(p[0], p[1], 4);
  const ll = `${p[0].toFixed(5)}, ${p[1].toFixed(5)}`;
  return grid ? `<b>${grid}</b><br>${ll}` : ll;
}
