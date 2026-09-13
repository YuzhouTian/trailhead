// Regenerates the two README screenshots, docs/screenshot-route.png and
// docs/screenshot-pin.png, at 390x844 and 2x in dark mode — an iPhone 14's
// screen, which is what the pictures are meant to look like they came off.
//
// Playwright is deliberately not a dependency of this project: it is a browser
// download the app itself has no use for. Install it only when you need new
// pictures, and don't save it:
//
//   npm run dev                       # in one terminal
//   npm i --no-save playwright sharp
//   npx playwright install chromium
//   node scripts/screenshots.mjs docs
//
// The route is fetched live from the same routing server the app uses, so the
// line on the map follows real paths; the pictures therefore need a connection.
import { chromium } from 'playwright';
import { readFileSync, statSync, writeFileSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:5173/';
const OUT = process.argv[2];

// A real Helvellyn round, routed by the same server the app uses, so the line
// in the screenshot follows actual paths rather than a hand-drawn guess.
const WPS = [
  [-2.9487, 54.5449], [-2.9835, 54.5354], [-2.9930, 54.5320], [-3.0075, 54.5285],
  [-3.0166, 54.5271], [-3.0140, 54.5295], [-3.0084, 54.5325], [-2.9990, 54.5362],
  [-2.9670, 54.5420], [-2.9487, 54.5449]
];
const url = `https://brouter.de/brouter?lonlats=${WPS.map((p) => p.join(',')).join('|')}` +
  `&profile=hiking-beta&alternativeidx=0&format=geojson`;
const gj = await (await fetch(url)).json();
const coords = gj.features[0].geometry.coordinates.map(([lng, lat, ele]) => [lat, lng, Math.round(ele)]);

const R = 6371000, rad = (x) => (x * Math.PI) / 180;
let dist = 0, asc = 0, desc = 0;
for (let i = 1; i < coords.length; i++) {
  const [y1, x1, e1] = coords[i - 1], [y2, x2, e2] = coords[i];
  const h = Math.sin(rad(y2 - y1) / 2) ** 2 +
    Math.cos(rad(y1)) * Math.cos(rad(y2)) * Math.sin(rad(x2 - x1) / 2) ** 2;
  dist += 2 * R * Math.asin(Math.sqrt(h));
  const d = e2 - e1;
  if (d > 0) asc += d; else desc -= d;
}
const route = {
  id: 'shot-helvellyn', name: 'Helvellyn via Striding Edge',
  waypoints: WPS.map(([lng, lat]) => [lat, lng]), snaps: null, coords,
  distanceM: Math.round(dist), ascentM: Math.round(asc), descentM: Math.round(desc),
  createdAt: Date.now()
};
console.log('routed:', coords.length, 'points,', (dist / 1000).toFixed(1), 'km, up', Math.round(asc), 'm');

const browser = await chromium.launch();

async function makePage(opts) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
    locale: 'en-GB',
    ...opts
  });
  const page = await ctx.newPage();
  await page.addInitScript((r) => {
    localStorage.setItem('trailhead.routes', JSON.stringify([r]));
    localStorage.setItem('trailhead.activeRoute', JSON.stringify(r));
    localStorage.setItem('trailhead.pins', JSON.stringify([]));
    localStorage.setItem('trailhead.settings', JSON.stringify({
      baseLayer: 'freemap', overlayLayer: '', overlayOpacity: 0.5, profile: 'hiking-beta',
      speedKmh: 4, tfKey: '', theme: 'dark', schema: 1
    }));
  }, route);
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  return page;
}

/** Wait until every tile Leaflet has asked for has actually arrived. */
async function tilesSettled(page, ms = 60000) {
  await page.waitForFunction(() => {
    const all = document.querySelectorAll('.leaflet-tile').length;
    const done = document.querySelectorAll('.leaflet-tile-loaded').length;
    return all > 0 && all === done;
  }, null, { timeout: ms });
  await page.waitForTimeout(800);
}

// --- 1. the route, with its elevation profile open ------------------------
// No geolocation: this is the picture of a walk loaded at home, which is also
// what keeps the card to its name/stats/chart rather than a live progress line.
{
  const page = await makePage({});
  await page.evaluate((r) => {
    window.__map.fitBounds(r.coords.map((c) => [c[0], c[1]]), { padding: [28, 28], animate: false });
  }, route);
  await tilesSettled(page);
  await page.click('#rcChart');
  await page.waitForTimeout(1200);
  await tilesSettled(page);
  // Refusing the browser's location prompt raises the app's "GPS error" toast,
  // which is correct behaviour and nothing to do with what this picture is of.
  await page.evaluate(() => document.getElementById('toast').classList.add('hidden'));
  await page.screenshot({ path: `${OUT}/screenshot-route.png` });
  console.log('wrote screenshot-route.png');
  await page.context().close();
}

// --- 2. the "What's here" card on Helvellyn summit ------------------------
// Geolocation at Glenridding, where the walk starts, so the card's "how far
// from you" fact has a real answer.
{
  const page = await makePage({
    geolocation: { latitude: 54.5449, longitude: -2.9487, accuracy: 12 },
    permissions: ['geolocation']
  });
  await page.click('#rcClose');
  // Centred south of the summit so the dropped pin lands in the strip of map
  // above the card rather than behind it.
  await page.evaluate(() => window.__map.setView([54.5232, -3.0166], 16, { animate: false }));
  await tilesSettled(page);
  await page.evaluate(() => {
    const LL = window.L ? window.L.latLng(54.52697, -3.01664) : { lat: 54.52697, lng: -3.01664 };
    window.__map.fire('contextmenu', { latlng: LL });
  });
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `${OUT}/screenshot-pin.png` });
  console.log('wrote screenshot-pin.png');
  await page.context().close();
}

await browser.close();

// A dark hillshaded map is a noisy picture, and a straight 2x PNG of one is a
// megabyte and a half that lives in the repository forever. Squeezing it to a
// palette takes about two thirds off and is invisible at README size.
const sharp = (await import('sharp')).default;
for (const f of [`${OUT}/screenshot-route.png`, `${OUT}/screenshot-pin.png`]) {
  const before = statSync(f).size;
  const out = await sharp(readFileSync(f)).png({ palette: true, quality: 82, effort: 10 }).toBuffer();
  writeFileSync(f, out);
  console.log(f, `${Math.round(before / 1024)}kB -> ${Math.round(out.length / 1024)}kB`);
}
