// Reading a route QR off another screen with the camera. A separate file from
// sharing because it is a different job with different failure modes — camera
// permissions, a lazily fetched decoder, a per-frame decode loop — and because
// the decoder is a chunk of its own that most people never download.
//
// It knows only enough about sharing to recognise a route link; what a link
// means is sharing's business, so a find is handed straight to importParsed().

import { importParsed, parseRouteLink } from './sharing';
import { $, toast } from '../ui/dom';

// Decode a centred square crop at full resolution (the QR sits in the middle
// reticle), capped so a big frame doesn't stall the decode loop. This spends
// the sensor's pixels where the code actually is.
const DECODE_MAX = 1024;
// A QR code doesn't change between frames, so decoding at the full 60fps
// rAF rate is wasted CPU/battery for a getImageData readback this size.
const DECODE_INTERVAL_MS = 120;

let qrStream: MediaStream | null = null;
let qrRAF: number | null = null;
let hidePanel: () => void;

export function stopQrScan(): void {
  if (qrRAF !== null) cancelAnimationFrame(qrRAF);
  qrRAF = null;
  qrStream?.getTracks().forEach((t) => t.stop());
  qrStream = null;
  ($('qrVideo') as HTMLVideoElement).srcObject = null;
  $('qrScan').classList.add('hidden');
}

/** Open the camera and watch for a Trailhead route QR, importing the first one
 *  seen. Other QR codes are ignored so it keeps looking. */
export async function startQrScan(): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) {
    return toast('No camera access in this app', 4000);
  }
  const video = $('qrVideo') as HTMLVideoElement;
  // The decoder is a chunk of its own, fetched only the first time you scan, so
  // it never weighs down the app for people who don't. Cached after first use.
  let jsQR: typeof import('jsqr').default;
  try {
    jsQR = (await import('jsqr')).default;
  } catch {
    return toast('Could not load the scanner — connect to the internet once and retry', 5000);
  }
  try {
    // Ask for a high-resolution rear stream — the default is often 640×480,
    // too coarse to resolve a QR across the room on a monitor. `ideal` degrades
    // gracefully on cameras that can't hit it.
    qrStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'environment',
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      }
    });
  } catch {
    return toast('Camera blocked — allow it for this site in Settings', 5000);
  }
  hidePanel();
  video.srcObject = qrStream;
  await video.play().catch(() => {});
  $('qrScan').classList.remove('hidden');

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return stopQrScan();

  let lastDecode = 0;
  const tick = () => {
    qrRAF = requestAnimationFrame(tick);
    const now = performance.now();
    if (now - lastDecode < DECODE_INTERVAL_MS) return;
    lastDecode = now;
    if (video.readyState !== video.HAVE_ENOUGH_DATA) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;
    const side = Math.min(vw, vh);
    const dim = Math.min(side, DECODE_MAX);
    canvas.width = dim;
    canvas.height = dim;
    ctx.drawImage(video, (vw - side) / 2, (vh - side) / 2, side, side, 0, 0, dim, dim);
    const img = ctx.getImageData(0, 0, dim, dim);
    const code = jsQR(img.data, dim, dim, { inversionAttempts: 'dontInvert' });
    if (!code) return;
    const parsed = parseRouteLink(code.data);
    if (!parsed) return; // some other QR, ignore and keep looking
    stopQrScan();
    void importParsed(parsed);
  };
  qrRAF = requestAnimationFrame(tick);
}

/** Wire up the scanner's cancel button. */
export function initQr(opts: { hidePanel: () => void }): void {
  hidePanel = opts.hidePanel;
  $('qrCancel').addEventListener('click', stopQrScan);
}
