// An attempt to clear iOS 27's frosted blur off the top of the installed app.
//
// iOS 27 draws its own blur across the top of a Home Screen web app, reaching
// past the status bar and over the top half of the search bar. It is drawn
// over the page, so CSS cannot remove it, and a solid strip at the top edge, a
// solid status bar, and moving the search bar below it were all tried on an
// iPhone and either changed nothing or looked wrong.
//
// What is left is an experiment someone else found by accident on an iPhone
// (tips.ojapp.app, "Removing the Top Blur in iOS 27 PWAs"): opening a slide-in
// drawer made the blur go away. So once the app has loaded, this fades in a
// see-through cover, slides a see-through panel in from the right, and half a
// second later takes the cover away and slides the panel back off-screen. The
// panel is left there, off-screen, because removing it was seen to bring the
// blur back. Both are 1% white and take no taps, so nothing shows and nothing
// is blocked. Why iOS reacts to this is unknown, and a later iOS may stop
// reacting to it; if it never helps, delete this file and its call in main.ts.

const SETTLE_MS = 500;

export function initTopBlurWorkaround(): void {
  const ios = CSS.supports('-webkit-touch-callout', 'none');
  const installed =
    matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (!ios || !installed) return;

  const run = () => {
    const cover = document.createElement('div');
    cover.id = 'blurCover';
    const panel = document.createElement('div');
    panel.id = 'blurPanel';
    cover.setAttribute('aria-hidden', 'true');
    panel.setAttribute('aria-hidden', 'true');
    document.body.append(cover, panel);
    // Two frames, so both are painted in their starting place before they move
    // and the transitions actually run.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      cover.classList.add('on');
      panel.classList.add('on');
      setTimeout(() => {
        cover.remove();
        panel.classList.remove('on');
      }, SETTLE_MS);
    }));
  };
  if (document.readyState === 'complete') run();
  else window.addEventListener('load', run, { once: true });
}
