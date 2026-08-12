// Sending a route to someone else, and receiving one. Both ends of the #r=
// link: openSharePanel() writes one as a QR code and a copyable URL,
// importSharedRoute() and pasteSharedRoute() read one back.
//
// A share carries either waypoints (compact, and re-routed on arrival so it
// follows the receiver's own paths) or raw coordinates. importParsed() is where
// those two shapes become one SavedRoute, which is why the QR scanner hands its
// find here rather than building a route itself.
//
// The route this produces is not this module's to keep — like the planner, it
// saves and activates through callbacks, because the saved list and the active
// route belong to the app.

import qrcode from 'qrcode-generator';
import { computeClimbs, formatDistance, haversine } from '../geo';
import { routeMixed } from '../routing';
import { buildShareUrl, parseShareHash, type ParsedShare } from '../share';
import { type SavedRoute, type Settings } from '../state';
import { $, hideToast, toast } from '../ui/dom';

/** A route link anywhere in a blob of text — a pasted URL, or a scanned QR. */
const ROUTE_LINK = /#r=[A-Za-z0-9_-]+/;

let settings: Settings;
let saveRoute: (r: SavedRoute) => void;
let setActiveRoute: (r: SavedRoute | null, fit?: boolean, persist?: boolean) => void;
let showPanel: (html: string) => HTMLElement;
let hidePanel: () => void;

/**
 * Pull a route link out of arbitrary text, or null if there isn't a valid one.
 * Shared by the paste button and the QR scanner: one sees a clipboard, the
 * other a camera frame, but "is there a route in this string?" is one question.
 */
export function parseRouteLink(text: string): ParsedShare | null {
  const m = text.match(ROUTE_LINK);
  if (!m) return null;
  try {
    return parseShareHash(m[0]);
  } catch {
    return null; // not a valid route link
  }
}

// ---------------------------------------------------------------- receiving

/** Import a parsed share payload: re-route (waypoint shares), save, activate. */
export async function importParsed(parsed: ParsedShare): Promise<void> {
  try {
    let r: SavedRoute;
    if (parsed.waypoints) {
      toast('Loading shared route…', 0);
      const res = await routeMixed(
        parsed.waypoints,
        parsed.snaps,
        parsed.profile || settings.profile
      );
      r = {
        id: String(Date.now()),
        name: parsed.name,
        waypoints: parsed.waypoints,
        snaps: parsed.snaps ?? null,
        coords: res.coords,
        distanceM: res.distanceM,
        ascentM: res.ascentM,
        descentM: res.descentM,
        createdAt: Date.now()
      };
    } else {
      const coords = parsed.coords!;
      let dist = 0;
      for (let i = 1; i < coords.length; i++) dist += haversine(coords[i - 1], coords[i]);
      r = {
        id: String(Date.now()),
        name: parsed.name,
        waypoints: null,
        coords,
        distanceM: dist,
        ...computeClimbs(coords),
        createdAt: Date.now()
      };
    }
    hideToast();
    saveRoute(r);
    setActiveRoute(r);
    toast(`Loaded “${r.name}” (${formatDistance(r.distanceM)})`);
  } catch (e) {
    hideToast();
    toast(`Shared route failed to load: ${(e as Error).message}`, 6000);
  }
}

/** The Routes panel's "Paste shared route": read the clipboard, or ask. */
export async function pasteSharedRoute(): Promise<void> {
  let text = '';
  try {
    text = await navigator.clipboard.readText();
  } catch {
    text = prompt('Paste the route link:') ?? '';
  }
  const parsed = parseRouteLink(text);
  if (!parsed) return toast('No route link found on the clipboard', 4000);
  hidePanel();
  await importParsed(parsed);
}

const isStandalone =
  window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as unknown as { standalone?: boolean }).standalone === true;

/** iOS opens scanned QR links in Safari, whose storage is separate from the
    home-screen app's — walk the user through the clipboard hand-off. */
function openHandoffPanel(url: string, name: string): void {
  showPanel(`
    <h3>Get this route into the app</h3>
    <p class="hint">The route loaded here in the browser, but the home-screen app keeps
    its own separate storage. To hand “${name.replace(/</g, '&lt;')}” over:</p>
    <ol style="font-size:14px; padding-left:20px; line-height:1.5">
      <li>Tap <b>Copy route link</b> below</li>
      <li>Open <b>Trailhead</b> from your home screen</li>
      <li>Tap <svg class="inlineIco" viewBox="0 0 24 24"><use href="#i-routes"/></svg> <b>Routes</b> → <b>Paste shared route</b></li>
    </ol>
    <div class="row"><button id="handoffCopy" style="flex:1">Copy route link</button></div>
  `);
  $('handoffCopy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast('Copied — now open the Trailhead app');
    } catch {
      prompt('Copy the link:', url);
    }
  });
}

/** Startup: if the app was opened on a #r= link, load that route. */
export async function importSharedRoute(): Promise<void> {
  let parsed: ParsedShare | null;
  const originalUrl = location.href;
  try {
    parsed = parseShareHash(location.hash);
  } catch {
    return toast('Could not read the shared route link', 5000);
  }
  if (!parsed) return;
  history.replaceState(null, '', location.pathname + location.search);
  await importParsed(parsed);
  if (!isStandalone && /iPhone|iPad|iPod/.test(navigator.userAgent)) {
    openHandoffPanel(originalUrl, parsed.name);
  }
}

// ---------------------------------------------------------------- sending

/** The share sheet for a saved route: a QR to scan, and a link to copy. */
export function openSharePanel(r: SavedRoute): void {
  const url = buildShareUrl(r, settings.profile);
  let qrHtml: string;
  try {
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    qrHtml = `<div class="qrBox">${qr.createSvgTag({ cellSize: 4, margin: 2 })}</div>`;
  } catch {
    qrHtml = '<p class="hint">Route too detailed for a QR code — use the link instead.</p>';
  }
  showPanel(`
    <h3>Share “${r.name.replace(/</g, '&lt;')}”</h3>
    <p class="hint">Scan with your phone's camera to open this route in Trailhead on the phone
    (it saves itself automatically), or copy the link and send it any way you like.</p>
    ${qrHtml}
    <div class="row"><button id="copyLink" style="flex:1">Copy link</button></div>
  `);
  $('copyLink').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied');
    } catch {
      prompt('Copy the link:', url);
    }
  });
}

// ---------------------------------------------------------------- wiring

/**
 * Hand sharing what it needs. Nothing to listen to here — the Routes panel
 * wires the buttons and the startup sequence calls importSharedRoute() — so
 * this only takes delivery of the app's callbacks.
 */
export function initSharing(opts: {
  settings: Settings;
  /** Add a received route to the saved list and persist it. */
  saveRoute: (r: SavedRoute) => void;
  /** Make a route the active one — same signature as the app's own. */
  setActiveRoute: (r: SavedRoute | null, fit?: boolean, persist?: boolean) => void;
  /** Panels: the share sheet and the iOS hand-off both need to open one. */
  showPanel: (html: string) => HTMLElement;
  hidePanel: () => void;
}): void {
  settings = opts.settings;
  saveRoute = opts.saveRoute;
  setActiveRoute = opts.setActiveRoute;
  showPanel = opts.showPanel;
  hidePanel = opts.hidePanel;
}
