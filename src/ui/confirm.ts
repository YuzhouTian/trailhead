// Trailhead's own "are you sure?", in place of the browser's confirm().
//
// confirm() can be switched off by the browser. Firefox offers "Don't allow
// this site to prompt you again" once a page has shown a few, and after that
// every confirm() in the tab returns false at once, with nothing on screen —
// so Clear all offline maps, and every delete, simply did nothing. A <dialog>
// is part of the page, so nothing can suppress it, and it can look like the
// app rather than like the browser.
//
// showModal() puts it in the browser's top layer: above the open sheet and the
// toast without a z-index arms race, with the rest of the page inert behind it
// and Escape wired to cancel.

import { $ } from './dom';

export interface ConfirmOptions {
  /** The action button's label, a verb: "Delete", "Clear". */
  action: string;
  /** Red action button, for anything that throws something away. */
  danger?: boolean;
}

/** The one dialog, made on first use and kept for the life of the page. */
let dialog: HTMLDialogElement | null = null;

function getDialog(): HTMLDialogElement {
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.id = 'confirmSheet';
  dialog.innerHTML = `
    <p id="confirmMsg"></p>
    <div class="confirmActs">
      <button type="button" value="cancel" class="secondary">Cancel</button>
      <button type="button" value="ok" id="confirmOk"></button>
    </div>`;
  document.body.appendChild(dialog);
  const d = dialog;
  d.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => d.close(b.value)));
  // A tap on the dimmed backdrop lands on the dialog element itself (its box
  // covers only the card, but the backdrop's clicks are reported against it);
  // a tap inside the card lands on a child. Backdrop means cancel, as it does
  // for the sheets.
  d.addEventListener('click', (e) => {
    if (e.target === d) d.close('cancel');
  });
  return d;
}

/**
 * Ask a yes/no question. Resolves true only for the action button: Cancel,
 * Escape and a tap on the backdrop all resolve false.
 */
export function askConfirm(message: string, opts: ConfirmOptions): Promise<boolean> {
  const d = getDialog();
  // A second question while one is open replaces it, answering the first "no".
  if (d.open) d.close('cancel');
  $('confirmMsg').textContent = message;
  const ok = $<HTMLButtonElement>('confirmOk');
  ok.textContent = opts.action;
  ok.classList.toggle('danger', !!opts.danger);
  d.returnValue = '';
  return new Promise((resolve) => {
    d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true });
    d.showModal();
    // Focus the safe choice, so a stray Enter cannot delete anything.
    (d.querySelector('button.secondary') as HTMLButtonElement).focus();
  });
}
