import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OVERPASS_URLS, queryOverpass } from './overpass';

const [FIRST, SECOND, THIRD] = OVERPASS_URLS;

/** How a server behaves on each successive request: answers, is busy, is
 *  unreachable, or — like the dead machine behind #102 — never replies. */
type Reply = 'ok' | 'busy' | 'rate-limited' | 'unreachable' | 'hang';

/** Stand in for the network: each server works through its own script of
 *  replies, `delayMs` after being asked, and the last reply repeats. */
function fakeServers(scripts: Record<string, Reply[]>, delayMs = 500) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', (url: string, init: { signal: AbortSignal }) => {
    const script = scripts[url] ?? ['hang'];
    const n = calls.filter((u) => u === url).length;
    calls.push(url);
    const reply = script[Math.min(n, script.length - 1)];
    return new Promise((resolve, reject) => {
      const aborted = () => reject(new DOMException('aborted', 'AbortError'));
      init.signal.addEventListener('abort', aborted);
      if (reply === 'hang') return;
      setTimeout(() => {
        if (reply === 'unreachable') reject(new TypeError('Failed to fetch'));
        else if (reply === 'busy') resolve({ ok: false, status: 504 });
        else if (reply === 'rate-limited') resolve({ ok: false, status: 429 });
        else resolve({ ok: true, status: 200, json: async () => ({ elements: [{ id: 1, url }] }) });
      }, delayMs);
    });
  });
  return calls;
}

/** Start a query and note how it ends, without letting a rejection go unhandled. */
function run(timeoutMs = 25000, signal?: AbortSignal) {
  const outcome: { value?: unknown; error?: Error } = {};
  const done = queryOverpass('[out:json];', timeoutMs, signal).then(
    (v) => (outcome.value = v),
    (e: Error) => (outcome.error = e)
  );
  return { outcome, done };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('queryOverpass', () => {
  it('lists each server once — two names for one machine only race it against itself', () => {
    expect(new Set(OVERPASS_URLS).size).toBe(OVERPASS_URLS.length);
    expect(OVERPASS_URLS.some((u) => u.includes('kumi.systems'))).toBe(false);
  });

  it('takes the first answer and asks nobody else if it comes quickly', async () => {
    const calls = fakeServers({ [FIRST]: ['ok'] });
    const { outcome, done } = run();
    await vi.advanceTimersByTimeAsync(600);
    await done;
    expect(outcome.value).toEqual({ elements: [{ id: 1, url: FIRST }] });
    expect(calls).toEqual([FIRST]);
  });

  it('outruns a server that never answers', async () => {
    // The #102 failure: the dead machine first in line held every search.
    const calls = fakeServers({ [FIRST]: ['hang'], [SECOND]: ['ok'] });
    const { outcome, done } = run();
    await vi.advanceTimersByTimeAsync(3500);
    await done;
    expect(outcome.value).toEqual({ elements: [{ id: 1, url: SECOND }] });
    expect(calls).toEqual([FIRST, SECOND]);
  });

  it('asks a busy server again, and uses the answer', async () => {
    const calls = fakeServers({ [FIRST]: ['busy', 'ok'], [SECOND]: ['hang'], [THIRD]: ['hang'] });
    const { outcome, done } = run();
    await vi.advanceTimersByTimeAsync(10000);
    await done;
    expect(outcome.value).toEqual({ elements: [{ id: 1, url: FIRST }] });
    expect(calls.filter((u) => u === FIRST)).toHaveLength(2);
  });

  it('gives a busy server only one more try', async () => {
    const calls = fakeServers({ [FIRST]: ['busy'], [SECOND]: ['busy'], [THIRD]: ['busy'] });
    const { outcome, done } = run();
    await vi.advanceTimersByTimeAsync(20000);
    await done;
    expect(outcome.error?.message).toBe('server busy (504)');
    for (const url of OVERPASS_URLS) expect(calls.filter((u) => u === url)).toHaveLength(2);
  });

  it('does not ask again a server that says we have asked too often', async () => {
    const calls = fakeServers({ [FIRST]: ['rate-limited', 'ok'], [SECOND]: ['hang'], [THIRD]: ['hang'] });
    const { done } = run(8000);
    await vi.advanceTimersByTimeAsync(8000);
    await done;
    expect(calls.filter((u) => u === FIRST)).toHaveLength(1);
  });

  it('does not ask again a server that could not be reached', async () => {
    const calls = fakeServers({ [FIRST]: ['unreachable'], [SECOND]: ['unreachable'], [THIRD]: ['unreachable'] });
    const { outcome, done } = run();
    await vi.advanceTimersByTimeAsync(5000);
    await done;
    expect(outcome.error?.message).toBe('Failed to fetch');
    expect(calls).toEqual([FIRST, SECOND, THIRD]);
  });

  it('gives up at the overall timeout when nothing answers', async () => {
    fakeServers({});
    const { outcome, done } = run(8000);
    await vi.advanceTimersByTimeAsync(7999);
    expect(outcome.error).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(outcome.error?.message).toBe('timed out');
  });

  it('stops at once when called off, even with a retry still to come', async () => {
    const calls = fakeServers({ [FIRST]: ['busy', 'ok'], [SECOND]: ['hang'], [THIRD]: ['hang'] });
    const ctrl = new AbortController();
    const { outcome, done } = run(25000, ctrl.signal);
    await vi.advanceTimersByTimeAsync(600); // FIRST has said busy; its retry is due
    const askedBefore = calls.length;
    ctrl.abort();
    await vi.advanceTimersByTimeAsync(0);
    await done;
    expect(outcome.error?.name).toBe('AbortError');
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(askedBefore);
  });
});
