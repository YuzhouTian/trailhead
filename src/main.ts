import L from './leaflet-setup';
import './style.css';
import { initOffline } from './features/offline';
import { dismissPinCard, initPins, openSharedPin } from './features/pins';
import { getPlan, initPlanner, isPlanning } from './features/planner';
import { initQr } from './features/qr';
import { hideSearchResults, initSearch } from './features/search';
import { importSharedRoute, initSharing } from './features/sharing';
import {
  beginFollow,
  hereAlongM,
  initTracking,
  isTracking,
  pauseFollow,
  remainingText,
  resetRouteProgress,
  resumeFollow,
  setKnownPosition,
  updateBanner
} from './features/tracking';
import { initMap, map } from './map/map';
import {
  loadActiveRoute,
  loadRoutes,
  loadSettings,
  saveActiveRoute,
  saveRoutes,
  type SavedRoute
} from './state';
import { $ } from './ui/dom';
import {
  hidePanel,
  initPanels,
  openMapPanel,
  openRoutesPanel,
  openSettingsPanel,
  showPanel
} from './ui/panels';
import { initRouteCard, updateRouteCard } from './ui/routeCard';

// ---------------------------------------------------------------- stored state

const settings = loadSettings();
let routes = loadRoutes();

/**
 * Keep a new route. Both ways of acquiring one — planning or importing a GPX
 * (features/planner.ts), and receiving a shared link (features/sharing.ts) —
 * end here, so what "save" means is written down once rather than in each of
 * their init calls. `routes` is reassigned when one is deleted, which is why
 * this closes over the variable rather than being handed the array.
 */
function saveRoute(r: SavedRoute): void {
  routes.push(r);
  saveRoutes(routes);
}

// ---------------------------------------------------------------- theme
// A pre-paint script in index.html already set data-theme from the saved
// choice; this keeps it in sync when the setting changes, and drives the
// browser-chrome colour and live OS-theme following.
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

/** Whether the effective theme resolves to dark (setting + OS preference). */
function themeIsDark(): boolean {
  return settings.theme === 'dark' || (settings.theme === 'system' && darkQuery.matches);
}

function applyTheme(): void {
  const root = document.documentElement;
  if (settings.theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', settings.theme);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', themeIsDark() ? '#0e1310' : '#ffffff');
}

// Following the OS: react live when it flips between light and dark.
darkQuery.addEventListener('change', () => { if (settings.theme === 'system') applyTheme(); });
applyTheme();

// Tiles, viewport and the startup recentre live in map/map.ts; the one-shot
// startup fix goes to tracking, which owns "where we last were".
initMap({ settings, onStartupPosition: setKnownPosition });

// ---------------------------------------------------------------- active route

let activeRoute: SavedRoute | null = null;
let activeLine: L.Polyline | null = null;

function setActiveRoute(r: SavedRoute | null, fit = true, persist = true): void {
  activeRoute = r;
  resetRouteProgress(); // a freshly loaded route reads from its start
  activeLine?.remove();
  activeLine = null;
  if (r) {
    activeLine = L.polyline(r.coords, {
      color: '#c1121f',
      weight: 4,
      opacity: 0.85
    }).addTo(map);
    if (fit) map.fitBounds(activeLine.getBounds(), { padding: [40, 40] });
    // Opening a route means "show me this route". With Me following, the next
    // fix — a second away — recentres on you and the route you just opened
    // slides off the screen, which is what made loading one feel broken. Pause
    // the centring instead: the dot and the off-route banner stay live, which
    // is exactly what you want while sizing up a route you are not on yet.
    if (fit) pauseFollow();
  }
  if (persist) saveActiveRoute(r); // remember it so a hike survives an app reload
  updateRouteCard();
  updateBanner();
}

// ------------------------------------------------- active-route card

// The card itself lives in ui/routeCard.ts and knows nothing about the planner
// or GPS; this gathers what it should show from the two modules that do, plus
// the active route, which is the app's. A sketch in progress wins over the
// active route, and silences the progress readouts — there is no walking a
// route you are still drawing. The "you are here" mark is deliberately
// conservative: hereAlongM() stays null until a fix lands near the line, so the
// dot never appears at a guessed place.
initRouteCard({
  getView: () => {
    const planning = isPlanning();
    return {
      src: planning ? getPlan() : activeRoute,
      name: planning ? 'New route' : activeRoute?.name ?? '',
      planning,
      remaining: planning ? null : remainingText(),
      hereM: planning ? null : hereAlongM(),
      following: isTracking(),
      speedKmh: settings.speedKmh
    };
  },
  onClose: () => setActiveRoute(null),
  onStart: () => {
    // Begin following this route, or re-centre if GPS is already live.
    if (!isTracking()) beginFollow();
    else resumeFollow();
  }
});

// ---------------------------------------------------------------- route planner

// Sketching a route and importing a GPX file both live in features/planner.ts.
// Neither keeps what it makes: a finished route comes back out through these
// callbacks, because the saved list and the active route are the app's.
initPlanner({ settings, saveRoute, setActiveRoute, hidePanel });

// ---------------------------------------------------------------- location + on/off route

// The GPS dot, the Me button's follow/heading-up cycle, the on/off-route banner
// and everything derived from a fix live in features/tracking.ts. The route it
// measures progress against is the app's, so it reads it through a getter.
initTracking({ settings, getActiveRoute: () => activeRoute });

// ---------------------------------------------------------------- saved pins

// The pin cards, the long-press that drops one, and the #p= link that shares
// one all live in features/pins.ts. It needs nothing from here: it reads where
// you are through tracking's accessors and asks the planner whether a
// long-press means "identify this spot" or "you are drawing a route".
initPins();

// ---------------------------------------------------------------- search + nearby

// The search box and "What's nearby" share a module: both start from the same
// "where are we looking?" (the live fix, else the map centre), both drop
// markers with the same popup, and both pause following. The Map and Settings
// panels drive nearby, so it exposes state rather than owning a control.
initSearch({ settings });

// ---------------------------------------------------------------- sharing + QR

// Both ends of the #r= link live in features/sharing.ts — writing one as a QR
// and a URL, and reading one back from a paste, a scan or the address bar. Like
// the planner, a received route leaves through these callbacks rather than
// being kept there. features/qr.ts is the camera half, split off because it is
// a different job with different failures and a decoder chunk most people never
// download; it knows only enough to recognise a link and hand it over.
initSharing({ settings, saveRoute, setActiveRoute, showPanel, hidePanel });
initQr({ hidePanel });

// ---------------------------------------------------------------- panels

// The panel shell and the Map/Settings/Routes screens live in ui/panels.ts.
// Every row in them calls into the feature that owns the behaviour, so it was
// extracted last. What it can't get by importing is the saved-routes list,
// which is reassigned on delete, and the theme, which is bootstrap.
initPanels({
  settings,
  getRoutes: () => routes,
  deleteRoute: (r) => {
    if (!confirm(`Delete “${r.name}”?`)) return false;
    routes = routes.filter((x) => x.id !== r.id);
    saveRoutes(routes);
    if (activeRoute?.id === r.id) setActiveRoute(null);
    return true;
  },
  setActiveRoute,
  applyTheme
});

// ---------------------------------------------------------------- navigation

$('btnMap').addEventListener('click', openMapPanel);
$('btnSettings').addEventListener('click', openSettingsPanel);
$('btnRoutes').addEventListener('click', openRoutesPanel);
map.on('click', () => {
  hidePanel();
  hideSearchResults();
  dismissPinCard(); // a no-op when a long-press only just opened it
});

// Bring back the route we were on before a reload (drawn, not re-zoomed — the
// startup geolocation centres you near it). A shared link below overrides it.
const restoredRoute = loadActiveRoute();
if (restoredRoute) setActiveRoute(restoredRoute, false);

importSharedRoute();
openSharedPin();

// ---------------------------------------------------------------- offline tiles

// Down here with the service worker rather than up with the other inits: the
// download only works once the SW is controlling the page, and the two are one
// story. Ordering is not what keeps it here — nothing else listens to
// #rcOffline, and the route arrives as a getter — so it is safe to move if the
// grouping ever stops earning its place.
initOffline({ settings, getActiveRoute: () => activeRoute });

// ---------------------------------------------------------------- service worker

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}
