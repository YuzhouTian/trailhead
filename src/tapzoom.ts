import L from 'leaflet';

/**
 * One-finger zoom, the Google Maps gesture: tap, then tap again and keep the
 * finger down — sliding down zooms in, sliding up zooms out, continuously and
 * anchored on the point you tapped. Pinch wants a second hand, which is the one
 * thing you haven't got while holding poles, a dog lead, or a phone in gloves.
 *
 * Leaflet has no such handler, and no public API for a zoom that tracks a
 * finger: setZoomAround rounds to whole levels (zoomSnap) and redraws every
 * layer per frame. So this drives the same internals Leaflet's own pinch-zoom
 * handler does — one _move per animation frame, then a single _resetView to
 * settle and fetch tiles.
 */

// A second tap counts as a double tap if it lands this soon after the first
// lifted, and this close to where it landed.
const DOUBLE_TAP_MS = 300;
const TAP_SLOP_PX = 30;
// A first touch that lingers is a long-press (drop a pin), not a tap.
const TAP_MAX_MS = 250;
// Vertical travel before a held second tap is a zoom rather than a hold.
const DRAG_SLOP_PX = 10;
// Travel for one whole zoom level — about six levels down a phone screen.
const PX_PER_ZOOM = 140;
// Down is in, matching Google Maps. Flip the sign to invert the gesture.
const DIRECTION = 1;
// How long to keep eating the click a released gesture might trail.
const CLICK_SWALLOW_MS = 300;

/** The continuous-gesture internals, shared with Leaflet's pinch handler. */
interface GestureMap extends L.Map {
  _stop(): void;
  _moveStart(zoomChanged: boolean, noMoveStart: boolean): void;
  _move(center: L.LatLng, zoom: number, data?: { pinch?: boolean; round?: boolean }): void;
  _resetView(center: L.LatLng, zoom: number): void;
  /** leaflet-rotate's bearing, in radians. Read rather than getBearing(),
   *  which converts through a DomUtil constant the plugin fails to attach
   *  under Vite's dev pre-bundling and so returns NaN there. */
  _bearing?: number;
}

export function enableDoubleTapDragZoom(leafletMap: L.Map): void {
  const map = leafletMap as GestureMap;
  const container = map.getContainer();

  // The tap we might pair the next one with.
  let lastTapAt = 0;
  let lastTapPoint: L.Point | null = null;
  // The touch that is down now, for as long as it still qualifies as a tap.
  let downAt = 0;
  let downPoint: L.Point | null = null;

  // The live gesture. Armed: the second tap is down and we have taken dragging
  // off the map. Zooming: it has moved far enough to commit to the zoom.
  let armed = false;
  let zooming = false;
  let draggingWasOn = false;
  let startY = 0;
  let startZoom = 0;
  let anchor = L.latLng(0, 0); // the ground under the tap, pinned there
  let fromCentre = L.point(0, 0); // the tap's offset from the container centre
  let centre = L.latLng(0, 0);
  let zoom = 0;
  let frame = 0;

  const at = (t: Touch): L.Point =>
    map.mouseEventToContainerPoint(t as unknown as MouseEvent);

  /** The centre that leaves `anchor` under the tapped pixel at zoom `z`. */
  function centreFor(z: number): L.LatLng {
    // fromCentre is in container space, which leaflet-rotate turns with the
    // map, so undo the bearing to get the offset in projected pixels.
    const a = -(map._bearing || 0);
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const dx = fromCentre.x * cos - fromCentre.y * sin;
    const dy = fromCentre.x * sin + fromCentre.y * cos;
    return map.unproject(map.project(anchor, z).subtract([dx, dy]), z);
  }

  const swallow = (e: Event): void => {
    e.stopPropagation();
    e.preventDefault();
  };

  /** Eat the click iOS may synthesise as the gesture's finger lifts, so it
   *  can't drop a planning waypoint or close the pin card behind our backs. */
  function swallowTrailingClick(): void {
    container.addEventListener('click', swallow, true);
    container.addEventListener('dblclick', swallow, true);
    setTimeout(() => {
      container.removeEventListener('click', swallow, true);
      container.removeEventListener('dblclick', swallow, true);
    }, CLICK_SWALLOW_MS);
  }

  function arm(point: L.Point, clientY: number): void {
    map._stop();
    armed = true;
    zooming = false;
    startY = clientY;
    startZoom = map.getZoom();
    zoom = startZoom;
    centre = map.getCenter();
    anchor = map.containerPointToLatLng(point);
    fromCentre = point.subtract(map.getSize().divideBy(2));
    // Take dragging away up front: from the second tap on, this finger belongs
    // to the zoom, and waiting for the slop would let the map pan first.
    draggingWasOn = map.dragging.enabled();
    if (draggingWasOn) map.dragging.disable();
  }

  function commit(): void {
    zooming = true;
    map._moveStart(true, false);
    // Leaflet's long-press timer is already running and disabling the handler
    // won't clear it, so block the contextmenu it would fire at us mid-zoom.
    container.addEventListener('contextmenu', swallow, true);
  }

  function finish(): void {
    if (!armed) return;
    armed = false;
    if (frame) {
      L.Util.cancelAnimFrame(frame);
      frame = 0;
    }
    if (draggingWasOn) map.dragging.enable();
    if (!zooming) return;
    zooming = false;
    container.removeEventListener('contextmenu', swallow, true);
    // Settle exactly where the finger left it, tiles and all. _resetView runs
    // the zoom through _limitZoom, which would round it to a whole level and
    // shove the anchor off the finger, so drop zoomSnap for that one call —
    // the in-between scales are the whole point of the gesture. Everything
    // else (pinch, the zoom buttons) goes on snapping as before, so a later
    // step lands the map back on a whole level.
    const snap = map.options.zoomSnap;
    map.options.zoomSnap = 0;
    map._resetView(centre, zoom);
    map.options.zoomSnap = snap;
    swallowTrailingClick();
  }

  container.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 1) {
        // A second finger down means pinch — hand the gesture over.
        finish();
        downPoint = null;
        lastTapPoint = null;
        return;
      }
      const point = at(e.touches[0]);
      const now = Date.now();
      const paired =
        lastTapPoint !== null &&
        now - lastTapAt <= DOUBLE_TAP_MS &&
        point.distanceTo(lastTapPoint) <= TAP_SLOP_PX;
      lastTapPoint = null; // spent, whether or not it paired
      downAt = now;
      downPoint = point;
      if (paired) arm(point, e.touches[0].clientY);
    },
    { passive: false }
  );

  container.addEventListener(
    'touchmove',
    (e) => {
      if (!armed) {
        // A touch that wanders is no longer a tap, so it can't open a pair.
        if (downPoint && e.touches.length === 1 && at(e.touches[0]).distanceTo(downPoint) > TAP_SLOP_PX) {
          downPoint = null;
        }
        return;
      }
      if (e.touches.length !== 1) return;
      const dy = (e.touches[0].clientY - startY) * DIRECTION;
      if (!zooming) {
        if (Math.abs(dy) < DRAG_SLOP_PX) return;
        commit();
      }
      // Stops the rubber-band scroll, and stops iOS synthesising a click.
      e.preventDefault();
      zoom = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), startZoom + dy / PX_PER_ZOOM));
      centre = centreFor(zoom);
      if (frame) L.Util.cancelAnimFrame(frame);
      frame = L.Util.requestAnimFrame(() => {
        frame = 0;
        map._move(centre, zoom, { pinch: true, round: false });
      });
    },
    { passive: false }
  );

  const onEnd = (): void => {
    if (armed) {
      finish();
      downPoint = null;
      return;
    }
    // Remember a clean, brief tap so the next one can pair with it.
    if (downPoint && Date.now() - downAt <= TAP_MAX_MS) {
      lastTapAt = Date.now();
      lastTapPoint = downPoint;
    }
    downPoint = null;
  };

  container.addEventListener('touchend', onEnd);
  container.addEventListener('touchcancel', onEnd);
}
