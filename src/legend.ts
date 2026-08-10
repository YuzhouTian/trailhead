/**
 * Hiking map keys, one per base layer, grouped by the question a walker is
 * actually asking: can I walk it, can I get through, what's the ground like,
 * where's the water, what am I looking at.
 *
 * Swatches are hand-drawn approximations of each style's rendering — close
 * enough to recognise a feature on the map, not pixel-perfect copies. Where a
 * layer genuinely cannot answer something (OSM has no rights of way, OS has no
 * gates) the group says so, because knowing what a map *doesn't* show matters
 * as much as knowing what it does.
 */

import { poiCategories } from './poi';

// ---------------------------------------------------------------- swatches

const sw = (inner: string) =>
  `<svg width="46" height="18" viewBox="0 0 46 18" style="flex:0 0 46px">${inner}</svg>`;

/** A plain or dashed line, optionally with a contrasting casing beneath. */
const line = (color: string, width: number, dash = '', casing = ''): string =>
  sw(
    (casing ? `<line x1="2" y1="9" x2="44" y2="9" stroke="${casing}" stroke-width="${width + 3}"/>` : '') +
      `<line x1="2" y1="9" x2="44" y2="9" stroke="${color}" stroke-width="${width}"${
        dash ? ` stroke-dasharray="${dash}"` : ''
      } stroke-linecap="butt"/>`
  );

/** Line with regular cross-rungs: steps, and railway-style symbols. */
const rungs = (color: string, width: number, rungColor = '#fff'): string =>
  sw(
    `<line x1="2" y1="9" x2="44" y2="9" stroke="${color}" stroke-width="${width}"/>` +
      `<g stroke="${rungColor}" stroke-width="1.5">` +
      [8, 14, 20, 26, 32, 38].map((x) => `<line x1="${x}" y1="4" x2="${x}" y2="14"/>`).join('') +
      `</g>`
  );

/** Fence: thin line with short uprights. */
const fence = sw(
  `<line x1="2" y1="9" x2="44" y2="9" stroke="#9e9e9e" stroke-width="1"/>` +
    `<g stroke="#9e9e9e" stroke-width="1">` +
    [6, 13, 20, 27, 34, 41].map((x) => `<line x1="${x}" y1="5" x2="${x}" y2="9"/>`).join('') +
    `</g>`
);

/** Cliff / crag: a line with downslope ticks. */
const cliff = (color = '#666') =>
  sw(
    `<line x1="2" y1="7" x2="44" y2="7" stroke="${color}" stroke-width="1.6"/>` +
      `<g stroke="${color}" stroke-width="1.2">` +
      [5, 11, 17, 23, 29, 35, 41].map((x) => `<line x1="${x}" y1="7" x2="${x}" y2="14"/>`).join('') +
      `</g>`
  );

/** Scree / bare rock stipple. */
const stipple = (color = '#8d8d8d') =>
  sw(
    `<g fill="${color}">` +
      [
        [7, 5], [14, 11], [21, 4], [28, 12], [35, 6], [41, 12],
        [10, 14], [18, 7], [25, 14], [32, 4], [38, 9]
      ]
        .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.3"/>`)
        .join('') +
      `</g>`
  );

/** Marsh / bog: water line with reed tufts. */
const marsh = sw(
  `<rect x="3" y="2" width="40" height="14" fill="#e3eef0"/>` +
    `<g stroke="#4a90a4" stroke-width="1.2">` +
    [8, 18, 28, 38]
      .map(
        (x) =>
          `<line x1="${x}" y1="13" x2="${x}" y2="6"/><line x1="${x - 3}" y1="13" x2="${x - 3}" y2="8"/><line x1="${x + 3}" y1="13" x2="${x + 3}" y2="8"/>`
      )
      .join('') +
    `</g>` +
    `<line x1="3" y1="14" x2="43" y2="14" stroke="#4a90a4" stroke-width="1"/>`
);

/** Contour lines, with a heavier index line. */
const contours = (thin: string, index: string) =>
  sw(
    `<g stroke="${thin}" fill="none" stroke-width="1">` +
      `<path d="M2 13 C 14 5, 30 15, 44 6"/><path d="M2 17 C 16 9, 30 17, 44 10"/>` +
      `</g><path d="M2 8 C 14 1, 30 11, 44 2" stroke="${index}" stroke-width="1.8" fill="none"/>`
  );

/** Flat colour area, optionally with a repeating glyph over it. */
const area = (fill: string, glyphs = ''): string =>
  sw(`<rect x="3" y="2" width="40" height="14" fill="${fill}"/>${glyphs}`);

const trees = (color: string) =>
  area(
    '#c8e0b4',
    `<g fill="${color}">` +
      [9, 20, 31, 39]
        .map((x) => `<circle cx="${x}" cy="8" r="2.6"/><rect x="${x - 0.5}" y="9" width="1" height="4"/>`)
        .join('') +
      `</g>`
  );

const conifers = (color: string) =>
  area(
    '#b9d9a5',
    `<g fill="${color}">` +
      [9, 20, 31, 39].map((x) => `<path d="M${x} 3 l3.4 8 h-6.8 Z"/>`).join('') +
      `</g>`
  );

/** Diagonal hatching, for access land and danger areas. */
const hatch = (fill: string, stroke: string) =>
  sw(
    `<rect x="3" y="2" width="40" height="14" fill="${fill}"/>` +
      `<g stroke="${stroke}" stroke-width="1.2">` +
      [0, 8, 16, 24, 32, 40].map((x) => `<line x1="${x + 3}" y1="16" x2="${x + 13}" y2="2"/>`).join('') +
      `</g>`
  );

/** A point symbol drawn as a small glyph, optionally on a coloured chip. */
const symbol = (inner: string, chip = '') =>
  sw((chip ? `<rect x="16" y="2" width="14" height="14" rx="2" fill="${chip}"/>` : '') + inner);

const dot = (color: string, r = 3.5) => sw(`<circle cx="23" cy="9" r="${r}" fill="${color}"/>`);

const peak = (color: string) => symbol(`<path d="M17 14 L23 3 L29 14 Z" fill="${color}"/>`);

const trig = (color: string) =>
  symbol(`<path d="M17 14 L23 4 L29 14 Z" fill="none" stroke="${color}" stroke-width="1.8"/>`);

const letterChip = (ch: string, bg: string, fg = '#fff') =>
  symbol(
    `<text x="23" y="13" text-anchor="middle" font-size="11" font-weight="700" fill="${fg}">${ch}</text>`,
    bg
  );

const ford = sw(
  `<line x1="2" y1="9" x2="44" y2="9" stroke="#b8a06a" stroke-width="3"/>` +
    `<g stroke="#5aa0c8" stroke-width="1.6">` +
    [17, 21, 25, 29].map((x) => `<line x1="${x}" y1="3" x2="${x}" y2="15"/>`).join('') +
    `</g>`
);

const bridge = sw(
  `<line x1="2" y1="9" x2="44" y2="9" stroke="#7fb8d4" stroke-width="5"/>` +
    `<line x1="14" y1="9" x2="32" y2="9" stroke="#e8e2d8" stroke-width="4"/>` +
    `<g stroke="#333" stroke-width="1.2"><line x1="14" y1="4" x2="14" y2="14"/><line x1="32" y1="4" x2="32" y2="14"/></g>`
);

// ---------------------------------------------------------------- layout

interface Entry {
  swatch: string;
  name: string;
  note?: string;
}

interface Group {
  title: string;
  entries: Entry[];
  footnote?: string;
}

const renderGroup = (g: Group): string =>
  `<h4 class="keyGroup">${g.title}</h4>` +
  g.entries
    .map(
      (e) =>
        `<div class="keyRow">${e.swatch}<span><b>${e.name}</b>${
          e.note ? `<span class="keyNote">${e.note}</span>` : ''
        }</span></div>`
    )
    .join('') +
  (g.footnote ? `<p class="hint">${g.footnote}</p>` : '');

// ---------------------------------------------------------------- OpenStreetMap

const OSM_GROUPS: Group[] = [
  {
    title: 'Ways you can walk',
    entries: [
      { swatch: line('#fa8072', 2, '4 3'), name: 'Footpath', note: 'Signed or surfaced walking route.' },
      { swatch: line('#c88a76', 2, '2 4'), name: 'Path', note: 'Anything from a good trail to a faint sheep track — no promise of either.' },
      { swatch: line('#3d9b3d', 2, '6 4'), name: 'Bridleway', note: 'Walkers, horses and usually bikes. Often wider and muddier.' },
      { swatch: line('#5b7cfa', 2, '6 4'), name: 'Cycleway', note: 'Walkable unless signed otherwise.' },
      { swatch: line('#a08048', 3, '8 5', '#e8d9b8'), name: 'Track', note: 'Farm or forest vehicle track. Usually the fastest going underfoot.' },
      { swatch: rungs('#e66e64', 5), name: 'Steps' },
      { swatch: line('#f7f5f2', 5, '', '#c9c2b8'), name: 'Minor road', note: 'No pavement on lanes — walk facing traffic.' }
    ]
  },
  {
    title: 'Getting through',
    entries: [
      { swatch: dot('#666', 3), name: 'Gate', note: 'Small grey dot sitting on the path where it meets a barrier.' },
      { swatch: symbol('<circle cx="23" cy="9" r="4" fill="none" stroke="#666" stroke-width="1.6"/>'), name: 'Stile or kissing gate', note: 'Only drawn when zoomed right in (about z17+), so zoom in to check a crossing.' },
      { swatch: bridge, name: 'Footbridge' },
      { swatch: ford, name: 'Ford', note: 'Stream crossing with no bridge. Can be impassable after heavy rain.' },
      { swatch: line('#5a5a5a', 2), name: 'Wall', note: 'Dry stone walls are reliable handrails in poor visibility.' },
      { swatch: fence, name: 'Fence' }
    ],
    footnote: 'OpenStreetMap is the best layer here — surveyors map gates and stiles as points on the path. If a gate is missing, it is missing from the routing data too, which is when the 🧲 freeform toggle helps.'
  },
  {
    title: 'Ground and hazards',
    entries: [
      { swatch: cliff('#666'), name: 'Cliff or crag', note: 'Ticks point downhill, off the top of the drop.' },
      { swatch: stipple(), name: 'Scree or bare rock', note: 'Loose ground — slow and hard on the ankles.' },
      { swatch: marsh, name: 'Marsh or bog', note: 'Wet ground. On moorland this is often the slowest terrain there is.' },
      { swatch: trees('#6a9e4f'), name: 'Broadleaf woodland' },
      { swatch: conifers('#3f7d3f'), name: 'Conifer plantation', note: 'Dense rows; forest tracks may not match the map after felling.' },
      { swatch: area('#e6e0c8'), name: 'Heath or moorland' }
    ]
  },
  {
    title: 'Water',
    entries: [
      { swatch: line('#7fb8d4', 3), name: 'River' },
      { swatch: line('#9ec9dd', 1.5), name: 'Stream', note: 'Thin blue lines. Useful for refills, and for fixing your position.' },
      { swatch: area('#aad3df'), name: 'Lake or tarn' },
      { swatch: dot('#3d6fd0'), name: 'Spring', note: 'Usually the cleanest refill — take it above any grazing.' }
    ]
  },
  {
    title: 'Landmarks and facilities',
    entries: [
      { swatch: peak('#a0522d'), name: 'Peak', note: 'Shown with name and height where mapped.' },
      { swatch: letterChip('P', '#4a7ebb'), name: 'Car park', note: 'Where the walk usually starts.' },
      { swatch: dot('#8b5a2b', 3), name: 'Cairn or trig point', note: 'Small markers, handy for confirming a summit in mist.' },
      { swatch: letterChip('▲', '#7a9e3f'), name: 'Campsite / hostel' }
    ],
    footnote: 'What this layer cannot tell you: OpenStreetMap\'s standard style does not distinguish legal rights of way or show open access land. For "am I allowed here", switch to an OS layer.'
  }
];

// ---------------------------------------------------------------- Ordnance Survey

const TF_GROUPS: Group[] = [
  {
    title: 'Waymarked routes',
    entries: [
      {
        swatch: sw(
          `<g fill="#c0392b">${[6, 14, 22, 30, 38].map((x) => `<circle cx="${x}" cy="9" r="2.6"/>`).join('')}</g>`
        ),
        name: 'National trail',
        note: 'Red dots — e.g. the Pennine Way. Signposted on the ground the whole way.'
      },
      {
        swatch: sw(
          `<g fill="#8e44ad">${[6, 14, 22, 30, 38].map((x) => `<circle cx="${x}" cy="9" r="2.6"/>`).join('')}</g>`
        ),
        name: 'Regional route',
        note: 'Purple dots — e.g. the Capital Ring, the Dartmoor Way. Usually waymarked too.'
      },
      { swatch: symbol('<text x="23" y="13" text-anchor="middle" font-size="9" fill="#8e44ad" font-style="italic">Name</text>'), name: 'Route name', note: 'Written along the line of dots, so you can read which route you are on.' },
      { swatch: line('#333', 2, '2 3'), name: 'Path', note: 'Plain dashes: a path with no waymarked route along it.' },
      { swatch: line('#a08048', 3, '8 5', '#e8d9b8'), name: 'Track' },
      { swatch: line('#ffffff', 5, '', '#c9c2b8'), name: 'Road' }
    ],
    footnote: 'Cycle routes are not drawn as coloured dots on this layer — verified on a tile carrying three of them. Solid blue lines are water, not routes, which is easy to misread at a glance.'
  },
  {
    title: 'Relief',
    entries: [
      { swatch: contours('#c4a882', '#a8875c'), name: 'Contours' },
      { swatch: area('#e8e0d0'), name: 'Elevation shading', note: 'Ground colour shifts with height, and hillshading picks out the shape of the slopes.' },
      { swatch: stipple('#9a9a9a'), name: 'Scree and bare rock' }
    ]
  },
  {
    title: 'Ground cover and water',
    entries: [
      { swatch: conifers('#3f7d3f'), name: 'Forest' },
      { swatch: marsh, name: 'Wetland' },
      { swatch: line('#7fb8d4', 3), name: 'River or stream' },
      { swatch: area('#aad3df'), name: 'Lake or tarn' }
    ]
  },
  {
    title: 'Landmarks and facilities',
    entries: [
      { swatch: peak('#8b5a2b'), name: 'Peak', note: 'With name and height.' },
      { swatch: symbol('<path d="M17 14 L23 5 L29 14 Z" fill="#8b5a2b"/><rect x="21" y="10" width="4" height="4" fill="#fff"/>'), name: 'Hut, refuge or shelter' },
      { swatch: letterChip('P', '#4a7ebb'), name: 'Car park' },
      { swatch: letterChip('▲', '#7a9e3f'), name: 'Campsite' }
    ],
    footnote: 'Same OpenStreetMap data as the OSM layer, drawn for walkers and served as sharp double-resolution tiles. It does not label legal rights of way, and small barrier symbols are less prominent than on the plain OSM layer — switch there to check a specific gate or stile.'
  }
];

// ---------------------------------------------------------------- nearby points

/** The app's own POI markers, drawn the way the map draws them — same two
 *  symbology tokens, so the key cannot drift from the markers it explains. */
const poiChip = (icon: string, colour: string) =>
  sw(
    `<circle cx="23" cy="9" r="7.5" style="fill:var(--poi-disc)" stroke="${colour}" stroke-width="2"/>` +
      `<text x="23" y="12.5" text-anchor="middle" font-size="9" style="fill:var(--poi-glyph)">${icon}</text>`
  );

function nearbyGroup(kinds: readonly string[]): Group | null {
  const cats = poiCategories(kinds);
  if (!cats.length) return null;
  return {
    title: 'Nearby points',
    entries: cats.map((c) => ({ swatch: poiChip(c.icon, c.colour), name: c.label })),
    footnote:
      'Trailhead\'s own markers, not part of the base map — they appear when you tap "What\'s nearby". Which categories it looks for is a tick list in Settings.'
  };
}

// ---------------------------------------------------------------- entry point

const KEYS: Record<string, { title: string; groups: Group[] }> = {
  osm: { title: 'OpenStreetMap', groups: OSM_GROUPS },
  'tf-outdoors': { title: 'Outdoors', groups: TF_GROUPS }
};

export function legendHtml(layerId: string, nearbyKinds: readonly string[] = []): string {
  const key = KEYS[layerId] ?? KEYS.osm;
  const nearby = nearbyGroup(nearbyKinds);
  return `
    <h3>Map key — ${key.title}</h3>
    <p class="hint">Symbols are approximations; map styles change over time.</p>
    ${key.groups.map(renderGroup).join('')}
    ${nearby ? renderGroup(nearby) : ''}`;
}
