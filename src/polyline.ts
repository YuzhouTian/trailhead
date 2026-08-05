/** Google encoded-polyline algorithm (used for compact share links). */

export function encodePolyline(points: [number, number][], precision = 5): string {
  const factor = 10 ** precision;
  let out = '';
  let prevLat = 0;
  let prevLng = 0;
  for (const [lat, lng] of points) {
    const iLat = Math.round(lat * factor);
    const iLng = Math.round(lng * factor);
    out += encodeSigned(iLat - prevLat) + encodeSigned(iLng - prevLng);
    prevLat = iLat;
    prevLng = iLng;
  }
  return out;
}

export function decodePolyline(str: string, precision = 5): [number, number][] {
  const factor = 10 ** precision;
  const points: [number, number][] = [];
  let lat = 0;
  let lng = 0;
  let i = 0;
  while (i < str.length) {
    const [dLat, i2] = decodeSigned(str, i);
    const [dLng, i3] = decodeSigned(str, i2);
    lat += dLat;
    lng += dLng;
    points.push([lat / factor, lng / factor]);
    i = i3;
  }
  return points;
}

function encodeSigned(v: number): string {
  let n = v < 0 ? ~(v << 1) : v << 1;
  let out = '';
  while (n >= 0x20) {
    out += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
    n >>= 5;
  }
  return out + String.fromCharCode(n + 63);
}

function decodeSigned(str: string, i: number): [number, number] {
  let result = 0;
  let shift = 0;
  let b: number;
  do {
    b = str.charCodeAt(i++) - 63;
    result |= (b & 0x1f) << shift;
    shift += 5;
  } while (b >= 0x20);
  return [result & 1 ? ~(result >> 1) : result >> 1, i];
}
