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
import {
  buildShareUrl,
  DAMAGED_LINK_MESSAGE,
  parseShareHash,
  type ParsedShare
} from '../share';
import { type SavedRoute, type Settings } from '../state';
import { $, hideToast, toast } from '../ui/dom';

/** Below about three screen pixels a camera can no longer resolve one module,
    and the code is decoration. The share panel is only ~292px wide, so a dense
    code scaled to fit it looked valid and never scanned (#44). */
const MIN_CELL = 3;
/** The quiet zone the spec asks for, in modules — the white border a decoder
    needs to find the code at all. */
const QUIET_MODULES = 4;

type QrCode = ReturnType<typeof qrcode>;

let settings: Settings;
let saveRoute: (r: SavedRoute) => void;
let setActiveRoute: (r: SavedRoute | null, fit?: boolean, persist?: boolean) => void;
let showPanel: (html: string) => HTMLElement;
let hidePanel: () => void;

/**
 * Pull a route link out of arbitrary text, or null if there isn't a usable one.
 * The scanner's question is only ever "is there a route in this frame?" — a
 * damaged one is no different from somebody else's QR code, and either way it
 * should keep looking rather than stop and complain.
 */
export function parseRouteLink(text: string): ParsedShare | null {
  try {
    return parseShareHash(text);
  } catch {
    return null; // not a route link we can read
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
  let parsed: ParsedShare | null;
  try {
    parsed = parseShareHash(text);
  } catch (e) {
    // There was a link on the clipboard; it just didn't survive the trip. Say
    // which, rather than the misleading "no route link found".
    return toast((e as Error).message, 7000);
  }
  if (!parsed) return toast('No route link found on the clipboard', 4000);
  hidePanel();
  await importParsed(parsed);
}

/** Running from the home screen rather than in a browser tab. Asked when it is
    needed, not as the module loads — a module that reaches for the DOM on
    import is one nothing else can pull in. */
const isStandalone = (): boolean =>
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
  } catch (e) {
    return toast((e as Error).message, 7000);
  }
  // A fragment that meant to carry a route but yielded none. Staying silent
  // here is what left people looking at a plain map wondering where the route
  // went, so say something even though there is nothing to import.
  if (!parsed) {
    if (location.hash.includes('#r')) toast(DAMAGED_LINK_MESSAGE, 7000);
    return;
  }
  history.replaceState(null, '', location.pathname + location.search);
  await importParsed(parsed);
  if (!isStandalone() && /iPhone|iPad|iPod/.test(navigator.userAgent)) {
    openHandoffPanel(originalUrl, parsed.name);
  }
}

// ---------------------------------------------------------------- sending

/**
 * How to draw a `modules`-wide code into `avail` px of screen.
 *
 * The module size is whole pixels on purpose: a fractional one lands off the
 * pixel grid and the browser antialiases every edge into grey, which is a
 * decode failure of its own. And `createSvgTag`'s margin is in *pixels*, so the
 * quiet zone has to be scaled with it — the flat `margin: 2` this replaces left
 * the code with a two-pixel white border, which is no quiet zone at all.
 *
 * Exported because the sizes it picks are the whole of #44, and the test
 * decodes a real code drawn at them.
 */
export function qrRender(modules: number, avail: number): { cellSize: number; margin: number } {
  const cellSize = Math.max(1, Math.floor(avail / (modules + QUIET_MODULES * 2)));
  return { cellSize, margin: cellSize * QUIET_MODULES };
}

const svgFor = (qr: QrCode, avail: number): string =>
  qr.createSvgTag(qrRender(qr.getModuleCount(), avail));

/**
 * The dense-code escape hatch: the whole viewport is two to three times the
 * width of the panel, which for a long route is the difference between a code a
 * camera can resolve and one it cannot.
 */
function openQrFullscreen(qr: QrCode): void {
  const el = document.createElement('div');
  el.id = 'qrFull';
  const avail = Math.min(window.innerWidth, window.innerHeight) - 32;
  el.innerHTML = `
    <div class="qrFullCode">${svgFor(qr, avail)}</div>
    <p>${
      qrRender(qr.getModuleCount(), avail).cellSize >= MIN_CELL
        ? 'Point the other phone’s camera at this'
        : 'Still too dense to scan on a screen this size — send the link instead'
    }</p>
    <button class="qrFullClose">Done</button>`;
  el.addEventListener('click', () => el.remove());
  document.body.appendChild(el);
}

/** The share sheet for a saved route: a QR to scan, and a link to copy. */
export function openSharePanel(r: SavedRoute): void {
  const url = buildShareUrl(r, settings.profile);
  let qr: QrCode | null = null;
  try {
    qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
  } catch {
    qr = null; // past QR version 40 — more data than any code can hold
  }
  showPanel(`
    <h3>Share “${r.name.replace(/</g, '&lt;')}”</h3>
    <p class="hint">Scan with your phone's camera to open this route in Trailhead on the phone
    (it saves itself automatically), or copy the link and send it any way you like.</p>
    ${
      qr
        ? '<div class="qrBox" id="qrBox"></div>'
        : '<p class="hint">Route too detailed for a QR code — use the link instead.</p>'
    }
    <div class="row"><button id="copyLink" style="flex:1">Copy link</button></div>
  `);
  // Sized from the box's real width rather than a number copied out of the
  // stylesheet, so it stays right on any viewport — and never wider than the
  // box, which is what let the old fixed cellSize get scaled down to grey mush.
  if (qr) {
    const box = $('qrBox');
    const code = qr;
    const avail = box.clientWidth || 292;
    box.innerHTML = svgFor(code, avail);
    // Enlarging is always on offer, because even a code that fits here scans
    // more easily bigger. What changes with a dense one is that we say outright
    // it cannot be scanned at this size, rather than shrinking it and letting
    // the receiver find out by holding a camera at it.
    box.insertAdjacentHTML(
      'beforeend',
      `${
        qrRender(code.getModuleCount(), avail).cellSize < MIN_CELL
          ? '<p class="hint">Too small to scan at this size.</p>'
          : ''
      }
       <button id="qrEnlarge" class="secondary">Enlarge to scan</button>`
    );
    $('qrEnlarge').addEventListener('click', () => openQrFullscreen(code));
    box.querySelector('svg')?.addEventListener('click', () => openQrFullscreen(code));
  }
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
