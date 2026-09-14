/**
 * Hiking map keys, one per base layer. Each explains only what a walker could
 * misread: which line is a path and which a route, how to spot a gate, what
 * the rough ground looks like. Roads, rivers, lakes, woods, peaks, car parks
 * and contours explain themselves and are left out on purpose, so the few
 * symbols that matter are not buried in a list of the obvious.
 *
 * Swatches use each style's own colours and, for point symbols, its own icon
 * outlines: Freemap's from github.com/FreemapSlovakia/freemap-outdoor-map
 * (Apache-2.0) and OpenStreetMap's from openstreetmap-carto (CC0). Freemap
 * also serves every legend item as an image, at
 * outdoor.tiles.freemap.sk/legend/{id}. Both were checked in September 2026.
 * Thunderforest could not be — it needs a key — and is carried over as it was.
 */

// ---------------------------------------------------------------- swatches

const sw = (inner: string) =>
  `<svg width="46" height="18" viewBox="0 0 46 18" style="flex:0 0 46px">${inner}</svg>`;

/** A plain or dashed line, optionally over a wider casing or glow. */
const line = (color: string, width: number, dash = '', casing = '', y = 9): string =>
  (casing ? `<line x1="2" y1="${y}" x2="44" y2="${y}" stroke="${casing}" stroke-width="${width + 2.5}"/>` : '') +
  `<line x1="2" y1="${y}" x2="44" y2="${y}" stroke="${color}" stroke-width="${width}"${
    dash ? ` stroke-dasharray="${dash}"` : ''
  }/>`;

const way = (color: string, width: number, dash = '', casing = '') => sw(line(color, width, dash, casing));

/** A Freemap path with a route drawn alongside it, the way that style offsets
 *  routes to one side of the way that carries them. */
const besidePath = (route: string) => sw(line('#552b2b', 1.4, '3 3', '#cc9999', 12) + route);

/** Line with teeth on its downhill side. */
const cliff = (color: string) =>
  sw(
    `<line x1="2" y1="6" x2="44" y2="6" stroke="${color}" stroke-width="1.4"/>` +
      `<g fill="${color}">` +
      [6, 15, 24, 33, 42].map((x) => `<path d="M${x - 3} 6 h6 l-3 7 Z"/>`).join('') +
      `</g>`
  );

/** Flat colour area, optionally with a pattern drawn over it. */
const area = (fill: string, over = ''): string =>
  sw(`<rect x="3" y="2" width="40" height="14" rx="2" fill="${fill}"/>${over}`);

/** Loose-rock stipple. */
const stipple = (fill: string, dots: string) =>
  area(
    fill,
    `<g fill="${dots}">` +
      [
        [7, 5], [14, 11], [21, 4], [28, 12], [35, 6], [40, 12],
        [10, 14], [18, 8], [25, 14], [32, 4], [38, 9]
      ]
        .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.25"/>`)
        .join('') +
      `</g>`
  );

/** Wetland: short blue dashes with reed tufts between them. */
const bog = (fill: string, water: string) =>
  area(
    fill,
    `<g stroke="${water}" stroke-width="1.2">` +
      [[6, 5], [22, 5], [14, 9], [30, 9], [6, 13], [24, 13], [35, 5]]
        .map(([x, y]) => `<line x1="${x}" y1="${y}" x2="${x + 6}" y2="${y}"/>`)
        .join('') +
      `</g><g stroke="#4f8f3a" stroke-width="1" fill="none">` +
      [17, 38].map((x) => `<path d="M${x} 14 v-4 M${x - 2} 14 l-1 -3 M${x + 2} 14 l1 -3"/>`).join('') +
      `</g>`
  );

/** A point symbol copied from a map style: its path, and the box its drawing
 *  occupies in that path's own units. */
interface Icon {
  d: string;
  box: [x: number, y: number, w: number, h: number];
}

/** One or more icons in a row, each scaled so its longer side is 12px. */
const glyphs = (fill: string, ...icons: Icon[]) => {
  const size = 12;
  const gap = 5;
  const scales = icons.map(({ box: [, , w, h] }) => size / Math.max(w, h));
  const total = icons.reduce((sum, { box }, i) => sum + box[2] * scales[i], 0) + gap * (icons.length - 1);
  let x = 23 - total / 2;
  return sw(
    icons
      .map(({ d, box: [bx, by, w, h] }, i) => {
        const s = scales[i];
        const tx = x - bx * s;
        const ty = 9 - (h * s) / 2 - by * s;
        x += w * s + gap;
        return `<path transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${s.toFixed(3)})" d="${d}" fill="${fill}" fill-rule="evenodd"/>`;
      })
      .join('')
  );
};

// Gate and stile are the same drawings in both styles: Freemap took them from
// openstreetmap-carto.
const GATE: Icon = {
  d: 'M 4,0 3.4,1 H 0 v 1 h 2.799 l -0.6,1 H 0 V 4 H 1.6 L 1,5 H 2 L 2.6,4 H 6 V 3 H 3.2 L 3.799,2 H 6 V 1 H 4.4 L 5,0 Z',
  box: [0, 0, 6, 5]
};
const STILE: Icon = {
  d: 'm2,.5 a.5,.5 0 0 1 1,0 v3.5 h4 v-3.5 a.5,.5 0 0 1 1,0 v9.5 h-1 v-1 h-4 v1 h-1 z m1,4.5 v1 h4 v-1 z m0,2 v1 h4 v-1 z',
  box: [2, 0, 6, 10]
};
const FM_SPRING: Icon = {
  d: 'M 7.1517932,5.5 A 3.3787894,3.3904123 0 0 0 3.7934813,8.9212342 A 3.4402219,3.4520561 0 0 0 3.977779,10.041098 C 2.2167129,12.147257 3.2508272,13.041093 3.6501388,14.345888 C 4.0494503,15.660957 2.6160244,16.452053 1.5,17.499999 C 4.8173569,16.904108 5.3702498,15.352738 5.278101,14.510272 C 5.1757134,13.565066 4.4282842,12.938353 5.400966,11.839037 C 5.9640976,12.023969 6.5067517,12.332189 7.1415545,12.352736 A 3.3173568,3.3287684 0 0 0 9.0459631,11.736298 A 3.4095057,3.4212343 0 0 0 10.49986,8.9212342 A 3.3787894,3.3904123 0 0 0 7.1415545,5.5 Z',
  box: [1.5, 5.5, 9, 12]
};
const CARTO_SPRING: Icon = {
  d: 'm6,1.3125 a4.6875,4.6875 0 0 0 0,9.375 a4.6875,4.6875 0 0 0 0,-9.375z m0,2.625 a2.0625,2.0625 0 0 1 0,4.125 a2.0625,2.0625 0 0 1 0,-4.125z',
  box: [1.3125, 1.3125, 9.375, 9.375]
};
const FM_SHELTER: Icon = {
  d: 'M 6,5 H 0 V 4 L 6.5,0 L 13,4 V 5 H 7 V 11 H 10 V 12 H 3 V 11 H 6 Z',
  box: [0, 0, 13, 12]
};
const WILDERNESS_HUT: Icon = {
  d: 'M 8,0 V 2 L 7,1.5 0,5 V 7 L 1.5,6.35 V 14 H 3 V 5.7 L 7,4 8,4.426 V 9 H 4.5 c 0.025,1.652 -0.034,3.39 0,5 h 5 C 9.518,11.047 9.506,8.05 9.5,5.062 L 11,5.7 V 14 h 1.5 V 6.35 L 14,7 V 5 L 9.5,2.75 C 9.498,1.831 9.5,0.916 9.5,0 Z M 7,11 c 0,0 1,0 1,1 v 1 H 6 v -1 c 0,-1 1,-1 1,-1 z',
  box: [0, 0, 14, 14]
};

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
  `<h4 class="secTitle">${g.title}</h4><div class="cells">` +
  g.entries
    .map(
      (e) =>
        `<div class="keyRow">${e.swatch}<span><b>${e.name}</b>${
          e.note ? `<span class="keyNote">${e.note}</span>` : ''
        }</span></div>`
    )
    .join('') +
  // The footnote closes the block first: it is about the group, not another
  // symbol in it.
  `</div>` +
  (g.footnote ? `<p class="hint">${g.footnote}</p>` : '');

const CROSSING_NOTE = 'Only drawn from zoom 17 — zoom right in to check a crossing.';
const CLIFF_NOTE = 'Teeth point downhill, off the top of the drop.';
const SCREE_NOTE = 'Loose ground — slow and hard on the ankles.';

// ---------------------------------------------------------------- Freemap

const FREEMAP_GROUPS: Group[] = [
  {
    title: 'Paths and routes',
    entries: [
      { swatch: way('#552b2b', 1.6, '3 3', '#cc9999'), name: 'Path', note: 'Paler dashes mean the path is faint or hard to follow on the ground.' },
      { swatch: way('#552b2b', 2.2, '7 3', '#cc9999'), name: 'Track', note: 'The more broken the line, the rougher the surface. Solid means well made.' },
      { swatch: way('#267326', 1.6, '6 3', '#b3e6b3'), name: 'Bridleway' },
      {
        swatch: besidePath(line('#e8413c', 2, '', '', 6)),
        name: 'Waymarked walking route',
        note: 'A coloured line beside the path, usually the colour of its waymarks. Dashed for a local route.'
      },
      {
        swatch: besidePath(
          `<g fill="#e8413c">${[5, 11, 17, 23, 29, 35, 41].map((x) => `<circle cx="${x}" cy="5.5" r="1.5"/>`).join('')}</g>`
        ),
        name: 'Cycle route',
        note: 'Coloured dots, not a path — the way to walk is the line they run beside.'
      }
    ]
  },
  {
    title: 'Getting through',
    entries: [
      { swatch: glyphs('#000', GATE, STILE), name: 'Gate or stile', note: CROSSING_NOTE },
      { swatch: cliff('#404040'), name: 'Crag or cliff', note: CLIFF_NOTE }
    ]
  },
  {
    title: 'Ground, water and shelter',
    entries: [
      { swatch: stipple('#e6e6e6', '#8a8a8a'), name: 'Scree or bare rock', note: SCREE_NOTE },
      { swatch: bog('#e8f5d8', '#3f7fe8'), name: 'Bog or marsh' },
      { swatch: glyphs('#0064ff', FM_SPRING), name: 'Spring' },
      { swatch: glyphs('#48388a', FM_SHELTER, WILDERNESS_HUT), name: 'Shelter or bothy', note: 'Cover from the weather, not somewhere staffed.' }
    ]
  }
];

// ---------------------------------------------------------------- OpenStreetMap

const OSM_GROUPS: Group[] = [
  {
    title: 'Paths and routes',
    entries: [
      { swatch: way('#fa8072', 2, '2 2', '#ffffff'), name: 'Footpath', note: 'Anything from a paved way to a faint trail — the map does not say which.' },
      { swatch: way('#996600', 2, '6 3', '#ffffff'), name: 'Track', note: 'Farm or forest track. Usually the easiest going underfoot.' },
      { swatch: way('#008000', 1.6, '5 2', '#ffffff'), name: 'Bridleway', note: 'Walkers, horses and usually bikes.' },
      { swatch: way('#0000ff', 1.6, '2 3', '#ffffff'), name: 'Cycleway', note: 'Walkable unless signed otherwise.' }
    ]
  },
  {
    title: 'Getting through',
    entries: [
      { swatch: glyphs('#3f3f3f', GATE, STILE), name: 'Gate or stile', note: CROSSING_NOTE },
      { swatch: cliff('#999999'), name: 'Crag or cliff', note: CLIFF_NOTE }
    ]
  },
  {
    title: 'Ground and water',
    entries: [
      { swatch: stipple('#eee5dc', '#9a9a9a'), name: 'Scree or bare rock', note: SCREE_NOTE },
      { swatch: area('#d6d99f'), name: 'Heath or moorland', note: 'The khaki that covers open fell. Rough ground, not fields.' },
      { swatch: bog('#d6d99f', '#4d80b3'), name: 'Bog', note: 'On moorland, often the slowest going there is.' },
      { swatch: glyphs('#7abcec', CARTO_SPRING), name: 'Spring' }
    ]
  }
];

// ---------------------------------------------------------------- Thunderforest

const routeDots = (colour: string) =>
  sw(`<g fill="${colour}">${[6, 14, 22, 30, 38].map((x) => `<circle cx="${x}" cy="9" r="2.6"/>`).join('')}</g>`);

const TF_GROUPS: Group[] = [
  {
    title: 'Paths and routes',
    entries: [
      { swatch: routeDots('#c0392b'), name: 'National trail', note: 'Red dots, e.g. the Pennine Way. Signposted the whole way.' },
      { swatch: routeDots('#8e44ad'), name: 'Regional route', note: 'Purple dots. Usually waymarked too.' },
      { swatch: way('#333', 2, '2 3'), name: 'Path', note: 'Plain dashes: a path with no waymarked route along it.' },
      { swatch: way('#a08048', 2.5, '8 5', '#e8d9b8'), name: 'Track' }
    ],
    footnote: 'Cycle routes are not drawn as dots on this layer, and solid blue lines are water, not routes.'
  },
  {
    title: 'Ground and shelter',
    entries: [
      { swatch: stipple('#e8e0d0', '#9a9a9a'), name: 'Scree or bare rock', note: SCREE_NOTE },
      { swatch: bog('#e3eef0', '#4a90a4'), name: 'Wetland' },
      { swatch: glyphs('#8b5a2b', WILDERNESS_HUT), name: 'Hut or shelter' }
    ]
  }
];

// ---------------------------------------------------------------- entry point

const KEYS: Record<string, { title: string; groups: Group[] }> = {
  freemap: { title: 'Outdoor', groups: FREEMAP_GROUPS },
  'tf-outdoors': { title: 'Outdoors', groups: TF_GROUPS },
  osm: { title: 'OpenStreetMap', groups: OSM_GROUPS }
};

export function legendHtml(layerId: string): string {
  const key = KEYS[layerId] ?? KEYS.osm;
  return `
    <h3>Map key — ${key.title}</h3>
    ${key.groups.map(renderGroup).join('')}
    <p class="hint">No layer shows legal rights of way or open access land.</p>`;
}
