# Trailhead visual redesign — the plan

Written 2026-09-11 by the orchestrating designer (Fable). Implementation is split
into work packages (WP1–WP5) for Opus agents. Each WP is self-contained: read
this file, read the files it names, do the work, verify, open a PR.

The design canvas with the target look (light, OLED dark, pin card, settings
sheet, token sheet) is the visual reference. Where this file and the canvas
disagree, this file wins — the canvas is a mockup, the numbers here are the spec.

---

## 1. Direction in one paragraph

**A field instrument, not a web page.** Trailhead is read one-handed on a slope,
often in sunlight, often in dark mode during the day. The new look keeps the
identity green but everything else gets quieter and sharper: one accent, one
radius scale, one type ramp with tabular numerals, hairlines instead of drop
shadows, floating cards that sit *on* the map rather than strips bolted to the
screen edge, and a dark theme that is true black so an OLED phone spends no
power lighting the chrome and the map is the only bright thing on screen.

What we are deliberately **not** doing: no web font (offline PWA, system font is
the right call — SF on iOS is already the most modern face available), no
framework, no new dependencies, no dimming of the map in dark mode (settled
decision), no `rem` (settled decision — `text-size-adjust` is pinned).

## 2. Tokens (the spec — WP1 implements these verbatim)

All in `src/style.css`, replacing the existing `:root` blocks. Components keep
referencing tokens, never raw hex. Names kept where they already exist so the
diff in components is small; new names added where a distinction was missing.

### 2.1 Colour — light (bare `:root`)

| Token | Value | Use |
| --- | --- | --- |
| `--bg` | `#ffffff` | page ground, docked bars |
| `--surface` | `#ffffff` | floating cards, sheets, search |
| `--surface-2` | `#f2f4f2` | inset fields, chips, grouped cells, secondary buttons (replaces `--chip`) |
| `--ink` | `#121714` | primary text |
| `--ink-2` | `#4b5450` | secondary text (stats lines, sub rows) |
| `--muted` | `#727c77` | tertiary: placeholders, inactive icons, captions |
| `--hairline` | `rgba(18,23,20,.10)` | all borders and dividers (replaces `--line`) |
| `--brand` | `#1b7f57` | oklch(53% 0.12 158). Active tab, primary buttons, route-ish accents |
| `--brand-strong` | `#15654a` | pressed / active primary |
| `--brand-soft` | `#e3f1e9` | tinted backgrounds behind brand icons (replaces `--accent-soft`) |
| `--on-brand` | `#ffffff` | text on brand fills (replaces `--on-accent`) |
| `--danger` | `#d8303c` | oklch(58% 0.20 25). Off-route, delete |
| `--danger-soft` | `#fbe9ea` | tinted danger backgrounds |
| `--notice` | `#b0630f` | arrival banner, "no fix" |
| `--on-notice` | `#ffffff` | |
| `--map-gap` | `#c9d1ca` | behind tiles while loading |
| `--scrim` | `rgba(0,0,0,.35)` | behind a sheet |
| `--shadow-card` | `0 8px 24px rgba(18,23,20,.14), 0 1px 2px rgba(18,23,20,.08)` | floating cards in light |
| `--shadow-fab` | `0 4px 14px rgba(18,23,20,.22)` | the Me button |

Map symbology (unchanged, theme-independent): `--poi-disc #ffffff`,
`--poi-glyph #121714`, GPS blue `#1a73e8`, route red `#d8303c` (was `#c1121f`
— update the three literal uses in `main.ts`, `routeCard.ts`, `planner.ts` is
`#1a73e8` and stays).

### 2.2 Colour — dark, OLED (both the `prefers-color-scheme` block and `[data-theme="dark"]`)

| Token | Value | Notes |
| --- | --- | --- |
| `--bg` | `#000000` | true black. Bottom bar, plan bar, sheets, html/body |
| `--surface` | `#000000` | floating cards are black too — they sit over a bright map, black is the contrast |
| `--surface-2` | `#141614` | grouped cells, chips, inset fields — the *only* raised grey |
| `--ink` | `#ececea` | not pure white: less halation on OLED, still 17:1 |
| `--ink-2` | `#a8b0ab` | |
| `--muted` | `#7d857f` | |
| `--hairline` | `rgba(255,255,255,.13)` | borders replace shadows in dark |
| `--brand` | `#4fd396` | oklch(78% 0.15 158) — lifted for legibility on black |
| `--brand-strong` | `#37b87e` | |
| `--brand-soft` | `#0d2a1c` | |
| `--on-brand` | `#00150b` | dark text on the lifted green |
| `--danger` | `#ff5a64` | |
| `--danger-soft` | `#2a0f12` | |
| `--notice` | `#f0a850` | |
| `--on-notice` | `#1a1000` | |
| `--map-gap` | `#161816` | |
| `--scrim` | `rgba(0,0,0,.6)` | |
| `--shadow-card` | `none` | shadows vanish on black; the hairline does the job |
| `--shadow-fab` | `0 2px 12px rgba(0,0,0,.7)` | the one exception: the FAB floats over tiles |

Rules for OLED: no large mid-grey panels (a `#161d19` sheet is the old look —
the sheet is black, the *rows* inside it are `--surface-2`). Text never pure
white. Dividers are hairlines at 13% white, not 1px greys.

Also update: `index.html` `<meta name="theme-color">` default and the two
values in `main.ts applyTheme()` → `#ffffff` / `#000000`;
`public/manifest.webmanifest` `background_color` → `#ffffff`, `theme_color` →
`#1b7f57`.

### 2.3 Type ramp (px, deliberately — see the existing comment)

Family stays `-apple-system, system-ui, "Segoe UI Variable", sans-serif`.
Every text style is one of these six; nothing else picks its own size.

| Token | Size / line | Weight | Extra | Use |
| --- | --- | --- | --- | --- |
| `--t-caption` | 12 / 16 | 500 | | captions, units, hints, tab labels, attribution |
| `--t-eyebrow` | 12 / 16 | 700 | `letter-spacing:.08em; text-transform:uppercase` | "WHAT'S HERE", key group headings |
| `--t-body` | 14 / 20 | 500 | | secondary text, stats lines, key rows |
| `--t-ui` | 16 / 22 | 600 | | anything tapped, search, inputs, buttons, list names |
| `--t-title` | 18 / 24 | 700 | `letter-spacing:-.01em` | card/sheet titles |
| `--t-display` | 24 / 28 | 700 | `letter-spacing:-.02em` | remaining distance while following |
| `--t-mono` | 22 / 26 | 700 | `ui-monospace, "SF Mono", Menlo, monospace; letter-spacing:.02em` | the grid reference |

Implement as `--fs-*`/`--lh-*` pairs or as `font:` shorthand custom properties —
agent's call, but **every numeric readout gets `font-variant-numeric:
tabular-nums`** (stats, remaining, chart labels, grid ref, scale bar) so
numbers don't jitter as a fix updates them.

Mapping from the old scale: meta 11→12, body 13→14, ui 15→16, title 17→18,
read 20→22 (mono). Everything moves up one notch — the old scale was a touch
small for a phone held at arm's length.

### 2.4 Shape

| Token | Value | Use |
| --- | --- | --- |
| `--r-sm` | `10px` | inputs, small square buttons (36px icon buttons) |
| `--r-md` | `14px` | buttons, segmented control, list cells |
| `--r-lg` | `20px` | floating cards, sheets (top corners), search results |
| `--r-pill` | `999px` | search bar, status banner, chips, toast, FAB |

Replace every literal `border-radius` in `style.css` with one of these. The
current file has 6, 8, 10, 11, 12, 16, 18, 20, 22, 24 — that inconsistency is a
big part of "looks dated".

Spacing is a 4px grid: 4 / 8 / 12 / 16 / 20 / 24. Screen inset for floating
things is 12px (cards, search, FAB).

Control heights: text buttons 48px (primary) / 44px (secondary in lists);
icon-only buttons 40×40 min (36 is allowed inside the route card header only);
FAB 52px; tab bar 56px + safe area; search 48px; chips 36px.
Nothing tappable under 44px in either dimension unless it is a 40px icon button.

## 3. Icons (WP2)

Keep the inline sprite approach (`index.html` `<symbol>` + `svgUse()`), redraw
the set to one grammar:

- 24×24 grid, **2px stroke, round caps and joins**, `fill:none`, 1.5px optical
  inset from the edge (nothing touches 0 or 24), no sub-pixel path coordinates
  where avoidable. Current `.gico` rule already does most of this; the icons
  themselves are what change.
- **Active tab = duotone**: add `#bottomBar button.active .gico { fill:
  currentColor; fill-opacity: .18 }` — filled-tint active icons are the modern
  tab-bar idiom and cost no extra symbols. Same for `#btnLocate.active`.
- Replace text glyph close buttons (`&times;` in `#searchClear`, `#rcClose`,
  `.pc-close`, `.closeX`, and the `✕` on delete buttons) with an `#i-close`
  symbol (`M6 6l12 12M18 6 6 18`), 20px, inside a 40px hit area.
- **Nearby-point categories** (`src/poi.ts` `icon` field) currently hold
  Unicode/emoji (`▲ △ ◉ 💧 ≋ ⌂ ⛺ ☕ 🚻 P 🚌 🧺 ★ ∩`). These render
  differently on every OS and are the single most dated element. Give every
  category an SVG symbol id (`p-summit`, `p-trig`, `p-viewpoint`, `p-water`,
  `p-waterfall`, `p-shelter`, `p-camp`, `p-cafe`, `p-toilets`, `p-parking`,
  `p-bus`, `p-picnic`, `p-star`, `p-cave` — match to the real table) and
  render them with `svgUse()`. Touch points: `features/search.ts` (marker
  html + popup), `ui/panels.ts` (`.poiSwatch`), `legend.ts` (the `mine()`
  swatch and the nearby section). The pin categories in `features/pins.ts`
  already use symbols (`c-*`); redraw those in the same grammar.
- Nearby marker becomes a **filled category-colour disc, 26px, white glyph,
  1.5px white outer ring + shadow** — reads on any tile and is instantly
  distinct from a *saved* pin (white disc, brand ring, brand glyph, 28px).
  Keep `--poi-disc/--poi-glyph` tokens for the saved pin; the nearby disc
  uses the category colour from the table.
- Redraw list (all in `index.html`): `i-map` (three-fold map, Lucide-style),
  `i-routes` (two nodes + curved path, cleaner geometry), `i-plan` (pen),
  `i-settings` (two horizontal sliders), `i-locate` / `i-locate-on`,
  `i-compass`, `i-elev`, `i-download`, `i-magnet`, `i-search`, `i-sun`,
  `i-moon`, `i-auto`, `i-save`, `i-trash`, `i-copy`, `i-share`, `i-pin`
  (filled teardrop stays), new `i-close`, new `i-chevron-right`, new
  `i-check`. The design canvas' Tokens artboard shows the target drawings —
  copy the paths from it.

## 4. Components (WP3) — what each one becomes

Read the canvas artboards *RouteLight*, *RouteDark*, *PinDark*. Summary:

- **Search**: 48px pill, `--surface`, hairline border, `--shadow-card` in light /
  none in dark, 12px screen inset, icon 20px `--muted`, placeholder `--muted`.
  Results: `--r-lg`, rows 52px min, name `--t-ui`, detail `--t-caption`.
- **Bottom tab bar**: stays docked in the safe-area strip (settled). Drop the
  top shadow; a hairline top border only. `--bg`. Icons 24px, labels
  `--t-caption` 600. Active: `--brand` + duotone fill. Inactive: `--muted`.
- **Me button (FAB)**: 52px, `--surface`, `--shadow-fab`, hairline in dark.
  Active `--brand` duotone; failed `--notice`.
- **Active route card**: stops being an edge-to-edge strip with a `border-top`.
  It becomes a **floating card**: 12px inset, `--r-lg`, `--surface`, hairline,
  `--shadow-card`, sits 8px above the tab bar. Name `--t-ui` 700 → title row;
  stats `--t-body` `--ink-2` tabular; remaining `--t-display` `--brand`
  tabular. Header icon buttons 36px `--r-sm` `--surface-2`; the chart-open
  state `--brand`/`--on-brand`. `publishCardLift()` measures the card so the
  lift keeps working — check the +12px fudge still clears the new inset.
- **Elevation chart** (`src/elevation.ts`): the SVG has literal `#eee`, `#ddd`,
  `#888`, `#2d6a4f22`, `#2d6a4f`, `#c1121f` — in dark mode today the
  gridlines are near-white. Make them tokens: gridlines `var(--hairline)`,
  labels `var(--muted)` 12px tabular, line `var(--brand)` 2px, area a vertical
  `linearGradient` brand 22% → 0%, scrubber `var(--danger)`, here-marker GPS
  blue (literal, symbology). Height 110 → 120.
- **Pin card**: already the closest to the target. Eyebrow `--t-eyebrow`
  `--muted`; grid ref `--t-mono`; facts `--t-body` 600 with 16px brand icons;
  name field `--surface-2` no border `--r-md` 48px; chips 36px pill
  `--surface-2` no border, selected `--brand`; actions 48px `--r-md`; delete
  is a 48px square `--danger-soft` bg + `--danger` icon (no inset ring).
- **Status banner**: pill, `--t-ui`, 40px, `--shadow-card`.
- **Plan bar**: `--bg`, hairline top, stats `--t-ui` tabular, buttons 48px
  `--r-md`, magnet toggle 48×48.
- **Toast**: `--r-pill`, `--ink` bg / `--bg` text in light; `--surface-2` bg +
  hairline / `--ink` text in dark.
- **Panel contents** (settings, map, saved, share): rows become **grouped
  cells** — a `--surface-2` block with `--r-md`, hairline dividers between
  rows, 48px rows, `--t-ui` labels, `--t-caption` hints under a group not
  inside it. Section titles `--t-eyebrow` `--muted` above each group (drop
  the `<hr>`s). Buttons full-width 48px. Segmented theme control: `--surface-2`
  track `--r-md` 4px pad, selected segment `--surface` (light) / `#222` (dark)
  with `--shadow-card`/hairline and `--ink` text — the iOS idiom, not a green
  fill. Inputs 48px `--surface-2` `--r-sm` no border, focus ring 2px `--brand`.
  Saved list: cell per route, name `--t-ui`, sub `--t-caption`, action row of
  44px buttons; delete = icon button `--danger` on `--danger-soft`.
- **Leaflet furniture**: attribution + scale bar use `--surface` at 82% (keep),
  `--t-caption`, tabular. Popups `--r-md`, hairline.
- **QR scanner / full-screen QR**: unchanged (functional, deliberately literal).

## 5. Structure (WP4) — the drawer becomes a bottom sheet

The left slide-in `#panel` (`width:min(320px,85vw)`, drop shadow) is a
desktop pattern. Replace with a **bottom sheet**: full width, `--bg`,
`--r-lg` top corners, 6×40px grabber (`--hairline` at 100% opacity), scrim
behind, `max-height: 88vh`, scrolls inside, safe-area padding at the foot.
Close = tap scrim, the close icon, or the same tab again. Keep every element
id and class the TS reads (`#panel`, `#panelContent`, `#panelClose`, `.row`,
`.hint`, `.routeItem`, `.themeSeg`, all the `id`s `panels.ts` and `sharing.ts`
query). `showPanel()`/`hidePanel()` API unchanged. On `min-width: 700px` the
sheet may become a centred 480px sheet — optional.

This is the only structural change and it is last because it touches layout
that three modules depend on. If it turns out to fight the route card or the
plan bar, ship WP1–3 and raise it rather than forcing it.

## 6. Work packages for Opus agents

General rules for every WP (put these in each agent's brief verbatim):

- Repo: `C:\Users\Yuzhou\Desktop\Claude Code\trailhead`. Read this file first,
  then the files named in your WP. Read `~/.claude/agents/trailhead.md` for
  the platform gotchas (browser pane runs hidden: CSS transitions never
  advance, `screenshot` times out — verify with `read_page` / JS eval).
- Branch from `main`: `redesign/wp<N>-<slug>`. One PR per WP, plain-English
  description (the user is not a programmer). Commit trailer
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Before the PR: `npm test` and `npm run build` pass; start the dev server
  with `preview_start {name: "trailhead"}` and check both themes by toggling
  `document.documentElement.dataset.theme` and reading computed styles.
- Do not touch routing, tracking, storage, or any logic. Do not change
  element ids or class names the TypeScript reads. Do not add dependencies or
  web fonts. Do not dim the map. Do not use `rem`.
- Comments in this repo explain *why* in plain English — match that when you
  add or rewrite one. Keep the existing explanatory comments that still apply.
- WCAG AA: every text/background pair ≥ 4.5:1 (≥ 3:1 for 18px+ bold and for
  icons). Check the pairs you introduce with a contrast calculation in your
  report.
- Report back: what changed, what you verified, anything in this plan that
  did not survive contact with the code.

### WP1 — Foundation: tokens, type ramp, shape, OLED dark
**Files**: `src/style.css` (token blocks + every `border-radius`/`font-size`
literal), `index.html` (theme-color meta), `src/main.ts` (`applyTheme`
colours), `public/manifest.webmanifest`, `src/elevation.ts` (chart colours →
tokens; gradient fill), the three literal route-red uses.
**Do**: implement §2 exactly; add the new tokens, rename `--chip`→`--surface-2`,
`--line`→`--hairline`, `--accent-soft`→`--brand-soft`, `--on-accent`→`--on-brand`
across the file; convert the five `--fs-*` to the six-step ramp and re-point
every use; add `tabular-nums` where numbers live; replace every literal radius
with `--r-*`. Keep component *layout* as is — this WP changes values, not
shapes of components (that is WP3), but a radius swap and a hairline for a
shadow in dark are in scope.
**Done when**: dark mode is true black chrome over an undimmed map, no literal
colours or radii remain in `style.css` except the symbology block and the QR
screens, chart reads correctly in dark, `npm test` green.

### WP2 — Icon set
**Files**: `index.html` (sprite), `src/poi.ts` (`icon` → symbol id),
`src/features/search.ts`, `src/features/pins.ts`, `src/ui/panels.ts`,
`src/legend.ts`, `src/ui/dom.ts` (if `svgUse` needs a size variant),
`src/style.css` (`.poiMarker`, `.savedPin`, duotone active rule, close buttons).
**Do**: §3. Redraw every symbol; add `i-close`, `i-chevron-right`, `i-check`;
convert POI categories to SVG and restyle the nearby marker; replace every
text-glyph close/delete with the icon inside a 40px hit area; add the duotone
active rule. Any test that asserts on a category `icon` string needs updating
(check `poi.test.ts`, `legend` usage).
**Done when**: no emoji/Unicode glyph is used as an icon anywhere; the map key's
"nearby" swatches are drawn from the same symbols as the markers.
Can run in parallel with WP1 (touches the sprite and TS, not the token block;
coordinate on `style.css` by keeping WP2's CSS edits to the marker/close rules).

### WP3 — Component restyle
**Depends on**: WP1 merged (WP2 preferably).
**Files**: `src/style.css` (most of it), `index.html` (route card / search
markup if a wrapper is needed), `src/ui/panels.ts`, `src/features/sharing.ts`,
`src/features/pins.ts` (markup only: grouped cells, eyebrows, button classes),
`src/ui/routeCard.ts` (`publishCardLift` fudge).
**Do**: §4, component by component, checking each against the canvas. Panel
contents become grouped cells now even though the container is still the
drawer (WP4 swaps the container). Remove inline `style="flex:1"` and the
inline font-size/line-height strings in `search.ts`, `tracking.ts`,
`sharing.ts` popups in favour of classes.
**Done when**: every screen in the canvas is matched in both themes; the
`--card-lift` still clears the floating card; hit-target audit (§2.4 heights)
passes — list every tappable element and its size in the report.

### WP4 — Bottom sheet
**Depends on**: WP3.
**Files**: `src/style.css` (`#panel*`), `src/ui/panels.ts` (`showPanel`/
`hidePanel` add the scrim + grabber; a tap on the scrim closes), `index.html`
(scrim element), `src/main.ts` only if tab-toggling needs a hook.
**Do**: §5. **Done when**: every panel opens as a sheet, scrolls inside, closes
three ways, the route card and plan bar are unaffected, safe-area respected.

### WP5 — Audit and screenshots
**Depends on**: WP1–4.
**Do**: full pass with a contrast table for both themes; hit-target table;
check on a real iPhone via the deployed site if the user can (ask in the PR);
regenerate `docs/screenshot-route.png` and `docs/screenshot-pin.png` at
390-wide in **dark** mode (the new look's showcase) and update the README
alt text; add a short "Design" section to the README naming the token file
and the ramp so future changes stay on it.

## 7. Open calls made on the user's behalf (flag, don't block)

1. System font, no webfont — chosen for offline weight and because SF/Segoe
   are already the modern faces. Reversible later: a single `font-family` token.
2. The tab bar stays docked (settled decision); it is restyled, not floated.
3. Floating cards are black in OLED dark, not dark grey — relies on the map
   being bright underneath, which it always is (no dim).
4. The drawer → sheet change (WP4) is the one thing that changes how the app
   is *used*; it is last and can be dropped without unpicking the rest.
5. Type moves up one notch across the board. If it feels big on a 390px phone,
   the one place to argue is `--t-ui` 16→15; keep the rest.
