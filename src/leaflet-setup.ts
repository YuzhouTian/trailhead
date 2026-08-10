// Leaflet plus the rotation plugin, ready to use. Import L from here rather
// than from 'leaflet' directly, so nowhere else has to care about the ordering
// problem described below.
//
// ORDER-SENSITIVE — the two imports below must not be swapped.
//
// leaflet-rotate reads the global `L` at module-evaluation time. If it is
// evaluated before ./leaflet-global has published that global, it throws
// "L is not defined", which surfaces as a blank page with no build error and
// no type error. The split into a separate ./leaflet-global module is what
// makes the ordering reliable: imports within a single module are hoisted
// above its statements, so `window.L = L` could never run early enough if it
// lived here. Across modules, evaluation is depth-first in import order, so
// ./leaflet-global is guaranteed to finish before leaflet-rotate starts.
import L from './leaflet-global';
import 'leaflet-rotate';
import 'leaflet/dist/leaflet.css';

// Guards the other way the plugin can let us down: loading fine but not
// patching. Swapping the imports above throws "L is not defined" before this
// runs, so this is not the check for that — it catches a leaflet-rotate or
// Leaflet upgrade that quietly stops adding the rotation API. The plugin is
// 0.2.x and hand-typed in ./leaflet-augment.d.ts, so TypeScript believes
// setBearing exists no matter what actually ships; this is the only thing
// that would notice.
if (typeof L.Map.prototype.setBearing !== 'function') {
  throw new Error(
    'leaflet-rotate loaded but did not patch Leaflet: L.Map.prototype.setBearing ' +
      'is missing. Heading-up compass mode depends on it — check the ' +
      'leaflet-rotate and leaflet versions in package.json.'
  );
}

export default L;
