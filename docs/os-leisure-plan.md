# OS Leisure (Explorer 1:25k) layer — the plan

Written 2026-10-21. Nothing is built yet. Read this, mark it up, and the build
follows it phase by phase. Phase 1 is a throwaway spike with a go/no-go at the
end, so if the risky part fails we have spent a day, not a week.

---

## 1. What we are building

A fourth base map, **"OS Explorer (1:25k)"**, in the Map panel. It is the OS Maps
API `Leisure_27700` style: the paper Explorer map at 1:25,000 when zoomed in,
with OS's own 1:50k and smaller-scale maps as you zoom out.

It comes with three things attached:

- **A key in Settings.** Your OS Data Hub key, stored on your phone only.
- **Offline downloads** for routes, the same button as today.
- **A GB-only fallback.** Outside Great Britain the app swaps to Freemap
  automatically, and swaps back when you return.

**What it will not do:**
- Show sharper than the paper map. The finest level is 1.75 m per pixel. You
  can zoom in two steps past that, but it is just enlarged.
- Look as crisp as Freemap on an iPhone. There is no retina version of a
  scanned map, and to match Freemap's scale exactly the tiles are drawn
  1.14–1.5× larger than OS's native size (see §3).
- Cover Northern Ireland, the Isle of Man or the Channel Islands.

## 2. The facts the plan is built on

| | |
|---|---|
| Tile URL | `https://api.os.uk/maps/raster/v1/zxy/Leisure_27700/{z}/{x}/{y}.png?key={osKey}` |
| Grid | EPSG:27700, British National Grid (eastings/northings in metres) |
| Tile origin | E −238375, N 1376256 (top-left), 256 px tiles |
| Levels | 0–9 used by Leisure; level *k* = 896 / 2^k m per pixel |
| 1:25k | levels 7, 8, 9 (7, 3.5, 1.75 m/px), all Premium |
| 1:50k | level 5 (free) and 6 (Premium) |

**Check before Phase 2:** the origin comes from OS's Road_27700 metadata. Leisure
uses the same grid in every OS example, but the spike must confirm tiles land in
the right place, for example a trig point matching its marker.

## 3. The grid switch, and keeping zoom numbers in line

### How the switch works

Leaflet can run only one grid at a time. So the map changes grid when you pick
the OS layer, and changes back when you leave it:

1. Set `map.options.crs` to the OS grid (or back to standard).
2. Redraw at the same centre and zoom using `map._resetView`. That's a private
   Leaflet method, but [tapzoom.ts](../src/tapzoom.ts) already relies on it.
3. Routes, pins, the GPS dot and search markers all store GPS coordinates. They
   re-project themselves when the view resets, so none of them change.

### Our own grid, no new library

[osgb.ts](../src/osgb.ts) already converts GPS to eastings/northings and back,
for grid references. A small Leaflet grid definition built on those two
functions replaces Proj4Leaflet + proj4 (about 80 KB). The new file is
`src/map/osgrid.ts`:

- `projection.project(latlng)` → `latLngToEastingNorthing`, and `unproject` →
  `eastingNorthingToLatLng`.
- `transformation` = `L.Transformation(1, 238375, -1, 1376256)`, so pixel (0,0)
  is the tile origin.
- `distance` = Leaflet's standard Earth distance. The scale bar and anything
  else that measures distance keep working.
- Accuracy is the Helmert transform's, a few metres. The GPS dot may sit a few
  metres off a drawn path. That's fine for walking, and the spike should note
  how it looks.

### Zoom: switching layers never changes the scale

**The goal:** switching between OS and Freemap (or Thunderforest or
OpenStreetMap, which all share Freemap's zoom levels) leaves the map at exactly
the same scale. The same ground is on screen, the scale bar doesn't move, and
the zoom number is the same.

**Why it isn't automatic.** On the standard grid, the metres per pixel at a
given zoom depend on latitude: the further north, the more zoomed-in each level
is. OS's levels are fixed metres per pixel everywhere. So no single fixed pairing
of levels matches everywhere. Put OS level 7 against zoom 14 and the OS map
shows more ground than Freemap, by a factor that grows going north:

| Latitude | Freemap z14 (m/px) | OS level 7 (m/px) | OS shows more ground by |
|---|---|---|---|
| 50° (Cornwall) | 6.1 | 7 | 1.14× |
| 54° (Lakes) | 5.6 | 7 | 1.25× |
| 58° (Sutherland) | 5.1 | 7 | 1.38× |
| 60.8° (Unst) | 4.7 | 7 | 1.50× |

**The fix: the OS grid matches Freemap's scale at your latitude.** The OS grid
definition in `osgrid.ts` takes a **reference latitude** φ₀ and defines app
zoom *z* to be exactly Freemap's metres per pixel there:

  `res(z) = 156543.03 × cos φ₀ / 2^z`

Each OS tile still comes from OS level *k = z − 7*, but it is drawn larger than
256 px to cover the right ground:

  `tileSize = 256 × (896 / 2^k) / res(z)` = `256 × 7 / (9.554 × cos φ₀)`

That's about 291 px in Cornwall, 319 px in the Lakes and 354 px in Sutherland.
Leaflet supports tile sizes other than 256 as a standard option, so it does the
placement. Across all of GB the ratio stays between 1× and 2×, so app zoom 14 is
always OS level 7 and the level pairing (`zoomOffset: -7`) never changes.

**Keeping it matched as you move.** φ₀ is set to the map centre's latitude when
you switch to OS. On `moveend`, if the centre has drifted more than 0.5° of
latitude (about 55 km) from φ₀, the grid is quietly rebuilt at the new latitude.
That's a scale change of about 1% at most, which you can't see, and Freemap's
own scale is already drifting by the same amount as you pan. So whenever you
switch back, the match is within 1%.

**What this means:**

- Zoom numbers are whole numbers on both grids. No code in the app has to
  translate them.
- Follow zoom 15 and "zoom to pin/search hit" 15 land on the 1:25k map at the
  same scale you're used to on Freemap.
- The UK start view (6) gets clamped to 7, which is the whole of GB.
- Your saved view means the same thing on either grid.
- The offline zooms 12–16 map to OS levels 5–9 (see §5).

**The cost:** OS tiles are always drawn enlarged, by 1.14× in Cornwall up to
1.5× on Shetland. The map's text is a little bigger and a little softer than
OS's own native size. The alternative is drawing the next level down shrunk to
57–88%, which is sharp but has text too small to read on a phone. Enlarging is
the better trade.

**Option added 2026-10-22: OS's own scale.** A checkbox in Settings, under the
OS key, "OS Explorer at OS's own scale", turns the match off: app zoom *z* is exactly OS
level *z − 7* everywhere, every tile is drawn at 256 px, and nothing re-matches
on a pan. Each OS pixel is one screen pixel instead of 1.14–1.5 (1.26 in the
Lakes), so the map carries 1.3–2.2× as many map pixels per screen area (1.6× in
the Lakes) and loses the blur of resampling by a fraction. The zoom number stays
the same on a switch, so the map zooms out by that factor going onto OS and back
in coming off it, and the text is OS's own size, about a fifth smaller than now.
On a 3× phone screen both are enlarged by the browser anyway (3× vs 3.8×), so
the gain there is the extra detail rather than a jump from soft to crisp.

**Added 2026-10-22: sharper zooms 14 and 15 on a phone.** OS has no retina
tiles, so on a 3× screen each OS pixel covered 3×3 screen pixels, and the map
went soft one step out from 16: crisp mid-pinch while the level-9 tiles were
being shrunk, soft on letting go when level 8 replaced them. Levels 7, 8 and 9
are all the one 1:25k map, so on a high-density screen zooms 14 and 15 now draw
each tile from the four tiles of the next level in at half size
([sharptiles.ts](../src/map/sharptiles.ts)): same ground, same text size, twice
the pixels each way. That is four tile requests instead of one at those zooms.
Not zoom 13: level 6 is the 1:50k, and drawing it from level 7 would swap in
the 1:25k with its text at half size. Extended the same day to zooms 8, 10 and
12, whose next levels are the same map (MiniScale, the 1:250k and the 1:50k);
zoom 12's next level is Premium, so it now costs four Premium tiles where it
cost one free one. (This also corrects the "text too small"
point above: at the same ground scale, the next level in only adds pixels; the
text grows smaller only when it is a different map.)

**Layer definition:** `maxNativeZoom: 16`, `maxZoom: 18`, `minNativeZoom: 7`,
`minZoom: 7`, `zoomOffset: -7`, and `tileSize` calculated from φ₀ as above.

**Fallback if the spike shows problems** (for example hairline gaps between
tiles from a fractional tile size, or a visible flash when the grid is rebuilt):
re-match only when you switch layers, not while you pan. The match is then exact
at the moment of every switch, which is what you asked for.

### The changes to `BaseLayerDef` ([config.ts](../src/config.ts))

- `grid?: 'web' | 'osgb'`, defaulting to `'web'`.
- `needsTfKey?: boolean` becomes `needsKey?: 'tf' | 'os'`. Settings and the
  layer list read the right key. Saved settings carry nothing to migrate,
  because the flag lives only in code.
- `zoomOffset?: number` and `minZoom?: number`, passed through in `makeTileLayer`.
  For the OS layer, `makeTileLayer` also sets `tileSize` from the grid's
  current φ₀. Rebuilding the grid on a big pan rebuilds the tile layer too.

`applyLayers()` in [map.ts](../src/map/map.ts) gets one new step: if the new
layer's grid differs from the map's, switch grids (above) before adding the tile
layer.

### Rotation and heading

- **leaflet-rotate** patches several of Leaflet's pixel-maths functions. It has
  never been tried on a non-standard grid. **This is the main thing the spike
  must prove** (see §7).
- **Grid north vs true north.** On the OS grid "up" is grid north, which is off
  true north by γ ≈ (lng + 2°) × sin(lat). That's up to about 3.5° in the
  Hebrides and 0° along 2°W. In heading-up mode,
  [tracking.ts](../src/features/tracking.ts) adds γ to the bearing when the map
  is on the OS grid. It's one line plus a tested helper in `osgb.ts`.

## 4. The OS key setting

- **`settings.osKey: string`** in [state.ts](../src/state.ts), default `''`. It
  lives on the device only, like the Thunderforest key. It is never in the repo
  or in a share link.
- **Settings panel** ([panels.ts](../src/ui/panels.ts)): a second password field
  under the Thunderforest one, "OS Data Hub key", with a link to
  osdatahub.os.uk. The toast reads "OS key saved — pick OS Explorer in Map".
- **Map panel:** the OS layer shows "(needs key)" until there is one, as
  Thunderforest does today.
- **Missing or wrong key:** the existing logic carries over. No key → the OS
  layer can't be picked and you get a toast. Four tile errors → "OS Explorer
  tiles are failing — check the key in Settings", then a fall back.
- **Out of Premium allowance:** OS pauses Premium tiles. Levels 6–9 then fail
  while 0–5 still work, so the same four-error rule catches it. The toast
  should mention the allowance as a possible cause.
- **Spending:** if you never register a card in the Data Hub, Premium stops at
  the £1,000 free allowance instead of charging. That's a free hard cap, and
  worth doing.
- **Service worker** ([sw.js](../public/sw.js)): add `api.os.uk` to
  `isTileRequest`. `tileCacheKey` already strips `?key=`, so a new key doesn't
  throw away saved tiles. Bump `TILE_CACHE` only if the spike shows OS error
  tiles getting cached.
- **CORS:** OS's browser examples fetch from `api.os.uk` directly, so it should
  send the header and the layer can keep `cors` at its default (true). Per the
  Freemap lesson, the Browser pane can't test this, so it is checked on the
  deployed Pages build on a phone. If it fails, set `cors: false`.
- **Preconnect:** add `<link rel="preconnect" href="https://api.os.uk">` to
  [index.html](../index.html) only if OS becomes your usual layer. Otherwise it
  costs a handshake on every launch.

## 5. Offline downloads

[offline.ts](../src/features/offline.ts) works out tiles using the standard
grid's maths (`latLngToTile` in [geo.ts](../src/geo.ts)) and checks bounds with
`2 ** z`. Both become grid-aware:

- **`tileFor(def, lat, lng, appZoom)`** in `geo.ts` gives the standard maths for
  `'web'` and, for `'osgb'`:
  `k = appZoom − 7`, `res = 896 / 2^k`, `(e, n) = latLngToEastingNorthing(...)`,
  `x = floor((e + 238375) / (256·res))`, `y = floor((1376256 − n) / (256·res))`.
- The **bounds check** comes from the layer instead of `2 ** z`. For the OS
  grid that's the tile range covering E 0–700000, N 0–1300000.
- The URL uses the OS level (`appZoom + zoomOffset`), not the app zoom.
- **Zooms:** keep `OFFLINE_ZOOMS` 12–16 → OS 5–9. That's the 1:50k for overview
  and all three 1:25k levels. The per-route tile count is about the same as
  Freemap, because the metres per tile are similar.
- **Before the download starts,** the confirm says how many OS tiles it is and
  that they count towards the Premium allowance.

**Licence check:** settled by the user on 2026-10-23. Trailhead is a
non-profit project that will open to other people once ready, so OS tiles are
saved offline like any other layer. No cost warning in the confirm either, at
the user's call.

**As built (2026-10-23):** the maths lives in `osTileAt` / `osTileInGrid` in
[osgb.ts](../src/osgb.ts) rather than a `tileFor` in `geo.ts`. The offline
download saves every usable layer (issue #107), so OS comes along whenever an
OS key is set. Only the GB part of a route counts, and at the sharp levels on
a high-density screen it saves the four tiles of the next level in, since those
are what the map draws. `osgrid.test.ts` checks the tiles against Leaflet's own
grid at every offline zoom.

## 6. The GB-only fallback

**As built (Phase 3):** you chose to stay on Freemap after leaving GB, so there
is no split between the layer you chose and the layer shown. Leaving switches
`settings.baseLayer` to Freemap (`DEFAULT_LAYER_ID`, named `OUTSIDE_GB_LAYER_ID`
when this was built) until OS is picked
again. "Leaving" means none of a 3×3 grid of points across the view is inside
the offshore outline, which works at every zoom, and the offshore margin is the
dead band. The original design is below for reference.

The Map panel keeps **two things apart:** `settings.baseLayer` (what you chose)
and the layer actually shown. Choosing OS Explorer means "OS wherever it covers".

- **Coverage test:** a coarse GB outline (about 40 points, mainland GB plus the
  big islands, excluding NI, IoM and Channel Islands) in `osgb.ts`, with
  `inGB(lat, lng)`. A rectangle won't do: the OS grid's extent includes NI and
  half of Ireland, where Leisure has no map.
- **When it's checked:** on `moveend`, using the map centre. A short dead band
  (the centre must be 2 km out before switching away) stops it flipping back and
  forth along a coast.
- **Leaving GB:** show Freemap (or OpenStreetMap if Freemap fails, through the
  existing fallback), toast "No OS map here — showing Freemap", keep
  `settings.baseLayer = 'os-leisure'`.
- **Coming back:** switch to the OS layer again quietly. You'll see the
  grid-switch jump once.
- **Startup outside GB:** open straight onto Freemap. No OS tile request is
  wasted.

## 7. Build order

Each phase is one PR into `main`, and each leaves the app working.

**Phase 1 — Spike (throwaway branch, about a day).** The OS grid plus a bare
Leisure layer, switched by a dev-only toggle. You paste your key into Settings
in the preview yourself; I won't type it. The spike passes if all of these work
on both grids, switching both ways:

1. Tiles line up: a known trig point matches its marker.
2. A saved route line, pins and the GPS dot redraw in the right place after the
   switch.
3. leaflet-rotate: heading-up rotation, pinch and the one-finger tap-zoom all
   behave.
4. The scale bar reads correctly, and **reads the same before and after a
   switch** at a few latitudes (Dartmoor, the Lakes, Cairngorms). Zooming by
   ±1 on the OS map must keep that match too.
4b. No hairline gaps between the enlarged tiles, and no visible flash when the
   grid re-matches after a long pan. If either shows, use the
   re-match-only-on-switch fallback in §3.
5. Panning a long route stays smooth. Projecting every route point through
   `osgb.ts` is heavier than the standard maths; if it stutters, cache the
   projected points per route.

**Spike results (2026-10-21, branch `spike/os-leisure`): go.**
- Scale match: horizontal scale is the same as Freemap at Dartmoor, the Lakes,
  Cairn Gorm and Norfolk, at zooms 12/14/16. Vertical is 0.2% off (Freemap's
  own north–south stretch), invisible. Matching on longitude span instead of
  cos(lat) is what made the horizontal match exact.
- Alignment: Snowdon's trig point sits on the OS triangle, rotated or not, and
  in the same place on screen as on Freemap.
- Routes, pins, rotation, fractional zoom and the re-match after a long pan all
  check out.
- No gaps between tiles: tested with a magenta background behind them at phone
  size.
- To carry into Phase 2: with a 6,000-point route, a zoom step redraws in 20 ms
  on OS vs 7 ms on Freemap (desktop), because every point goes through
  osgb.ts. Cache each route's projected points on the OS grid.

**Go/no-go after the spike.** If leaflet-rotate won't cooperate, the fallback is
to switch off rotation while on the OS layer. That's your call when we get
there.

**Phase 2 — The layer and the key.** `BaseLayerDef` changes, `osgrid.ts` for
real, the `applyLayers` grid switch, the OS key in Settings and the Map panel
entry, the service worker, and tests: projection round trips, tile maths for a
known point, and `usable()` with and without a key.

**Phase 3 — GB fallback.** `inGB`, the dead band, the shown-vs-chosen split,
startup handling, and tests at points just in and out of GB (Stranraer vs
Larne, Dover vs Calais).

**Phase 4 — Offline.** Grid-aware `tileFor`, the bounds check and the confirm
text. Waits on the licence answer.

**Phase 5 — Polish.** Grid-north correction in heading-up, the README's layer
list, the legend (OS publishes the Explorer key as a PDF; linking to it may be
enough).

## 8. Open questions for you

Answered 2026-10-21: the name is **OS Explorer (1:25k)**, **Freemap stays the
default**, and **Thunderforest stays** (so layers name their key with
`needsKey: 'tf' | 'os'`). For question 3: **stay on Freemap** after leaving GB until OS is picked again.

Question 4 reopened and answered 2026-10-23: **Thunderforest goes.** With OS in
for Great Britain and Freemap keyless everywhere else, it was a keyed layer that
beat neither — so the layer, the key field and `LayerKey`'s `'tf'` are gone, and
`needsKey` now only ever means the OS key. OpenStreetMap stayed in `BASE_LAYERS`
but left the Map panel (`hidden: true`): it is reached only by bailing out of a
failing layer. That split the one fallback constant in two — `DEFAULT_LAYER_ID`
(Freemap: fresh install, outside GB, a chosen layer that cannot be used) and
`FALLBACK_LAYER_ID` (OpenStreetMap: tiles actually failing).

1. **Name in the Map panel:** "OS Explorer (1:25k)" or "OS Leisure"?
2. **Default layer:** stay on Freemap, or make OS the default once your key is
   in?
3. **Coming back into GB:** switch back automatically (planned), or stay on
   Freemap until you pick OS again?
4. **Thunderforest:** with Freemap and OS both in, is the Thunderforest layer
   and its key field still earning its place? Removing it would simplify the
   Settings panel and the key logic above.
