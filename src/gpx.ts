import type { LatLng } from './geo';

export interface GpxData {
  name: string;
  coords: LatLng[];
}

/** Parse a GPX file. Reads track points, falling back to route points, then waypoints. */
export function parseGpx(text: string, fallbackName: string): GpxData {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('Not a valid GPX file');
  }

  const readPoints = (selector: string): LatLng[] =>
    Array.from(doc.querySelectorAll(selector)).map((el) => [
      parseFloat(el.getAttribute('lat') ?? ''),
      parseFloat(el.getAttribute('lon') ?? '')
    ] as LatLng).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));

  let coords = readPoints('trkpt');
  if (coords.length === 0) coords = readPoints('rtept');
  if (coords.length === 0) coords = readPoints('wpt');
  if (coords.length === 0) throw new Error('No track points found in GPX');

  const name =
    doc.querySelector('trk > name, rte > name, metadata > name')?.textContent?.trim() ||
    fallbackName;

  return { name, coords };
}

export function toGpx(name: string, coords: LatLng[]): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const pts = coords
    .map(([lat, lng]) => `      <trkpt lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}"/>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Trailhead" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${esc(name)}</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>
`;
}
