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

/** Where the scrubber sits: the point on the route, and how far along it is. */
export interface Scrub {
  pos: LatLng;
  alongM: number;
}

/**
 * What outlives a single drawing of a chart: whether a finger is down, how to
 * scrub and mark the SVG that is currently on screen, and what that SVG was
 * drawn for. Keyed by the container because that is the one element that lives
 * longer than a render.
 */
interface LiveChart {
  dragging: boolean;
  scrubAt: (clientX: number) => void;
  /** Move the "you are here" mark; null takes it away. */
  setHere: (positionM: number | null) => void;
  /** The SVG last drawn here, and the route and width it was drawn for. */
  svg: SVGSVGElement | null;
  coords: LatLng[] | null;
  width: number;
}
const charts = new WeakMap<HTMLElement, LiveChart>();

/** The width a profile is drawn at in this container. */
const chartWidth = (container: HTMLElement): number => Math.max(container.clientWidth || 360, 280);

/**
 * The sample nearest `d` metres along. Samples are in order of distance, so
 * this halves its way there rather than looking at every one: it runs on every
 * GPS fix and on every pointer move of a scrub. Ties go to the earlier sample.
 */
function nearestSample<T extends { d: number }>(pts: T[], d: number): T {
  let lo = 0;
  let hi = pts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].d < d) lo = mid + 1;
    else hi = mid;
  }
  // lo is the first sample at or past d; the one before it may be nearer.
  // Several samples can share a distance (a zero-length step), and the first
  // of them is the one to keep.
  let i = lo;
  if (i > 0 && Math.abs(pts[i - 1].d - d) <= Math.abs(pts[i].d - d)) i--;
  while (i > 0 && pts[i - 1].d === pts[i].d) i--;
  return pts[i];
}

/**
 * Move the "you are here" mark on the profile already drawn in `container`,
 * without drawing it again. Returns false when there is no such profile to
 * move it on — nothing drawn there, a different route, a container that has
 * changed width since, or a chart someone has since cleared or written over —
 * and the caller draws afresh with renderProfile.
 *
 * This is what a GPS fix calls. Redrawing the profile on every fix meant
 * measuring the whole route, writing thousands of points into a new SVG and
 * laying it out, once a second, to move one line.
 */
export function moveHere(container: HTMLElement, coords: LatLng[], positionM: number | null): boolean {
  const live = charts.get(container);
  if (
    !live ||
    live.svg?.parentNode !== container ||
    live.coords !== coords ||
    live.width !== chartWidth(container)
  ) {
    return false;
  }
  live.setHere(positionM);
  return true;
}

/**
 * Render a distance-vs-elevation profile into the container as SVG, with a
 * scrubber that follows a hovering mouse and a pressed finger. `onScrub` fires
 * with the point under the scrubber whenever it moves, and with null when there
 * is nothing to mark. Returns false if the route has no elevation data to draw.
 *
 * The scrubber deliberately stays put when the finger (or the mouse) leaves:
 * the whole point of putting it on the chart is to look at the map afterwards.
 * It is the caller that owns where it sits, by remembering the last `onScrub`
 * and handing it back as `scrubM` — without that a redraw (a new width, the
 * chart closed and opened again) would silently wipe it.
 *
 * `positionM` is how far along the route the walker currently is, in metres —
 * drawn as a "you are here" marker so the profile answers what is still to
 * climb, not just the shape of the whole walk. Pass null when the position
 * isn't known or isn't trusted. As you walk, move it with moveHere rather than
 * drawing the profile again.
 */
export function renderProfile(
  container: HTMLElement,
  coords: LatLng[],
  onScrub?: (scrub: Scrub | null) => void,
  positionM?: number | null,
  scrubM?: number | null
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

  const W = chartWidth(container);
  const H = 120;
  const padL = 38;
  const padR = 10;
  const padT = 10;
  const padB = 18;
  const x = (d: number) => padL + (d / dist) * (W - padL - padR);
  const y = (e: number) => padT + (1 - (e - minE) / span) * (H - padT - padB);

  const linePts = pts.map((p) => `${x(p.d).toFixed(1)},${y(p.e).toFixed(1)}`).join(' ');
  const midE = Math.round((minE + maxE) / 2);

  // Everything but the "you are here" dot is drawn from theme tokens rather
  // than fixed greys and greens. The chart lives inside the app's own DOM, so
  // `var(--…)` resolves here exactly as it does in the stylesheet — and it has
  // to: the old literal #eee gridlines were near-white lines on a dark card.
  const labelStyle = 'font-size:12px;font-variant-numeric:tabular-nums';
  container.innerHTML = `
    <svg width="${W}" height="${H}" style="display:block">
      <defs>
        <linearGradient id="elevFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="var(--brand)" stop-opacity=".22"/>
          <stop offset="1" stop-color="var(--brand)" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <line x1="${padL}" y1="${y(maxE)}" x2="${W - padR}" y2="${y(maxE)}" stroke="var(--hairline)"/>
      <line x1="${padL}" y1="${y(midE)}" x2="${W - padR}" y2="${y(midE)}" stroke="var(--hairline)"/>
      <line x1="${padL}" y1="${y(minE)}" x2="${W - padR}" y2="${y(minE)}" stroke="var(--hairline)"/>
      <text x="${padL - 4}" y="${y(maxE) + 4}" text-anchor="end" style="${labelStyle}" fill="var(--muted)">${Math.round(maxE)}</text>
      <text x="${padL - 4}" y="${y(midE) + 4}" text-anchor="end" style="${labelStyle}" fill="var(--muted)">${midE}</text>
      <text x="${padL - 4}" y="${y(minE) + 4}" text-anchor="end" style="${labelStyle}" fill="var(--muted)">${Math.round(minE)}</text>
      <text x="${W - padR}" y="${H - 4}" text-anchor="end" style="${labelStyle}" fill="var(--muted)">${formatDistance(dist)}</text>
      <polygon points="${padL},${y(minE)} ${linePts} ${x(dist).toFixed(1)},${y(minE)}" fill="url(#elevFill)"/>
      <polyline points="${linePts}" fill="none" stroke="var(--brand)" stroke-width="2"/>
      <g class="here" style="display:none">
        <line y1="${padT}" y2="${H - padB}" stroke="#1a73e8" stroke-width="1" stroke-dasharray="3 3"/>
        <circle r="5" fill="#1a73e8" stroke="#fff" stroke-width="2"/>
      </g>
      <g class="scrub" style="display:none">
        <line y1="${padT}" y2="${H - padB}" stroke="var(--danger)" stroke-width="1"/>
        <circle r="4" fill="var(--danger)"/>
        <text y="${padT + 2}" style="${labelStyle};font-weight:700" fill="var(--danger)"></text>
      </g>
    </svg>`;

  const svg = container.querySelector('svg')!;

  // "You are here" — blue to match the GPS dot on the map, so the two read as
  // the same thing shown two ways. Sits under the scrubber, which is red. Drawn
  // hidden and then placed, because it is the one part of the chart that moves
  // as you walk (see moveHere).
  const hereMark = svg.querySelector<SVGGElement>('.here')!;
  const [hereLine, hereDot] = [hereMark.querySelector('line')!, hereMark.querySelector('circle')!];
  const setHere = (m: number | null): void => {
    if (typeof m !== 'number' || m < 0 || m > dist) {
      hereMark.style.display = 'none';
      return;
    }
    const here = nearestSample(pts, m);
    const hx = x(here.d).toFixed(1);
    hereLine.setAttribute('x1', hx);
    hereLine.setAttribute('x2', hx);
    hereDot.setAttribute('cx', hx);
    hereDot.setAttribute('cy', y(here.e).toFixed(1));
    hereMark.style.display = '';
  };
  setHere(positionM ?? null);

  const scrub = svg.querySelector<SVGGElement>('.scrub')!;
  const [vline, dot, label] = [
    scrub.querySelector('line')!,
    scrub.querySelector('circle')!,
    scrub.querySelector('text')!
  ];
  /** Draw the scrubber at the sampled point nearest `d` metres along. */
  const place = (d: number): Scrub => {
    const best = nearestSample(pts, d);
    scrub.style.display = '';
    vline.setAttribute('x1', String(x(best.d)));
    vline.setAttribute('x2', String(x(best.d)));
    dot.setAttribute('cx', String(x(best.d)));
    dot.setAttribute('cy', String(y(best.e)));
    label.textContent = `${(best.d / 1000).toFixed(1)} km · ${Math.round(best.e)} m`;
    const flip = x(best.d) > W - 110;
    label.setAttribute('x', String(x(best.d) + (flip ? -6 : 6)));
    label.setAttribute('text-anchor', flip ? 'end' : 'start');
    return { pos: [best.lat, best.lng, best.e], alongM: best.d };
  };

  // Restore the scrubber this profile was last left with. A route can change
  // length underneath a saved position (an edited plan, a different walk), so
  // anything now off the end is reported as gone rather than clamped to a
  // point the reader never picked.
  if (typeof scrubM === 'number') {
    onScrub?.(scrubM >= 0 && scrubM <= dist ? place(scrubM) : null);
  }

  // One pointer handler for both input kinds, split on pointerType rather than
  // on screen size — a touchscreen laptop gets hover from its mouse and drag
  // from its finger, in the same session. A mouse has a position over the chart
  // whether or not a button is down, so it scrubs on plain movement; a finger
  // has no position until it touches, so it scrubs from press to release.
  // Capture keeps a finger's drag alive when it strays off the small chart, and
  // #elevChart sets touch-action: none so a horizontal drag scrubs instead of
  // scrolling the card.
  //
  // A hover is a real scrub, not a preview: the marker stays where the mouse
  // last was, exactly as it stays where a finger lifted, so `onScrub` keeps its
  // single meaning and the caller persists a hovered position like any other.
  //
  // The drag itself has to outlive this SVG. The profile is drawn from scratch
  // whenever its width or its route changes — and, until the "you are here"
  // mark learned to move in place (moveHere), on every GPS fix — and a finger
  // that is mid-drag when that happens is still down. So the "is a finger pressed" flag and the
  // current chart's drawing functions live on the container, which survives,
  // not in this closure, which does not. Two things then work that otherwise
  // break: the fresh SVG's handlers see the drag is still on, and the handlers
  // of an SVG that has just been thrown away — which iOS keeps sending the
  // touch's events to, because WebKit targets a touch at the element it began
  // on — draw on the chart that is actually on screen instead of reading a
  // position off a box that no longer exists. The latter was the iPhone bug
  // where a drag snapped the marker to the end of the route within a second.
  const distanceAt = (clientX: number): number => {
    const rect = svg.getBoundingClientRect();
    const inner = Math.max(rect.width - padL - padR, 1);
    return Math.max(0, Math.min(dist, ((clientX - rect.left - padL) / inner) * dist));
  };
  const live: LiveChart = charts.get(container) ?? {
    dragging: false,
    scrubAt: () => undefined,
    setHere: () => undefined,
    svg: null,
    coords: null,
    width: 0
  };
  live.scrubAt = (clientX) => onScrub?.(place(distanceAt(clientX)));
  live.setHere = setHere;
  live.svg = svg;
  live.coords = coords;
  live.width = W;
  charts.set(container, live);

  svg.addEventListener('pointerdown', (e) => {
    live.dragging = true;
    // Capture is a nicety — without it a drag that wanders off the chart just
    // stops — so environments that lack it degrade rather than throw.
    svg.setPointerCapture?.(e.pointerId);
    live.scrubAt(e.clientX);
    e.preventDefault();
  });
  svg.addEventListener('pointermove', (e) => {
    if (live.dragging || e.pointerType === 'mouse') live.scrubAt(e.clientX);
  });
  const endDrag = (e: PointerEvent) => {
    // The scrubber stays where it was dropped; only the drag ends.
    live.dragging = false;
    if (svg.hasPointerCapture?.(e.pointerId)) svg.releasePointerCapture(e.pointerId);
  };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);
  return true;
}
