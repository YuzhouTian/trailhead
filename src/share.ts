// The share payload: a whole route squeezed into a URL fragment.
//
// The fragment has to survive two hostile channels — a QR code someone points a
// camera at, and a chat or mail client that may wrap or truncate a long URL —
// and both get worse the longer the link is. So the budget here is on the
// *link*, not on the point count: a track is thinned until the finished URL
// fits, because the URL is the thing that has to fit.

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
  k?: string; // checksum of the fields above (see `checksum`)
}

/**
 * How long a share link may get. 750 characters is at most a 105-module QR
 * code, which with its quiet zone still draws at 3px per module on a
 * phone-sized screen and 6px on a laptop — 3px is roughly where a camera stops
 * being able to resolve one — and it leaves the link short enough that mail and
 * chat clients pass it through whole. The old ceiling was 500 track *points*,
 * which let a link reach 3.5 KB: a QR code far too dense to scan (#44) and a
 * URL long enough to get wrapped or cut in transit (#45).
 */
const MAX_LINK_CHARS = 750;
/** A hard ceiling on points as well, so the budget loop never has to encode a
    3,000-point track just to discover it is too long. */
const MAX_TRACK_POINTS = 500;
/** And a floor: thinned below this a track stops being the same walk, so we
    stop and let the link run long rather than send a shape nobody recognises. */
const MIN_TRACK_POINTS = 24;

export function buildShareUrl(route: SavedRoute, profile: string): string {
  const payload: SharePayload = { n: route.name };
  if (route.waypoints && route.waypoints.length >= 2) {
    // Waypoint shares are compact by construction — a day's walk is a handful
    // of points — and thinning them would change the route the receiver
    // re-routes, so they are not on the budget.
    payload.w = encodePolyline(route.waypoints.map((p) => [p[0], p[1]]));
    payload.p = profile;
    if (route.snaps && route.snaps.some((s) => s === false)) {
      payload.s = route.snaps.map((s) => (s === false ? '0' : '1')).join('');
    }
    return linkFor(payload);
  }
  let coords = route.coords;
  let tol = 0.00005;
  for (; coords.length > MAX_TRACK_POINTS; tol *= 2) {
    coords = simplifyIndices(coords, tol).map((i) => coords[i]);
  }
  let url = linkFor(withTrack(payload, coords));
  for (; url.length > MAX_LINK_CHARS && coords.length > MIN_TRACK_POINTS; tol *= 2) {
    coords = simplifyIndices(coords, tol).map((i) => coords[i]);
    url = linkFor(withTrack(payload, coords));
  }
  return url;
}

/** `payload` with a track hung off it — one candidate for the budget loop. */
function withTrack(payload: SharePayload, coords: LatLng[]): SharePayload {
  const out: SharePayload = { ...payload };
  out.c = encodePolyline(coords.map((p) => [p[0], p[1]]));
  if (coords.some((p) => typeof p[2] === 'number')) {
    out.e = encodePolyline(coords.map((p) => [p[2] ?? 0, 0]), 0);
  }
  return out;
}

function linkFor(payload: SharePayload): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ ...payload, k: checksum(payload) }));
  let bin = '';
  // In chunks: spreading a few thousand arguments into fromCharCode is close
  // enough to the engine's argument limit to be worth not risking.
  for (let i = 0; i < bytes.length; i += 4096) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 4096));
  }
  const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${location.origin}${location.pathname}#r=${b64}`;
}

/**
 * A short hash of the payload, carried as `k`. One flipped character in a link
 * still base64-decodes and still parses as JSON — it just yields a route that
 * is subtly in the wrong place, and wrong-but-plausible coordinates on a hill
 * are worse than an error message. FNV-1a over the fields in a fixed order, so
 * it does not depend on how JSON happened to order the keys.
 */
function checksum(p: SharePayload): string {
  const s = [p.n, p.p ?? '', p.w ?? '', p.s ?? '', p.c ?? '', p.e ?? ''].join('\u0000');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// ---------------------------------------------------------------- receiving

/**
 * What the receiver is told when a link arrives damaged. Truncation is by far
 * the most common damage and the sender is the only one who can fix it, so the
 * message says so — and names the paste path, which tolerates the trailing
 * punctuation and appended parameters that opening a link used not to.
 */
export const DAMAGED_LINK_MESSAGE =
  'This route link looks cut off or damaged — ask the sender for it again, or ' +
  'copy the whole link and use Routes → Paste shared route';
/** Damage the checksum caught: the link is intact in shape but not in content. */
export const CORRUPTED_LINK_MESSAGE =
  'This route link arrived corrupted — ask the sender to send it again';

/** Damage we could name, thrown so the receiving UI can say which it was. */
export class ShareLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShareLinkError';
  }
}

/**
 * A route link anywhere in a blob of text. Deliberately a search rather than an
 * anchored match on the whole fragment: a link that picked up a trailing full
 * stop, a bracket or a tracking parameter in transit is still the same link,
 * and anchoring made opening one silently do nothing (#45).
 */
const ROUTE_LINK = /#r=([A-Za-z0-9_-]+)/;

export interface ParsedShare {
  name: string;
  profile?: string;
  waypoints?: LatLng[];
  snaps?: boolean[];
  coords?: LatLng[];
}

/**
 * Read a route out of a fragment, a pasted URL, or a scanned QR's text.
 * Returns null when there is no route link in there at all, and throws a
 * `ShareLinkError` when there is one but it did not survive the journey.
 */
export function parseShareHash(text: string): ParsedShare | null {
  const m = text.match(ROUTE_LINK);
  if (!m) return null;
  try {
    return decodePayload(m[1]);
  } catch (e) {
    // A mail client that wrapped the link put line breaks through the middle of
    // the fragment, so the match above stopped at the first one. Rejoining the
    // text gets the rest back. If the rejoin instead glues trailing prose onto
    // the fragment, the checksum rejects it and we report the original damage.
    const rejoined = text.replace(/\s+/g, '');
    const m2 = rejoined.match(ROUTE_LINK);
    if (m2 && m2[1] !== m[1]) {
      try {
        return decodePayload(m2[1]);
      } catch {
        /* the rejoin was not the answer — fall through to the original */
      }
    }
    throw e;
  }
}

function decodePayload(b64url: string): ParsedShare | null {
  let payload: SharePayload;
  try {
    const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
    const json = new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))
    );
    payload = JSON.parse(json) as SharePayload;
  } catch {
    // Bad base64, bad UTF-8 or unterminated JSON — all of them mean the link
    // did not arrive whole.
    throw new ShareLinkError(DAMAGED_LINK_MESSAGE);
  }
  // Links built before `k` existed carry no checksum; they are still readable,
  // just unverified.
  if (payload.k && payload.k !== checksum(payload)) {
    throw new ShareLinkError(CORRUPTED_LINK_MESSAGE);
  }
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
