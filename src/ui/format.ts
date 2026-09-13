// Saying where somewhere is, in one line: an Ordnance Survey grid reference
// where Britain has one, falling back to decimal degrees where it doesn't (at
// sea, or outside the OS grid entirely).
//
// This lives on its own because two modules need it and neither owns it: pin
// cards (pins) and the Saved tab's pin list (panels).

import { formatGridRef } from '../osgb';

/** Grid ref where Britain has one, otherwise decimal lat/lng. One line. */
export function gridText(lat: number, lng: number): string {
  return formatGridRef(lat, lng, 4) || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}
