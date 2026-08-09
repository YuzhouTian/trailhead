import { formatDistance, haversine, type LatLng } from './geo';

/**
 * Look up the ground elevation (metres) at a point via Open-Meteo's free,
 * keyless elevation API. Returns null on any failure — offline, rate-limited,
 * or a malformed response — so callers can quietly drop the figure.
 */
export async function fetchElevation(
  lat: number,
  lng: number,
  signal?: AbortSignal
): Promise<number | null> {
  try {
    const r = await fetch(
      `https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lng}`,
      { signal }
    );
    if (!r.ok) return null;
    const j = (await r.json()) as { elevation?: number[] };
    const e = j.elevation?.[0];
    return typeof e === 'number' && Number.isFinite(e) ? e : null;
  } catch {
    return null;
  }
}

/**
 * Render a distance-vs-elevation profile into the container as SVG,
 * with a touch/mouse scrubber. `onScrub` fires with the map position
 * under the scrubber (null when scrubbing ends). Returns false if the
 * route has no elevation data to draw.
 *
 * `positionM` is how far along the route the walker currently is, in metres —
 * drawn as a "you are here" marker so the profile answers what is still to
 * climb, not just the shape of the whole walk. Pass null when the position
 * isn't known or isn't trusted.
 */
export function renderProfile(
  container: HTMLElement,
  coords: LatLng[],
  onScrub?: (pos: LatLng | null) => void,
  positionM?: number | null
): boolean {
  const pts: { d: number; e: number; lat: number; lng: number }[] = [];
  let dist = 0;
  let prev: LatLng | null = null;
  for (const c of coords) {
    if (prev) dist += haversine(prev, c);
    prev = c;
    if (typeof c[2] === 'number') pts.push({ d: dist, e: c[2], lat: c[0], lng: c[1] });
  }
  if (pts.length < 2 || dist <= 0) {
    container.innerHTML = '';
    return false;
  }

  let minE = Infinity;
  let maxE = -Infinity;
  for (const p of pts) {
    if (p.e < minE) minE = p.e;
    if (p.e > maxE) maxE = p.e;
  }
  const span = Math.max(maxE - minE, 20);

  const W = Math.max(container.clientWidth || 360, 280);
  const H = 110;
  const padL = 38;
  const padR = 10;
  const padT = 10;
  const padB = 18;
  const x = (d: number) => padL + (d / dist) * (W - padL - padR);
  const y = (e: number) => padT + (1 - (e - minE) / span) * (H - padT - padB);

  const linePts = pts.map((p) => `${x(p.d).toFixed(1)},${y(p.e).toFixed(1)}`).join(' ');
  const midE = Math.round((minE + maxE) / 2);

  // "You are here" — blue to match the GPS dot on the map, so the two read as
  // the same thing shown two ways. Sits under the scrubber, which is red.
  let hereMarkup = '';
  if (typeof positionM === 'number' && positionM >= 0 && positionM <= dist) {
    let here = pts[0];
    for (const p of pts) {
      if (Math.abs(p.d - positionM) < Math.abs(here.d - positionM)) here = p;
    }
    const hx = x(here.d).toFixed(1);
    hereMarkup =
      `<line x1="${hx}" y1="${padT}" x2="${hx}" y2="${H - padB}" stroke="#1a73e8" stroke-width="1" stroke-dasharray="3 3"/>` +
      `<circle cx="${hx}" cy="${y(here.e).toFixed(1)}" r="5" fill="#1a73e8" stroke="#fff" stroke-width="2"/>`;
  }

  container.innerHTML = `
    <svg width="${W}" height="${H}" style="display:block">
      <line x1="${padL}" y1="${y(maxE)}" x2="${W - padR}" y2="${y(maxE)}" stroke="#eee"/>
      <line x1="${padL}" y1="${y(midE)}" x2="${W - padR}" y2="${y(midE)}" stroke="#eee"/>
      <line x1="${padL}" y1="${y(minE)}" x2="${W - padR}" y2="${y(minE)}" stroke="#ddd"/>
      <text x="${padL - 4}" y="${y(maxE) + 4}" text-anchor="end" font-size="11" fill="#888">${Math.round(maxE)}</text>
      <text x="${padL - 4}" y="${y(midE) + 4}" text-anchor="end" font-size="11" fill="#888">${midE}</text>
      <text x="${padL - 4}" y="${y(minE) + 4}" text-anchor="end" font-size="11" fill="#888">${Math.round(minE)}</text>
      <text x="${W - padR}" y="${H - 4}" text-anchor="end" font-size="11" fill="#888">${formatDistance(dist)}</text>
      <polygon points="${padL},${y(minE)} ${linePts} ${x(dist).toFixed(1)},${y(minE)}" fill="#2d6a4f22"/>
      <polyline points="${linePts}" fill="none" stroke="#2d6a4f" stroke-width="2"/>
      ${hereMarkup}
      <g class="scrub" style="display:none">
        <line y1="${padT}" y2="${H - padB}" stroke="#c1121f" stroke-width="1"/>
        <circle r="4" fill="#c1121f"/>
        <text y="${padT + 2}" font-size="13" font-weight="600" fill="#c1121f"></text>
      </g>
    </svg>`;

  const svg = container.querySelector('svg')!;
  const scrub = svg.querySelector<SVGGElement>('.scrub')!;
  const [vline, dot, label] = [
    scrub.querySelector('line')!,
    scrub.querySelector('circle')!,
    scrub.querySelector('text')!
  ];
  const onMove = (clientX: number) => {
    const rect = svg.getBoundingClientRect();
    const d = Math.max(0, Math.min(dist, ((clientX - rect.left - padL) / (W - padL - padR)) * dist));
    let best = pts[0];
    for (const p of pts) if (Math.abs(p.d - d) < Math.abs(best.d - d)) best = p;
    scrub.style.display = '';
    vline.setAttribute('x1', String(x(best.d)));
    vline.setAttribute('x2', String(x(best.d)));
    dot.setAttribute('cx', String(x(best.d)));
    dot.setAttribute('cy', String(y(best.e)));
    label.textContent = `${(best.d / 1000).toFixed(1)} km · ${Math.round(best.e)} m`;
    const flip = x(best.d) > W - 110;
    label.setAttribute('x', String(x(best.d) + (flip ? -6 : 6)));
    label.setAttribute('text-anchor', flip ? 'end' : 'start');
    onScrub?.([best.lat, best.lng, best.e]);
  };
  const endScrub = () => {
    scrub.style.display = 'none';
    onScrub?.(null);
  };
  svg.addEventListener('mousemove', (e) => onMove(e.clientX));
  svg.addEventListener('touchstart', (e) => onMove(e.touches[0].clientX), { passive: true });
  svg.addEventListener('touchmove', (e) => {
    onMove(e.touches[0].clientX);
    e.preventDefault();
  }, { passive: false });
  svg.addEventListener('mouseleave', endScrub);
  svg.addEventListener('touchend', endScrub);
  svg.addEventListener('touchcancel', endScrub);
  return true;
}
