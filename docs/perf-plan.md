# Trailhead performance plan

Written 2026-09-13 by the reviewing agent (Fable) after a read of the whole
codebase with startup speed and in-walk lag in mind. Implementation is split into
work packages (PP1–PP5) for Opus agents. Each PP is self-contained: read this
file, read the files it names, do the work, verify, open a PR against `main`.
Do them in order — PP1 and PP2 are where nearly all of the felt improvement is.

Nothing here adds a dependency, a framework, or a build step beyond what Vite
already does. The app must keep working offline exactly as it does now.

---

## 1. Where the time actually goes

Measured by reading, not profiling — a phone profile is PP5's job. The build is
already lean: one 282 KB JS bundle (about 150 KB of it Leaflet), 38 KB CSS, the
QR decoder split into its own lazy chunk. The startup cost is not bundle size.
It is what the app *does* after the bundle runs:

1. **The map opens on the whole UK at zoom 6, then jumps.** `src/map/map.ts`
   sets a fixed UK view, then waits for `getCurrentPosition` (up to 10 s; a few
   seconds on a cold iPhone) before `setView(..., 15)`. Every launch therefore
   downloads a screen of zoom-6 tiles nobody wants, shows them for seconds, then
   downloads the real ones. This is the single biggest "the app is slow to
   start" cause, and it is entirely self-inflicted.
2. **The first tile request cannot start until the JS has parsed and run.** The
   tile host (`outdoor.tiles.freemap.sk`) and the router (`brouter.de`) need DNS,
   TCP and TLS before the first byte, and nothing in `index.html` warms them.
3. **After a deploy, the next-but-one launch is slow online and dead offline.**
   `public/sw.js` refreshes only `index.html` in the background; the hashed
   `assets/*.js|css` the new page needs are never fetched into the cache, so the
   launch after that goes to the network for them (no instant paint), and
   offline it fails outright. Old bundles are never evicted either, so the
   static cache grows by ~450 KB per deploy forever.
4. **Every GPS fix (about once a second while walking) redoes route-length
   work.** `updateBanner` → `projectOnPolyline` (two passes, two small array
   allocations per vertex per pass, one object per segment) → `updateRouteCard`
   → `remainingText` (a fresh `cumulativeDistances` array of N haversines, a
   `coords.slice`, a `computeClimbs`) → and, when the profile is open,
   `renderProfile` rebuilds the whole SVG from scratch — N more haversines, a
   string of thousands of points, four new listeners. On a long route on an
   older phone this is the "lag while following" people feel.
5. **Startup parses every saved route before the map exists.** `main.ts` calls
   `loadRoutes()` (every route's full coordinate list) before `initMap`, and
   `features/pins.ts` parses pins at import time. Only the active route is
   needed to paint; the saved list is not needed until the Saved tab opens.
6. **Small eager weight that could be lazy.** `qrcode-generator` (~20 KB
   minified) is imported at the top of `features/sharing.ts` though it is only
   used when the Share panel opens. The GPX parser and the legend HTML are also
   startup imports for on-demand features.

Not problems, checked and left alone: the five `invalidateSize` timers in
`watchViewport` (Leaflet returns early when the size has not changed);
`keepBuffer: 6` (retains loaded tiles, does not request more); the inline SVG
sprite; the render-blocking CSS (38 KB, one file, fine).

---

## 2. Work packages for Opus agents

Conventions for every PP:

- **Verify before you build.** This plan was written by reading the code, not
  by profiling a phone. So the first step of every PP is to confirm the problem
  is real and worth fixing: reproduce it (Browser pane against `npm run
  preview`, a console timing, a test that shows the cost — whatever fits) and
  write the evidence at the top of the PR description. If the evidence says the
  problem is smaller than this file claims, say so and scale the work down; if
  it says there is no problem, stop, open no PR, and report back with the
  evidence instead. A PP is a hypothesis, not an order.
- **Prove the fix breaks nothing.** After the change: `npm test` passes; the
  app is exercised end to end in the Browser pane (open, locate, load a saved
  route, open the profile, plan a route, open each sheet, switch theme) with no
  console errors; and anything the PP names as a behaviour that must survive
  is checked explicitly and listed in the PR as checked. A PP that touches
  offline behaviour is also tested in airplane mode on a built app.
- Branch from `main`, one PR per PP, PR title in plain English.
- `npm test` must pass; add tests where a PP says so.
- Keep the module boundaries the code already has (see the header comment of
  each file). Do not move logic between modules to make a PP easier.
- The project has real users on iOS PWA. Anything touching `sw.js` must bump
  the cache version and be tested by installing a build, deploying a change,
  and launching twice — once online, once in airplane mode.
- Write the "why" in comments the way the rest of the codebase does; the next
  reader is a person who did not see this plan.

### PP1 — Open the map where you left it

**Goal:** the first tiles you see are the right ones. No UK view, no jump.

Files: `src/map/map.ts`, `src/state.ts`, `src/main.ts`, `src/state.test.ts`.

1. Add `loadLastView()` / `saveLastView({ center, zoom })` to `src/state.ts`
   under a new key `trailhead.lastView`, following the pattern of
   `loadActiveRoute`. Validate on read (finite numbers, zoom within 2–20);
   return `null` otherwise. Unit-test both.
2. In `map/map.ts`, initialise the map at `loadLastView() ?? UK_FALLBACK_VIEW`.
   Save the view on `moveend`, debounced to about 500 ms, and only when the
   move was not the startup recentre (a flag set around the `setView` in
   `recentreOnStartup`, or simply save unconditionally — either is acceptable;
   pick one and say why in a comment).
3. Keep `recentreOnStartup`, but make it *conditional*: if a saved view exists
   and the saved centre is within about 30 km of the fix, do nothing — the map
   is already showing the right area at the user's chosen zoom. If it is
   further away (a new trip), recentre as now. The `userTouchedMap` guard stays.
4. Because `initTracking` already recentres on the first watch fix when
   following, check that PP1 does not produce a double jump: the startup
   one-shot and the watch's first fix must not both `setView`. The simplest
   rule: the one-shot recentres only when no saved view exists; otherwise the
   watch's first fix (which zooms to 15 with `zoomInOnNextFix`) is the only
   move. Write down the rule in `map.ts` next to `STARTUP_LOCATION_ZOOM`.
5. Verify in the Browser pane with a saved view in localStorage: no zoom-6
   tiles are requested on load (`read_network_requests` filtered on
   `freemap.sk` should show only one zoom level).

### PP2 — Fix the service worker's post-deploy behaviour

**Goal:** every launch after a deploy paints instantly from cache and works
offline; the static cache stops growing.

Files: `public/sw.js`, `README.md` (the "cached older one" note near line 281).

1. In the `navigate` handler's background refresh, after storing the fresh
   `index.html`, parse it for same-origin `./assets/...` references (`src=` and
   `href=` on `<script>` and `<link rel="stylesheet">`/`modulepreload`), fetch
   each, and `cache.put` the ones that return `ok`. Only then consider the
   refresh complete (it is already inside `event.waitUntil`).
2. After a successful refresh, delete cached `assets/*` entries not referenced
   by the new `index.html`. Never delete `index.html`, `./`, the manifest or
   the icons.
3. Hold the static cache open the way the tile cache is (`staticCachePromise`),
   so the per-asset path does not reopen it on every request.
4. Bump `STATIC_CACHE` to `trailhead-static-v2` with a one-line comment saying
   why, matching the style of the `TILE_CACHE` comments.
5. Do not touch the tile branch or the BRouter exclusion.
6. Test by hand as described in the conventions above; write what you did in
   the PR description. There is no automated test for the SW in this repo and
   you do not need to add one.

### PP3 — Make a GPS fix cheap

**Goal:** following a route costs roughly constant work per fix, not
route-length work; the profile updates in place instead of being rebuilt.

Files: `src/geo.ts`, `src/features/tracking.ts`, `src/ui/routeCard.ts`,
`src/elevation.ts`, `src/main.ts`, the matching `*.test.ts` files.

1. **Per-route precomputation.** When a route becomes active (`setActiveRoute`
   in `main.ts`), compute once and keep beside it: cumulative distances
   (`cumulativeDistances`), and a suffix table of remaining ascent/descent so
   `remainingText` becomes a lookup at `prog.index` rather than `slice` +
   `computeClimbs`. The natural home is a small `RouteMetrics` object built by
   a pure function in `geo.ts` (test it), handed to tracking through the
   existing `getActiveRoute` getter's neighbour (add `getRouteMetrics`, or
   attach metrics to the route object under a non-persisted field — choose the
   one that keeps `SavedRoute`'s stored shape unchanged).
2. **Allocation-free projection.** Rewrite `projectOnPolyline` so it does not
   allocate per vertex: project into scalar `x`/`y` locals, and merge the two
   passes into one that tracks the nearest distance and, in a second cheap
   pass over segment *indices* only when a tie exists, resolves the hint. The
   existing tests in `geo.test.ts` must keep passing unchanged; add a test that
   a 20 000-point line projects in well under a millisecond in node (a loose
   bound, so CI never flakes — the point is to catch a regression to the old
   shape, not to benchmark).
3. **Profile updated in place.** Split `renderProfile` into a static draw
   (called when the route or the container width changes) and a
   `moveHere(positionM)` that only moves the blue "you are here" line and
   circle. `updateRouteCard` should call the static draw only when
   `scrubCoords !== src.coords` or on resize, and `moveHere` otherwise. The
   pointer/scrub behaviour, including the iOS mid-drag rebuild case documented
   in `elevation.ts`, must survive — read that comment before touching it.
4. **One render per event.** `setActiveRoute` calls `updateRouteCard()` and
   then `updateBanner()`, which calls it again. Remove the direct call and let
   `updateBanner` be the one renderer. `publishCardLift` is also triggered by
   the `ResizeObserver`; keep the observer and drop the explicit call at the
   end of `updateRouteCard` if the observer covers it (verify it does when the
   card's height does not change — if not, keep the call and say so).

### PP4 — Defer startup work that the first paint does not need

**Goal:** nothing runs before the map is on screen that the map does not need.

Files: `src/main.ts`, `src/features/pins.ts`, `src/features/sharing.ts`,
`src/ui/panels.ts`, `index.html`.

1. In `index.html`, add `<link rel="preconnect" href="https://outdoor.tiles.freemap.sk">`
   and `<link rel="dns-prefetch" href="https://brouter.de">` in the head. Do not
   preconnect to Thunderforest or OSM by default — they are only used when
   chosen, and a preconnect to an unused host is wasted battery.
2. In `main.ts`, move `initMap` to run before `loadRoutes()`. Make `routes`
   lazy: a `getRoutes()` that parses on first call, with `saveRoute`,
   `deleteRoute` and `initPanels`' `getRoutes` all going through it. The
   active route still restores at startup as now (that one parse is needed).
3. In `features/pins.ts`, move `loadPins()` from module scope into `initPins`
   and schedule the marker render with `requestIdleCallback` (fallback
   `setTimeout(…, 0)`) so pins appear a frame after the map does rather than
   before it. `getPins()` must still return the loaded list if called before
   the idle callback ran (load synchronously on first call, render later).
4. In `features/sharing.ts`, turn the top-level `import qrcode from
   'qrcode-generator'` into a dynamic `await import('qrcode-generator')` inside
   the function that builds the QR, mirroring how `features/qr.ts` loads jsQR.
   Vite will split it into its own chunk; confirm in `dist/assets` after
   `npm run build`.
5. Do not lazy-load the GPX parser or the legend: both are tiny once minified
   and the extra chunk request on a hill is worse than the bytes. Say so in a
   comment only if you were tempted.

### PP5 — Measure, and write it down

**Goal:** a before/after number, and a section in the README so the next
person knows what was done and how to check it.

Files: `README.md`, `docs/perf-plan.md` (this file — add a "§3 As built"
section, like the redesign plan's §8).

1. Using the Browser pane against `npm run preview` (a production build, so
   the service worker is live), record for a cold launch with a saved view:
   time to first tile response, number of tile requests before the map is
   still, and total JS bytes. Do the same against `main` before PP1–PP4 (check
   out the old commit into a worktree). Put the two rows in this file.
2. Profile one minute of simulated fixes on a 10 km route with the profile open
   (call `onFix` in a loop from the console, or drive it from a test) and note
   the per-fix cost before and after PP3.
3. Add a short "Performance" section to the README: what the last-view cache
   is, what the service worker does on a deploy, and how to clear either.

---

## 3. As built (written at the end of PP5)

PP1–PP4 landed as PRs #81, #84, #87 and #89 between 13 and 14 September 2026.
Everything above is the plan as it stood before any of it was written; this
section is what actually happened, so the document and the app agree.

### The numbers

Both columns were measured the same way, on 23 October 2026: a production build
served by `vite preview` in the Browser pane at 375x812, with the service worker
in control, 20 saved routes of 2,000 points each (968 KB of `localStorage`), 50
pins and a saved last view. Geolocation is stubbed by an inline script added to
the *built* `index.html` — a harness, not something in the repo — so that a fix
arrives 2,000 ms after launch in both builds, which is the cold-iPhone case the
plan describes. The tile cache is emptied before each launch; each row is the
median of three.

**Before** is `8f2ecbe`, the commit immediately before PP1 merged. **After** is
`b2c6689`, `main` today.

| A cold launch | Before (`8f2ecbe`) | After (`b2c6689`) |
| --- | --- | --- |
| Tile requests before the map is still | 24 | **12** |
| Zoom levels requested | 2 — 12 at z6, then 12 at z15 | **1 — 12 at z15** |
| First tile requested | 27 ms | **21 ms** |
| Startup script (script arrives to `DOMContentLoaded`) | 21 ms | **10 ms** |
| Startup JS (the entry chunk) | 282 KB, 90 KB gzipped | 292 KB, 95 KB gzipped |

Reading it:

- **Half the tiles, and no wrong ones.** The zoom-6 screenful is gone, which is
  PP1 doing exactly what it was for. On a phone on mobile data that is twelve
  fewer requests and a first screen that is the right place rather than a
  picture of the UK.
- **Half the startup script.** 21 ms to 10 ms, from PP4 leaving the saved routes
  and the pins unparsed. The saved list here is a deliberately large one; with
  three routes saved the gap is a millisecond or two. Expect roughly 4x these
  figures on an older phone.
- **The bytes went up, not down, and that is fine.** Startup JS was never the
  problem (§1 says so) and no PP tried to shrink it. The 10 KB is six weeks of
  features that landed after PP4 — the OS Explorer layer, the redesign, the
  route-card chip. The lazy chunks are not in that figure: jsQR is 131 KB and
  our BRouter profile 29 KB, neither fetched at launch.
- **"Time to first tile *response*" is not in the table**, though PP5 asked for
  it. The Browser pane's own HTTP cache answers tile requests, so any number
  measured there is a measure of that cache rather than of the app. The time to
  first tile *request* is the part the app controls, and it is what is reported.
  The same caveat applies to PP4's `preconnect`: its value is one DNS/TCP/TLS
  handshake on the first uncached tile, which is a property of the network, not
  something this harness can show.

| Per GPS fix, median ms (p95) | Before | After |
| --- | --- | --- |
| 1,000 points, profile closed | 0.7 (1.0) | **0.5 (0.9)** |
| 1,000 points, profile open | 2.0 (3.2) | **0.6 (0.9)** |
| 5,000 points, profile closed | 1.8 (2.4) | **0.7 (1.2)** |
| 5,000 points, profile open | 6.2 (10.2) | **0.9 (1.4)** |

180 fixes fed straight to the watch callback the app registered, walking the
whole route; the first 30 are discarded as warm-up, and a forced layout is
included in each. 1,000 points is a 10 km walk at the spacing BRouter returns;
5,000 is a long day or an unsimplified GPX import. These are desktop numbers — a
phone is several times slower, so the "before" 6.2 ms is the dropped frame every
second that PP3 was written to remove.

The shape matters more than the absolute figures: before, the cost grew with the
length of the route; after, it is close to flat. Following a 50 km imported
track now costs about what following a 10 km one does.

### Where the work differed from the plan

1. **PP2's step 1 was already done** by #83, which merged after this file was
   written: a refresh already fetched the new build's script and stylesheet.
   PP2 did the eviction and the cache-open parts only.
2. **PP2 keeps two builds, not one.** The plan said to delete everything the new
   `index.html` does not name. A launch is served the *old* cached page while
   the refresh runs, and a resumed app keeps running the old build until you tap
   *Update ready*, so either can still ask for its own files. The cap is two
   builds, a few hundred KB.
3. **PP2 also fixed a first install not working offline** — not in the plan,
   found while checking it. On a first visit the install cached only the page
   and the manifest, so an offline relaunch opened a blank app with no map.
4. **PP3 did not build the suffix table.** The 5 m noise rule in `computeClimbs`
   means "climb beyond point i" is not the total minus the climb so far, so an
   exact table costs O(N^2) to build. The step it was meant to replace measured
   0.02 ms. Instead the route's total length is cached once per route, and the
   climb ahead is recomputed only when the walker passes a new route point.
5. **PP3's real win was the profile, not the projection.** Redrawing the chart
   was 5.1 ms of the 6.8; `moveHere` moves the line and the dot and leaves the
   SVG alone. The allocation-free `projectOnPolyline` is about 8x faster on a
   20,000-point line but was only ever 0.74 ms of it.
6. **PP4 was real but smaller than §1 suggested.** It takes about a third off
   the work before the first tile request. On a desktop that is ~5 ms, which
   nobody will feel; on a phone with a long saved list it is tens of ms. Worth
   doing, not worth expecting to see.
7. **PP4 step 4 was deliberately not done.** `qrcode-generator` is still
   imported at the top of `features/sharing.ts`. The service worker precaches
   only what `index.html` names, so a lazy chunk is kept for offline use only
   once it has been fetched online — a lazy encoder would leave Share unable to
   draw a QR code on a hill with no signal, which is the one place showing a
   route to the phone next to you matters. 7.6 KB gzipped is not worth that.
   There is a comment at the import saying so.
8. **PP1's saved view always wins over the startup fix**, rather than only when
   the two agree to within ~30 km. The GPS watch starts in follow mode and its
   first fix recentres you anyway, so the new-trip case is handled without a
   second mover and without a threshold to tune. This is the plan's own step 4
   taken as the rule.

### Still open

- **The QR *scanner*'s decoder (jsQR) has the gap PP4 step 4 describes.**
  Scanning a route QR offline fails unless the scanner has been used online
  since the last deploy. Flagged in #89; it needs `sw.js`, so it is its own
  piece of work.
- **No profile on a real phone.** Everything above is a desktop browser with the
  viewport emulated. The 4x rule of thumb is a rule of thumb.

---

## 4. Calls made on the user's behalf (flag, don't block)

- **Saved view wins over startup geolocation** when they agree to within
  ~30 km. This means the map opens at the zoom you left it, not always at 15.
  That is the behaviour of every maps app and is the point of PP1; if the user
  wants the old "always zoom to 15" it is one line in `recentreOnStartup`.
- **Old bundles are evicted** after a deploy (PP2). A user who has not opened
  the app since two deploys ago still gets the newest cached shell; nothing is
  lost, only disk.
- **Pins render one frame late** (PP4). Visually indistinguishable; noted so
  nobody files it as a bug.
