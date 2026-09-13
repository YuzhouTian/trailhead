/**
 * @vitest-environment jsdom
 *
 * The drag-to-dismiss gesture. What is worth pinning down here is the decision
 * at the end of a drag — close, or spring back — and that the sheet is left
 * square whichever way it goes, since the next sheet reuses the same element.
 *
 * jsdom has PointerEvent but no setPointerCapture (the module already tolerates
 * that, because a browser throws from it too when the pointer has gone) and no
 * layout, so offsetHeight is 0 throughout. Neither matters: the threshold is in
 * px of finger travel, not a fraction of the sheet.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initSheetDrag } from './sheet';

let sheet: HTMLElement;
let handle: HTMLElement;
let scrim: HTMLElement;
let closed: number;
let reset: () => void;

/** One pointer event on the handle, at `y`, `t` ms into the drag. */
function pointer(type: string, y: number, t = 0, target: HTMLElement = handle): void {
  const e = new PointerEvent(type, { pointerId: 1, clientY: y, bubbles: true });
  // jsdom stamps timeStamp itself and won't take one from the init dict, but
  // velocity is read off it, so the test has to be able to set it.
  Object.defineProperty(e, 'timeStamp', { value: t });
  target.dispatchEvent(e);
}

/** Drag from 0 to `to` in one move, `ms` apart, then let go. */
function drag(to: number, ms = 400): void {
  pointer('pointerdown', 0, 0);
  pointer('pointermove', to, ms);
  pointer('pointerup', to, ms);
}

const dy = () => sheet.style.getPropertyValue('--sheet-dy');

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = `
    <div id="scrim"></div>
    <div id="sheet"><div id="head"><button class="closeX"></button></div></div>`;
  sheet = document.getElementById('sheet')!;
  handle = document.getElementById('head')!;
  scrim = document.getElementById('scrim')!;
  closed = 0;
  reset = initSheetDrag({ sheet, handle, scrim, close: () => closed++ });
});

describe('dragging the sheet', () => {
  it('follows the finger down and dims the scrim with it', () => {
    pointer('pointerdown', 0, 0);
    pointer('pointermove', 60, 100);
    expect(sheet.classList.contains('dragging')).toBe(true);
    expect(dy()).toBe('60px');
    expect(scrim.style.opacity).not.toBe('');
  });

  it('resists an upward drag rather than following it', () => {
    pointer('pointerdown', 0, 0);
    pointer('pointermove', -40, 100);
    // A quarter of the distance: the sheet gives, but it is clearly not going
    // anywhere, which is the truth — it is already as tall as it gets.
    expect(dy()).toBe('-10px');
  });

  it('ignores a pointer that is not the one that started the drag', () => {
    pointer('pointerdown', 0, 0);
    const other = new PointerEvent('pointermove', { pointerId: 2, clientY: 200, bubbles: true });
    handle.dispatchEvent(other);
    // Untouched — pointerdown alone doesn't move the sheet, so nothing is set.
    expect(dy()).toBe('');
  });

  it('does not start a drag from a tap on the close button', () => {
    const x = handle.querySelector('.closeX') as HTMLElement;
    pointer('pointerdown', 0, 0, x);
    expect(sheet.classList.contains('dragging')).toBe(false);
  });
});

describe('letting go', () => {
  it('closes after a long slow drag', () => {
    drag(160);
    expect(closed).toBe(0); // it runs off the bottom first
    vi.runAllTimers();
    expect(closed).toBe(1);
  });

  it('closes after a short fast flick', () => {
    drag(40, 20); // 2 px/ms — well past the fling threshold
    vi.runAllTimers();
    expect(closed).toBe(1);
  });

  it('springs back from a flick that was fast but went nowhere', () => {
    drag(12, 8); // 1.5 px/ms, but 12px is a twitch, not a throw
    vi.runAllTimers();
    expect(closed).toBe(0);
  });

  it('springs back from a short slow drag', () => {
    drag(40, 400);
    expect(dy()).toBe('0px');
    expect(sheet.classList.contains('settling')).toBe(true);
    vi.runAllTimers();
    expect(closed).toBe(0);
    expect(sheet.className).toBe('');
    expect(dy()).toBe('');
    expect(scrim.style.opacity).toBe('');
  });

  it('springs back from a small move delivered as a sub-millisecond burst', () => {
    // Coalesced moves can arrive a fraction of a millisecond apart. Dividing by
    // that gap gives a speed of hundreds of px/ms off a wobble, which used to
    // throw the sheet away under a finger that had barely moved.
    pointer('pointerdown', 0, 0);
    pointer('pointermove', 6, 0.1);
    pointer('pointerup', 6, 0.2);
    vi.runAllTimers();
    expect(closed).toBe(0);
  });

  it('springs back from a fast flick upwards, however fast', () => {
    pointer('pointerdown', 0, 0);
    pointer('pointermove', -80, 20);
    pointer('pointerup', -80, 20);
    vi.runAllTimers();
    expect(closed).toBe(0);
  });

  it('treats a cancelled pointer as a let-go', () => {
    pointer('pointerdown', 0, 0);
    pointer('pointermove', 160, 400);
    pointer('pointercancel', 160, 400);
    vi.runAllTimers();
    expect(closed).toBe(1);
  });
});

describe('being put back to rest', () => {
  it('clears a drag left half finished when the sheet closes another way', () => {
    pointer('pointerdown', 0, 0);
    pointer('pointermove', 70, 100);
    reset(); // what hidePanel() does when the scrim or a tab closes the sheet
    expect(sheet.className).toBe('');
    expect(dy()).toBe('');
    expect(scrim.style.opacity).toBe('');
  });

  it('cancels the pending close, so a sheet reopened mid-throw stays open', () => {
    drag(160);
    reset();
    vi.runAllTimers();
    expect(closed).toBe(0);
  });

  it('lets a new grab take over from a spring that is still running', () => {
    drag(40, 400);
    pointer('pointerdown', 0, 0);
    expect(sheet.classList.contains('settling')).toBe(false);
    expect(sheet.classList.contains('dragging')).toBe(true);
    vi.runAllTimers(); // the spring's timer must not fire under the new drag
    expect(sheet.classList.contains('dragging')).toBe(true);
  });
});

describe('a sheet with no scrim', () => {
  // Plan's sheet: the map behind it takes taps, so there is nothing to dim.
  it('still follows the finger and throws away', () => {
    // A fresh sheet and handle: the ones above already answer drags with a scrim.
    const bare = document.createElement('div');
    const bareHandle = document.createElement('div');
    bare.appendChild(bareHandle);
    document.body.appendChild(bare);
    let bareClosed = 0;
    initSheetDrag({ sheet: bare, handle: bareHandle, close: () => bareClosed++ });
    pointer('pointerdown', 0, 0, bareHandle);
    pointer('pointermove', 160, 400, bareHandle);
    expect(bare.style.getPropertyValue('--sheet-dy')).toBe('160px');
    pointer('pointerup', 160, 400, bareHandle);
    vi.runAllTimers();
    expect(bareClosed).toBe(1);
  });
});
