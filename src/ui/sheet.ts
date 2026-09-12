// Drag the bottom sheet down by its handle to throw it away.
//
// The sheet has always drawn the little grey bar that every bottom sheet draws,
// and on every app that draws one, pulling it down pulls the sheet down. Here
// it was decoration, which is worse than not drawing it at all: the sheet looks
// like it answers to a gesture it ignores.
//
// It earns its keep because of where the sheet sits. The sheet stops at 88% of
// the screen, so the strip of map you can tap to dismiss it is a tenth of the
// screen at the very top — the one place a thumb cannot reach on a phone held
// in one hand. Rather than shrink the sheet (which would cost Settings and the
// map key the room they need), this adds a way out that lands wherever the
// thumb already is. The close button, the scrim and the tab toggle all stay.
//
// The module owns the gesture and nothing else: it is handed the elements and
// the app's own close callback, so ui/panels.ts stays the only thing that knows
// what closing a sheet actually involves.

/** How far down the sheet has to be let go before it closes rather than springs back. */
const CLOSE_PX = 110;
/** …or, short of that, how fast it was still moving when let go (px/ms) … */
const FLING_VELOCITY = 0.5;
/** …having gone at least this far, so a twitch can never count as a flick. */
const FLING_MIN_PX = 24;
/**
 * The shortest gap between two moves we will believe when working out speed.
 * A browser coalesces pointer moves and can deliver two of them a fraction of
 * a millisecond apart; dividing by that gives a speed of hundreds of px/ms off
 * a 1px wobble, and the sheet flies away under a finger that barely moved.
 */
const MIN_SAMPLE_MS = 8;
/** Matches the .settling transition in style.css; the class comes off after it. */
const SETTLE_MS = 220;

/**
 * Make `sheet` draggable downwards by `handle`, closing it through `close()`
 * when the drag is decisive enough.
 *
 * `scrim` is dimmed in step with the drag so the two read as one movement — a
 * sheet sliding down in front of a backdrop that stays at full strength looks
 * like two unrelated things.
 *
 * Returns the function that puts the gesture back to rest. hidePanel() has to
 * call it, because the sheet can also go away *under* the gesture — by the
 * close button, the scrim or a tab — and whatever is left on the element would
 * otherwise be inherited by the next sheet to open.
 */
export function initSheetDrag(opts: {
  sheet: HTMLElement;
  handle: HTMLElement;
  scrim: HTMLElement;
  close: () => void;
}): () => void {
  const { sheet, handle, scrim, close } = opts;

  let pointerId: number | null = null;
  let startY = 0;
  let dy = 0;
  // Only the last move is kept, not a history: what matters is the speed at the
  // moment of release, and averaging over the whole drag just blunts a flick.
  let lastY = 0;
  let lastT = 0;
  let velocity = 0;
  let settleTimer: number | undefined;

  /** Put the sheet where the finger says, and fade the scrim to match. */
  function draw(): void {
    sheet.style.setProperty('--sheet-dy', `${dy}px`);
    // Measured against the sheet's own height, so the same drag reads the same
    // on a short panel and a tall one: the backdrop is gone at about the moment
    // the sheet is.
    const travel = sheet.offsetHeight || 1;
    scrim.style.opacity = String(Math.max(0, 1 - dy / travel));
  }

  /** Back to rest, leaving nothing behind for the next sheet. */
  function reset(): void {
    window.clearTimeout(settleTimer);
    sheet.classList.remove('dragging', 'settling');
    sheet.style.removeProperty('--sheet-dy');
    scrim.style.removeProperty('opacity');
    pointerId = null;
    dy = 0;
    velocity = 0;
  }

  handle.addEventListener('pointerdown', (e: PointerEvent) => {
    // The close button shares this strip, and a tap on it is not a drag.
    if ((e.target as HTMLElement).closest?.('.closeX')) return;
    // Mid-settle: a second grab takes over from wherever the spring had got to.
    window.clearTimeout(settleTimer);
    sheet.classList.remove('settling');
    pointerId = e.pointerId;
    startY = lastY = e.clientY;
    lastT = e.timeStamp;
    dy = 0;
    velocity = 0;
    sheet.classList.add('dragging');
    // Keeps the move and up events coming once the finger has left the strip,
    // which after 110px of downward drag it certainly has. Throws if the
    // pointer has already gone, and there is nothing useful to do about that.
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      /* no capture — the events still arrive while the finger is over the strip */
    }
  });

  handle.addEventListener('pointermove', (e: PointerEvent) => {
    if (pointerId === null || e.pointerId !== pointerId) return;
    const raw = e.clientY - startY;
    // Upwards is resisted rather than forbidden: the sheet is already as tall
    // as it goes, so there is nowhere to drag it to, but letting it give a
    // little keeps finger and sheet feeling attached.
    dy = raw >= 0 ? raw : raw / 4;
    velocity = (e.clientY - lastY) / Math.max(e.timeStamp - lastT, MIN_SAMPLE_MS);
    lastY = e.clientY;
    lastT = e.timeStamp;
    draw();
  });

  function release(e: PointerEvent): void {
    if (pointerId === null || e.pointerId !== pointerId) return;
    pointerId = null;
    sheet.classList.remove('dragging');
    sheet.classList.add('settling');
    if (dy > CLOSE_PX || (dy > FLING_MIN_PX && velocity > FLING_VELOCITY)) {
      // Run it the rest of the way off the bottom first, then close: snapping
      // shut from wherever the finger stopped loses the sense that you threw
      // it somewhere. close() comes back through hidePanel() to reset().
      sheet.style.setProperty('--sheet-dy', `${sheet.offsetHeight}px`);
      scrim.style.opacity = '0';
      settleTimer = window.setTimeout(close, SETTLE_MS);
      return;
    }
    // Not far enough, or pushed back up: spring home.
    sheet.style.setProperty('--sheet-dy', '0px');
    scrim.style.removeProperty('opacity');
    settleTimer = window.setTimeout(reset, SETTLE_MS);
  }

  handle.addEventListener('pointerup', release);
  // A system gesture — the app switcher, an incoming call — can take the
  // pointer away mid-drag. Treat it as a let-go rather than leaving the sheet
  // stranded half way down.
  handle.addEventListener('pointercancel', release);

  return reset;
}
