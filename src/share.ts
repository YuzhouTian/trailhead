import { simplifyIndices, type LatLng } from './geo';
import { decodePolyline, encodePolyline } from './polyline';
import type { SavedRoute } from './state';

/** Compact route payload carried in the URL fragment (#r=...). */
interface SharePayload {
  n: string; // name
  p?: string; // routing profile (waypoint shares)
  w?: string; // encoded planner waypoints — receiver re-routes via BRouter
  s?: string; // per-leg snap flags for w as '1'/'0' chars (missing = all snapped)
  c?: string; // encoded full track (imported routes with no waypoints)
  e?: string; // encoded elevations for c, metres (abused 1D polyline)
}

const MAX_TRACK_POINTS = 500;

export function buildShareUrl(route: SavedRoute, profile: string): string {
  const payload: SharePayload = { n: route.name };
  if (route.waypoints && route.waypoints.length >= 2) {
    payload.w = encodePolyline(route.waypoints.map((p) => [p[0], p[1]]));
    payload.p = profile;
    if (route.snaps && route.snaps.some((s) => s === false)) {
      payload.s = route.snaps.map((s) => (s === false ? '0' : '1')).join('');
    }
  } else {
    let coords = route.coords;
    // Thin dense tracks so the link (and its QR code) stays a sane size.
    for (let tol = 0.00005; coords.length > MAX_TRACK_POINTS; tol *= 2) {
      coords = simplifyIndices(coords, tol).map((i) => coords[i]);
    }
    payload.c = encodePolyline(coords.map((p) => [p[0], p[1]]));
    if (coords.some((p) => typeof p[2] === 'number')) {
      payload.e = encodePolyline(coords.map((p) => [p[2] ?? 0, 0]), 0);
    }
  }
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(payload))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${location.origin}${location.pathname}#r=${b64}`;
}

export interface ParsedShare {
  name: string;
  profile?: string;
  waypoints?: LatLng[];
  snaps?: boolean[];
  coords?: LatLng[];
}

export function parseShareHash(hash: string): ParsedShare | null {
  const m = hash.match(/^#r=([A-Za-z0-9_-]+)$/);
  if (!m) return null;
  const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
  const json = new TextDecoder().decode(
    Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))
  );
  const payload = JSON.parse(json) as SharePayload;
  const out: ParsedShare = { name: payload.n || 'Shared route' };
  if (payload.w) {
    out.waypoints = decodePolyline(payload.w) as LatLng[];
    out.profile = payload.p;
    if (payload.s) out.snaps = [...payload.s].map((ch) => ch !== '0');
  } else if (payload.c) {
    const coords = decodePolyline(payload.c) as LatLng[];
    if (payload.e) {
      const eles = decodePolyline(payload.e, 0);
      coords.forEach((p, i) => {
        if (eles[i]) p.push(eles[i][0]);
      });
    }
    out.coords = coords;
  } else {
    return null;
  }
  return out;
}
