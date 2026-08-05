/**
 * Hiking-relevant map keys for each base layer. Swatches are hand-drawn
 * approximations of each style's rendering — close enough to identify
 * features on the map, not pixel-perfect copies.
 */

const sw = (inner: string) =>
  `<svg width="46" height="16" viewBox="0 0 46 16" style="flex:0 0 46px">${inner}</svg>`;

const line = (color: string, width: number, dash = '') =>
  sw(`<line x1="2" y1="8" x2="44" y2="8" stroke="${color}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`);

const row = (swatch: string, label: string) =>
  `<div class="keyRow">${swatch}<span>${label}</span></div>`;

const dot = (color: string) => sw(`<circle cx="23" cy="8" r="3.5" fill="${color}"/>`);

const area = (color: string) => sw(`<rect x="4" y="2" width="38" height="12" fill="${color}"/>`);

const steps = sw(
  `<line x1="2" y1="8" x2="44" y2="8" stroke="#e66e64" stroke-width="4"/>` +
  `<g stroke="#fff" stroke-width="1.5">` +
  ['8', '14', '20', '26', '32', '38'].map((x) => `<line x1="${x}" y1="4" x2="${x}" y2="12"/>`).join('') +
  `</g>`
);

const contours = sw(
  `<g stroke="#c98f5c" fill="none" stroke-width="1">` +
  `<path d="M2 12 C 14 4, 30 14, 44 5"/><path d="M2 15 C 16 8, 30 16, 44 9"/>` +
  `</g><path d="M2 8 C 14 1, 30 11, 44 2" stroke="#b06f3c" stroke-width="1.6" fill="none"/>`
);

const OSM_KEY = `
  ${row(line('#fa8072', 2, '2 3'), 'Footpath / path — walkers')}
  ${row(line('#3d9b3d', 2, '5 3'), 'Bridleway — walkers + horses')}
  ${row(line('#5b7cfa', 2, '5 3'), 'Cycleway')}
  ${row(line('#996600', 2, '7 4'), 'Track (farm/forest; sparser dashes = rougher)')}
  ${row(steps, 'Steps')}
  ${row(line('#9e9e9e', 1), 'Fence')}
  ${row(line('#5a5a5a', 2), 'Wall')}
  ${row(dot('#666'), 'Gate / kissing gate / stile — tiny grey symbols sitting on the path where it crosses a barrier. Only drawn when zoomed right in (~z17+), so zoom in to check a crossing.')}
  ${row(sw('<path d="M17 13 L23 3 L29 13 Z" fill="#a0522d"/>'), 'Peak (with name and height)')}
  ${row(area('#cde8c0'), 'Woodland')}
  <p class="hint">OpenStreetMap is the best layer for gates and stiles — surveyors map them as points on the path. If a gate is missing here, it is missing from the routing data too, which is when the 🧲 freeform toggle helps.</p>`;

const OTM_KEY = `
  ${row(line('#333', 2, '1 3'), 'Footpath / path')}
  ${row(line('#333', 2, '6 3'), 'Track')}
  ${row(contours, 'Contour lines (thicker = labelled major line)')}
  ${row(sw('<g stroke="#777" stroke-width="1.4">' + ['6','12','18','24','30','36'].map((x) => `<line x1="${x}" y1="3" x2="${Number(x)+4}" y2="13"/>`).join('') + '</g>'), 'Crag / rock face')}
  ${row(area('#cbe5b8'), 'Forest')}
  ${row(sw('<path d="M17 13 L23 3 L29 13 Z" fill="#555"/>'), 'Summit with elevation')}
  ${row(dot('#3d6fd0'), 'Spring / water feature')}
  <p class="hint">OpenTopoMap adds contours and terrain to OSM data, but shows fewer small features (gates, stiles) than the OSM layer.</p>`;

const OS_KEY = `
  ${row(line('#2e8b57', 2, '3 3'), 'Public footpath (right of way, England &amp; Wales)')}
  ${row(line('#2e8b57', 2, '8 4'), 'Public bridleway')}
  ${row(sw('<g fill="#2e8b57">' + ['6','16','26','36'].map((x) => `<path d="M${x} 8 l4 -4 l4 4 l-4 4 Z"/>`).join('') + '</g>'), 'National Trail / long-distance route')}
  ${row(contours, 'Contour lines (orange-brown, labelled)')}
  ${row(line('#e8b600', 4), 'Minor road')}
  ${row(area('#d5ecc9'), 'Woodland')}
  <p class="hint">Rights of way on OS maps are the legal record but don't always match the ground. OS doesn't mark individual gates/stiles at these scales — switch to the OSM layer to check a crossing.</p>`;

const KEYS: Record<string, { title: string; html: string }> = {
  osm: { title: 'OpenStreetMap', html: OSM_KEY },
  otm: { title: 'OpenTopoMap', html: OTM_KEY },
  'os-outdoor': { title: 'OS Outdoor', html: OS_KEY },
  'os-light': { title: 'OS Light', html: OS_KEY }
};

export function legendHtml(layerId: string): string {
  const key = KEYS[layerId] ?? KEYS.osm;
  return `
    <h3>Map key — ${key.title}</h3>
    <p class="hint">Approximate: map styles evolve over time.</p>
    ${key.html}`;
}
