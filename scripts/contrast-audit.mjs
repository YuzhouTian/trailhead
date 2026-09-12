// WCAG contrast audit for Trailhead's chrome. Token values are read straight
// out of src/style.css so this cannot drift from the stylesheet.
import { readFileSync } from 'node:fs';

const css = readFileSync(process.argv[2] ?? 'src/style.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function tokensFromBlock(block) {
  const out = {};
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
// light = the bare :root blocks; dark = the [data-theme="dark"] block
const lightBlocks = [...css.matchAll(/^:root \{([\s\S]*?)^\}/gm)].map((m) => m[1]);
const darkBlock = css.match(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/)[1];
const LIGHT = Object.assign({}, ...lightBlocks.map(tokensFromBlock));
const DARK = { ...LIGHT, ...tokensFromBlock(darkBlock) };

function parse(c) {
  c = c.trim();
  let m = c.match(/^#([0-9a-f]{6})$/i);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(1);
  m = c.match(/^#([0-9a-f]{3})$/i);
  if (m) return [...m[1]].map((h) => parseInt(h + h, 16)).concat(1);
  m = c.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const p = m[1].split(',').map((s) => parseFloat(s));
    return [p[0], p[1], p[2], p[3] === undefined ? 1 : p[3]];
  }
  throw new Error('cannot parse colour: ' + c);
}
const over = (fg, bg) => {
  const a = fg[3];
  return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a)).concat(1);
};
function lum(rgb) {
  const f = rgb.slice(0, 3).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
}
function ratio(a, b) {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

// `expr` is a token name, a literal colour, or "tokenOrColour over tokenOrColour"
// (for translucent fills), or "mix:PCT:a:b" for color-mix(a PCT%, transparent) over b.
function resolve(expr, T) {
  const parts = expr.split(' over ');
  let cur = null;
  for (let i = parts.length - 1; i >= 0; i--) {
    let p = parts[i].trim();
    let c;
    const mix = p.match(/^mix:(\d+):(.+)$/);
    if (mix) {
      c = parse(T[mix[2]] ?? mix[2]);
      c = [c[0], c[1], c[2], Number(mix[1]) / 100];
    } else {
      c = parse(T[p] ?? p);
    }
    cur = cur === null ? c : over(c, cur);
  }
  return cur;
}

// floor: 4.5 normal text, 3 for icons / 18px+ bold / non-text UI
const P = [];
const pair = (screen, what, fg, bg, floor = 4.5) => P.push({ screen, what, fg, bg, floor });

// --- global -------------------------------------------------------------
pair('everywhere', 'body text on page', '--ink', '--bg');

// --- tab bar ------------------------------------------------------------
pair('tab bar', 'inactive label', '--muted', '--bg');
pair('tab bar', 'inactive icon', '--muted', '--bg', 3);
pair('tab bar', 'active label', '--brand', '--bg');
pair('tab bar', 'active icon', '--brand', '--bg', 3);

// --- locate button ------------------------------------------------------
pair('map furniture', 'Me icon idle', '--muted', '--surface', 3);
pair('map furniture', 'Me icon active', '--brand', '--surface', 3);
pair('map furniture', 'Me icon failed (#btnLocate.failed)', '--notice', '--surface', 3);

// --- search -------------------------------------------------------------
pair('search', 'typed text', '--ink', '--surface');
pair('search', 'placeholder', '--muted', '--surface');
pair('search', 'search icon', '--muted', '--surface', 3);
pair('search', 'clear icon', '--muted', '--surface', 3);
pair('search results', 'result name .n', '--ink', '--surface');
pair('search results', 'result detail .d', '--muted', '--surface');

// --- status banner ------------------------------------------------------
pair('banner', 'on-route text', '--on-brand', '--brand');
pair('banner', 'off-route text (.off)', '--on-brand', '--danger');
pair('banner', 'arrival text (.arrive)', '--on-notice', '--notice');

// --- sheet shell / panels ----------------------------------------------
pair('sheet', 'sheet grabber (--muted at 80%)', 'mix:80:--muted over --bg', '--bg', 3);
pair('sheet', 'close icon', '--muted', '--bg', 3);
pair('sheet', 'panel title h3', '--ink', '--bg');
pair('sheet', 'section eyebrow .secTitle', '--muted', '--bg');
pair('sheet', 'hint text', '--muted', '--bg');
pair('sheet', 'grouped row label', '--ink', '--surface-2');
pair('sheet', 'needs-key warning .warn', '--danger-ink', '--surface-2');
pair('sheet', 'field text', '--ink', '--surface-2');
pair('sheet', 'field placeholder', '--muted', '--surface-2');
pair('sheet', 'prose steps (hand-off)', '--ink', '--bg');
pair('sheet', 'primary button', '--on-brand', '--brand');
pair('sheet', 'secondary button', '--ink', '--surface-2');
pair('sheet', 'danger button', '--on-brand', '--danger');
pair('sheet', 'disabled button label', '--muted', '--surface-2');
pair('sheet', 'segmented unselected', '--ink-2', '--surface-2');
pair('sheet', 'segmented selected', '--ink', '--surface-3');
pair('sheet', 'segmented icon unselected', '--ink-2', '--surface-2', 3);
pair('saved list', 'route/pin name', '--ink', '--surface-2');
pair('saved list', 'route/pin sub line', '--muted', '--surface-2');
pair('saved list', 'pin category icon', '--brand', '--surface-2', 3);
pair('saved list', 'Load button', '--on-brand', '--brand');
pair('saved list', 'Share/GPX button', '--ink', '--surface');
pair('saved list', 'delete icon', '--danger', '--danger-soft', 3);
pair('map key', 'key row text', '--ink', '--surface-2');
pair('map key', 'key row note', '--muted', '--surface-2');

// --- plan bar -----------------------------------------------------------
pair('plan bar', 'stats line', '--ink', '--bg');
pair('plan bar', 'Undo/Clear label', '--ink', '--surface-2');
pair('plan bar', 'Done label', '--on-brand', '--brand');
pair('plan bar', 'magnet off', '--muted', '--surface-2', 3);
pair('plan bar', 'magnet on', '--on-brand', '--brand', 3);

// --- route card ---------------------------------------------------------
pair('route card', 'route name', '--ink', '--surface');
pair('route card', 'stats line', '--ink-2', '--surface');
pair('route card', 'remaining (24px bold)', '--brand', '--surface', 3);
pair('route card', 'header button icon', '--ink', '--surface-2', 3);
pair('route card', 'header button icon (chart open)', '--on-brand', '--brand', 3);
pair('route card', 'close icon', '--muted', '--surface', 3);
pair('elevation chart', 'axis labels', '--muted', '--surface');
pair('elevation chart', 'profile line', '--brand', '--surface', 3);

// --- pin card -----------------------------------------------------------
pair('pin card', 'eyebrow', '--muted', '--surface');
pair('pin card', 'title', '--ink', '--surface');
pair('pin card', 'category badge icon', '--brand', '--brand-soft', 3);
pair('pin card', 'grid reference', '--ink', '--surface');
pair('pin card', 'lat/lng line', '--muted', '--surface');
pair('pin card', 'fact text', '--ink', '--surface');
pair('pin card', 'fact icon', '--brand', '--surface', 3);
pair('pin card', 'fact while loading', '--muted', '--surface');
pair('pin card', 'name field text', '--ink', '--surface-2');
pair('pin card', 'chip off', '--ink-2', '--surface-2');
pair('pin card', 'chip on', '--on-brand', '--brand');
pair('pin card', 'Save button', '--on-brand', '--brand');
pair('pin card', 'busy button', '--muted', '--surface-2');
pair('pin card', 'neutral button', '--ink', '--surface-2');
pair('pin card', 'delete icon', '--danger', '--danger-soft', 3);
pair('pin card', 'close icon', '--muted', '--surface', 3);

// --- toast --------------------------------------------------------------
pair('toast', 'light: page ground on ink', '--bg', '--ink');
pair('toast', 'dark: ink on surface-2', '--ink', '--surface-2');

// --- leaflet furniture --------------------------------------------------
// The scale bar is opaque --surface, so what is under it on the map does not
// enter into it — that is exactly why it was made opaque.
pair('map furniture', 'scale bar label', '--ink', '--surface');
pair('map furniture', 'scale bar rule', '--muted', '--surface', 3);

// --- popups -------------------------------------------------------------
pair('popup', 'popup text', '--ink', '--surface');
pair('popup', 'popup sub line', '--muted', '--surface');
pair('popup', 'popup close button', '--muted', '--surface', 3);

// --- QR screens (deliberately literal, identical in both themes) ---------
pair('QR full-screen', 'caption', '#1a2420', '#ffffff');
pair('QR full-screen', 'close button', '#1a2420', '#e9ede9');
pair('QR scanner', 'hint text', '#ffffff', '#000000');
pair('QR scanner', 'cancel button', '#1a2420', '#ffffff over #000000');

// --- map symbology (theme-independent; checked once) --------------------
const POI = {
  summit: '#2d6a4f', trig: '#6b705c', viewpoint: '#1a73e8', water: '#3d9bd0',
  waterfall: '#2f7d95', shelter: '#8b5a2b', camp: '#7a9e3f', cafe: '#b5651d',
  toilets: '#5a6d8c', parking: '#4a7ebb', bus: '#7b5ea7', picnic: '#6a9e4f',
  star: '#a0522d', cave: '#4d4d4d', emergency: '#c0392b'
};

const fmt = (n) => n.toFixed(2).padStart(5);
let fails = 0;
const rows = [];
for (const p of P) {
  const l = ratio(resolve(p.fg, LIGHT), resolve(p.bg, LIGHT));
  const d = ratio(resolve(p.fg, DARK), resolve(p.bg, DARK));
  const ok = l >= p.floor && d >= p.floor;
  if (!ok) fails++;
  rows.push(`${ok ? 'PASS' : 'FAIL'} | ${p.screen.padEnd(15)} | ${p.what.padEnd(42)} | ${fmt(l)} | ${fmt(d)} | >=${p.floor}`);
}
console.log('     | screen          | pair                                       | light | dark  | floor');
console.log(rows.join('\n'));

console.log('\n--- nearby-point markers: white glyph on the category disc (icon, >=3) ---');
for (const [k, c] of Object.entries(POI)) {
  const r = ratio(parse('#ffffff'), parse(c));
  if (r < 3) fails++;
  console.log(`${r >= 3 ? 'PASS' : 'FAIL'} | ${k.padEnd(10)} ${c} | ${fmt(r)}`);
}
console.log(`\n${fails} failure(s) out of ${P.length + Object.keys(POI).length} pairs.`);
