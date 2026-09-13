// Getting a new deploy onto the phone without closing and reopening the app.
//
// public/sw.js serves the saved copy of the app so the map paints at once, and
// downloads the latest build in the background. On its own that meant a deploy
// showed up one open late — and later still on an iPhone, which usually only
// pauses a "closed" app, so reopening it loaded nothing at all. This asks the
// service worker whether it has found a newer build than the one running, both
// at launch and every time the app comes back to the foreground, and moves onto
// it: by itself if you have only just opened the app, with a button if you are
// already using it.

import { UPDATE_AUTO_RELOAD_MS } from '../config';
import { $ } from '../ui/dom';

// Read as this module loads, which is before main.ts's own body runs: sharing.ts
// and pins.ts strip a #r= or #p= link from the address as they open it, and a
// reload after that would drop the route or pin you were sent. An app opened
// from a link never reloads by itself.
const openedFromLink = location.hash.length > 1;

const fileName = (src: string): string => src.slice(src.lastIndexOf('/') + 1);

/** The entry script of the newest build the service worker has, or null. */
function latestEntry(sw: ServiceWorker): Promise<string | null> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (e) => resolve(e.data?.entry ?? null);
    sw.postMessage({ type: 'check-update' }, [channel.port2]);
  });
}

export function initUpdates(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  // Vite names the entry script after a hash of its contents, and the build
  // time baked into it (shown in Settings) changes every build, so a different
  // file name is a different build.
  const running = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src;
  if (!running) return;

  const launchedAt = Date.now();
  let touched = false;
  for (const type of ['pointerdown', 'touchstart', 'keydown', 'wheel']) {
    window.addEventListener(type, () => { touched = true; }, { capture: true, passive: true, once: true });
  }

  const pill = $('updatePill');
  pill.addEventListener('click', () => location.reload());

  let checking = false;
  async function check(): Promise<void> {
    const sw = navigator.serviceWorker.controller;
    if (!sw || checking || !pill.classList.contains('hidden')) return;
    checking = true;
    let latest: string | null;
    try {
      latest = await latestEntry(sw);
    } finally {
      checking = false;
    }
    if (!latest || fileName(latest) === fileName(running!)) return;
    // Only reload unasked while nothing on screen can be lost: the first few
    // seconds after opening, before you have touched anything. A resume never
    // qualifies — you may have left a half-planned route behind.
    const justOpened = !touched && Date.now() - launchedAt < UPDATE_AUTO_RELOAD_MS;
    if (justOpened && !openedFromLink) location.reload();
    else pill.classList.remove('hidden');
  }

  void navigator.serviceWorker.ready.then(check);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    // Also pick up a changed sw.js, which the browser otherwise only looks for
    // on a page load.
    void navigator.serviceWorker.getRegistration().then((r) => r?.update());
    void check();
  });
}
