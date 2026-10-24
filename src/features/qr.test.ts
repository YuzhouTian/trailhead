// @vitest-environment jsdom

// Reading a route QR with the camera. jsdom has no camera, no video frames, no
// canvas pixels and no animation frames, so all four are stood in for here,
// and the test steps the clock and the frames by hand.
//
// What is worth pinning is less the decode than the edges of it: every way
// the camera can fail to start, how often a frame is actually decoded, which
// part of the frame is, a QR that is not ours being ignored, and — the one a
// phone would notice — that the camera is let go of whenever scanning ends.
// A stream left running keeps the camera light on and the battery draining
// with nothing on screen to say why.

import indexHtml from '../../index.html?raw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The decoder, as a recorder that finds nothing unless a test says. */
const decoder = vi.hoisted(() => () => ({ default: vi.fn(() => null) }));
vi.mock('jsqr', decoder);
// What a link means is sharing's business, tested there.
vi.mock('./sharing', () => ({ parseRouteLink: vi.fn(() => null), importParsed: vi.fn(async () => {}) }));

/** The scanner overlay and the toast, lifted out of the real index.html. */
const PAGE = (() => {
  const doc = new DOMParser().parseFromString(indexHtml, 'text/html');
  return ['qrScan', 'toast'].map((id) => doc.getElementById(id)!.outerHTML).join('');
})();

/** A track of the camera's stream, recording whether it was let go of. */
interface FakeTrack {
  stopped: boolean;
  stop(): void;
}

/** The camera the test grants, refuses, or leaves out. */
let camera: {
  /** What getUserMedia was asked for, each time. */
  asked: MediaStreamConstraints[];
  /** What the next getUserMedia does. */
  answer: 'grant' | 'refuse';
  tracks: FakeTrack[];
  stream: MediaStream | null;
};

/** Animation frames requested and not yet run or cancelled, by id. */
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
/** What performance.now() says. */
let clock: number;

/** What each decode drew from the video, and what it handed the decoder. */
let draws: unknown[][];
let ctx: { drawImage: (...a: unknown[]) => void; getImageData: (x: number, y: number, w: number, h: number) => ImageData } | null;

function installCamera(present = true) {
  camera = { asked: [], answer: 'grant', tracks: [], stream: null };
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: present
      ? {
          getUserMedia: async (c: MediaStreamConstraints) => {
            camera.asked.push(c);
            if (camera.answer === 'refuse') throw new DOMException('denied', 'NotAllowedError');
            const track: FakeTrack = { stopped: false, stop() { this.stopped = true; } };
            camera.tracks.push(track);
            camera.stream = { getTracks: () => [track] } as unknown as MediaStream;
            return camera.stream;
          }
        }
      : undefined
  });
}

/**
 * A scanner module fresh from the registry. The reset matters: the stream and
 * the frame loop are module state, and so is the decoder's dynamic import.
 */
async function boot() {
  vi.resetModules();
  document.body.innerHTML = PAGE;
  installCamera();
  frames = new Map();
  nextFrame = 1;
  clock = 1000;
  draws = [];
  ctx = {
    drawImage: (...a) => draws.push(a),
    getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }) as ImageData
  };

  const video = document.getElementById('qrVideo') as HTMLVideoElement;
  const play = vi.fn(async () => {});
  video.play = play;
  // A camera that has started: a full frame's worth of data, 1080p.
  setVideo(video, { readyState: 4, width: 1920, height: 1080 });

  const qr = await import('./qr');
  // Not there at all when a test has made the decoder fail to load.
  const jsQR = vi.mocked((await import('jsqr').catch(() => ({ default: null })))!.default!);
  const sharing = vi.mocked(await import('./sharing'));
  const hidePanel = vi.fn();
  qr.initQr({ hidePanel });

  const $ = (id: string) => document.getElementById(id)!;
  return {
    qr,
    jsQR,
    sharing,
    hidePanel,
    video,
    play,
    $,
    scanning: () => !$('qrScan').classList.contains('hidden'),
    toast: () => $('toast').textContent,
    /** Start scanning and let the camera and decoder load. */
    async start() {
      await qr.startQrScan();
    },
    /** Move the clock to `t` ms and run the frame the loop asked for. */
    frameAt(t: number) {
      clock = t;
      const due = [...frames.values()];
      frames.clear();
      for (const cb of due) cb(t);
    },
    /** A frame is waiting: the loop is still running. */
    looping: () => frames.size > 0
  };
}

function setVideo(video: HTMLVideoElement, v: { readyState: number; width: number; height: number }) {
  Object.defineProperty(video, 'readyState', { configurable: true, get: () => v.readyState });
  Object.defineProperty(video, 'videoWidth', { configurable: true, get: () => v.width });
  Object.defineProperty(video, 'videoHeight', { configurable: true, get: () => v.height });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.set(nextFrame, cb);
    return nextFrame++;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => ctx as unknown as CanvasRenderingContext2D
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // Put back the decoder a test may have made unloadable.
  vi.doMock('jsqr', decoder);
});

describe('starting the camera', () => {
  it('says so when there is no camera to ask for, and leaves the sheet up', async () => {
    const t = await boot();
    installCamera(false);
    await t.start();
    expect(t.toast()).toBe('No camera access in this app');
    expect(t.hidePanel).not.toHaveBeenCalled();
    expect(t.scanning()).toBe(false);
  });

  it('says to allow it when the camera is refused', async () => {
    const t = await boot();
    camera.answer = 'refuse';
    await t.start();
    expect(t.toast()).toBe('Camera blocked — allow it for this site in Settings');
    expect(t.hidePanel).not.toHaveBeenCalled();
    expect(t.scanning()).toBe(false);
    expect(t.looping()).toBe(false);
  });

  it('says to get online once when the decoder cannot be fetched', async () => {
    vi.doMock('jsqr', () => {
      throw new Error('Failed to fetch dynamically imported module');
    });
    const t = await boot();
    await t.start();
    expect(t.toast()).toBe('Could not load the scanner — connect to the internet once and retry');
    // Not even asked: no camera light for a scan that cannot work.
    expect(camera.asked).toEqual([]);
  });

  it('asks for the rear camera at high resolution', async () => {
    const t = await boot();
    await t.start();
    expect(camera.asked).toEqual([
      { video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } } }
    ]);
  });

  it('puts the sheet away and shows the camera full screen', async () => {
    const t = await boot();
    await t.start();
    expect(t.hidePanel).toHaveBeenCalledOnce();
    expect(t.video.srcObject).toBe(camera.stream);
    expect(t.play).toHaveBeenCalledOnce();
    expect(t.scanning()).toBe(true);
    expect(t.looping()).toBe(true);
  });

  it('carries on when the video will not report that it is playing', async () => {
    const t = await boot();
    t.play.mockRejectedValueOnce(new DOMException('no', 'NotAllowedError'));
    await t.start();
    expect(t.scanning()).toBe(true);
  });

  it('lets the camera go again if it has nothing to draw frames on', async () => {
    const t = await boot();
    ctx = null;
    await t.start();
    expect(camera.tracks[0].stopped).toBe(true);
    expect(t.scanning()).toBe(false);
    expect(t.looping()).toBe(false);
  });
});

describe('the frame loop', () => {
  it('decodes the first frame at once, then at most every 120 ms, however often frames come', async () => {
    const t = await boot();
    await t.start();
    t.frameAt(1000);
    expect(t.jsQR).toHaveBeenCalledTimes(1);
    for (const at of [1016, 1050, 1119]) t.frameAt(at);
    expect(t.jsQR).toHaveBeenCalledTimes(1);
    t.frameAt(1120);
    expect(t.jsQR).toHaveBeenCalledTimes(2);
    for (const at of [1136, 1200, 1239]) t.frameAt(at);
    expect(t.jsQR).toHaveBeenCalledTimes(2);
    t.frameAt(1240);
    expect(t.jsQR).toHaveBeenCalledTimes(3);
  });

  it('waits for the camera to have a frame worth reading', async () => {
    const t = await boot();
    await t.start();
    setVideo(t.video, { readyState: 2, width: 1920, height: 1080 });
    t.frameAt(1200);
    setVideo(t.video, { readyState: 4, width: 0, height: 0 });
    t.frameAt(1400);
    expect(t.jsQR).not.toHaveBeenCalled();
    expect(t.looping()).toBe(true);

    setVideo(t.video, { readyState: 4, width: 1920, height: 1080 });
    t.frameAt(1600);
    expect(t.jsQR).toHaveBeenCalledOnce();
  });

  it('reads the square in the middle of the frame, capped at 1024 px', async () => {
    const t = await boot();
    await t.start();
    t.frameAt(1200);
    // 1080p: the middle 1080 × 1080, scaled down to 1024.
    expect(draws[0]).toEqual([t.video, 420, 0, 1080, 1080, 0, 0, 1024, 1024]);
    expect(t.jsQR).toHaveBeenLastCalledWith(expect.any(Uint8ClampedArray), 1024, 1024, { inversionAttempts: 'dontInvert' });
    expect(t.jsQR.mock.calls[0][0]).toHaveLength(1024 * 1024 * 4);
  });

  it('reads a small portrait frame at its own size', async () => {
    const t = await boot();
    await t.start();
    setVideo(t.video, { readyState: 4, width: 480, height: 640 });
    t.frameAt(1200);
    expect(draws[0]).toEqual([t.video, 0, 80, 480, 480, 0, 0, 480, 480]);
    expect(t.jsQR).toHaveBeenLastCalledWith(expect.any(Uint8ClampedArray), 480, 480, expect.anything());
  });

  it('ignores a QR that is not a route, and keeps looking', async () => {
    const t = await boot();
    t.jsQR.mockReturnValue({ data: 'https://example.com/menu' } as ReturnType<typeof t.jsQR>);
    await t.start();
    t.frameAt(1200);
    expect(t.sharing.parseRouteLink).toHaveBeenCalledWith('https://example.com/menu');
    expect(t.sharing.importParsed).not.toHaveBeenCalled();
    expect(t.scanning()).toBe(true);
    expect(t.looping()).toBe(true);
    expect(camera.tracks[0].stopped).toBe(false);
  });

  it('imports the first route it sees, and lets the camera go', async () => {
    const t = await boot();
    const parsed = { name: 'Striding Edge' };
    t.jsQR.mockReturnValue({ data: 'https://trailhead/#r=abc' } as ReturnType<typeof t.jsQR>);
    t.sharing.parseRouteLink.mockReturnValue(parsed as never);
    await t.start();
    t.frameAt(1200);
    expect(t.sharing.importParsed).toHaveBeenCalledWith(parsed);
    expect(camera.tracks[0].stopped).toBe(true);
    expect(t.video.srcObject).toBeNull();
    expect(t.scanning()).toBe(false);
    // The frame the tick asked for before it found the code is called off,
    // so the same QR is not imported twice.
    expect(t.looping()).toBe(false);
    t.frameAt(1400);
    expect(t.sharing.importParsed).toHaveBeenCalledOnce();
  });
});

describe('cancelling', () => {
  it('lets the camera go, stops the loop and puts the scanner away', async () => {
    const t = await boot();
    await t.start();
    t.$('qrCancel').click();
    expect(camera.tracks[0].stopped).toBe(true);
    expect(t.video.srcObject).toBeNull();
    expect(t.looping()).toBe(false);
    expect(t.scanning()).toBe(false);
  });

  it('is safe when nothing is running', async () => {
    const t = await boot();
    expect(() => t.qr.stopQrScan()).not.toThrow();
    expect(t.scanning()).toBe(false);
  });

  it('lets each scan’s own camera go when you scan again', async () => {
    const t = await boot();
    await t.start();
    t.$('qrCancel').click();
    await t.start();
    expect(t.scanning()).toBe(true);
    t.$('qrCancel').click();
    expect(camera.tracks.map((tr) => tr.stopped)).toEqual([true, true]);
    expect(t.looping()).toBe(false);
  });
});
