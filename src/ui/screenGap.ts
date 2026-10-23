// The strip iOS leaves under an installed app's page. From iOS 26 a home-screen
// app with viewport-fit=cover and a black-translucent status bar is laid out in
// a viewport one status bar shorter than the screen (WebKit bug 301108):
// innerHeight, 100dvh and bottom: 0 all stop that far above the real foot of
// the screen. Nothing in CSS reports the shortfall, so it is measured here and
// published as --screen-gap, which style.css uses to pull the tab bar down to
// the bottom edge.

/** Larger than any status bar. A bigger shortfall is not this bug (an on-screen
    keyboard, say), and the last good value stays. */
const MAX_GAP = 80;

/** Only an iPhone-style home-screen app: in a Safari tab the toolbars make the
    page shorter than the screen for real, and so do Android's system bars. */
const applies = (): boolean =>
  CSS.supports('-webkit-touch-callout', 'none') &&
  (window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true);

function measure(): void {
  // iOS reports screen in portrait whichever way the phone is held.
  const long = Math.max(screen.width, screen.height);
  const short = Math.min(screen.width, screen.height);
  const landscape = window.innerWidth > window.innerHeight;
  // A window narrower than the screen (an iPad in Split View or Stage Manager)
  // is short on purpose, and its foot is not the screen's.
  if (window.innerWidth !== (landscape ? long : short)) return;
  const gap = Math.round((landscape ? short : long) - window.innerHeight);
  if (gap > MAX_GAP) return;
  document.documentElement.style.setProperty('--screen-gap', `${Math.max(gap, 0)}px`);
}

export function initScreenGap(): void {
  if (!applies()) return;
  measure();
  // The viewport settles after launch and changes on rotation (see
  // watchViewport in map/map.ts for the same settling).
  window.addEventListener('resize', measure);
  window.addEventListener('pageshow', measure);
  window.visualViewport?.addEventListener('resize', measure);
  for (const t of [100, 350, 700, 1500, 3000]) setTimeout(measure, t);
}
