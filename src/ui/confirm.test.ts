// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { askConfirm } from './confirm';

// jsdom has <dialog> but not its methods. These do what the browser does as far
// as askConfirm can tell: open sets `open`, close sets returnValue and fires
// 'close'.
beforeAll(() => {
  const proto = HTMLDialogElement.prototype as HTMLDialogElement & Record<string, unknown>;
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  proto.close = function (this: HTMLDialogElement, value?: string) {
    if (!this.open) return;
    if (value !== undefined) this.returnValue = value;
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

const sheet = () => document.getElementById('confirmSheet') as HTMLDialogElement;
const press = (sel: string) => (sheet().querySelector(sel) as HTMLButtonElement).click();

describe('askConfirm', () => {
  it('shows the question and the action, and says yes only for the action', async () => {
    const answer = askConfirm('Delete “Helvellyn”?', { action: 'Delete', danger: true });
    expect(sheet().open).toBe(true);
    expect(document.getElementById('confirmMsg')!.textContent).toBe('Delete “Helvellyn”?');
    const ok = document.getElementById('confirmOk')!;
    expect(ok.textContent).toBe('Delete');
    expect(ok.classList.contains('danger')).toBe(true);
    press('#confirmOk');
    expect(await answer).toBe(true);
    expect(sheet().open).toBe(false);
  });

  it('says no for Cancel, and starts on Cancel so a stray Enter deletes nothing', async () => {
    const answer = askConfirm('Clear?', { action: 'Download' });
    expect(document.activeElement).toBe(sheet().querySelector('button.secondary'));
    expect(document.getElementById('confirmOk')!.classList.contains('danger')).toBe(false);
    press('button.secondary');
    expect(await answer).toBe(false);
  });

  it('says no for a tap on the backdrop', async () => {
    const answer = askConfirm('Clear?', { action: 'Clear' });
    sheet().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(await answer).toBe(false);
  });

  it('answers an unanswered question "no" when a new one replaces it', async () => {
    const first = askConfirm('First?', { action: 'Yes' });
    const second = askConfirm('Second?', { action: 'Yes' });
    expect(await first).toBe(false);
    press('#confirmOk');
    expect(await second).toBe(true);
  });
});
