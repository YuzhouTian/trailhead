import L from 'leaflet';

// leaflet-rotate never imports Leaflet — it expects to find it as the global
// `L` and patches rotation onto it in place. Publishing the global is therefore
// a hard prerequisite for loading that plugin, so it happens here, in a module
// whose only job is to be evaluated first.
//
// Leaflet 1.x's UMD bundle happens to set window.L on its own, so this looks
// redundant today. It isn't: that side effect is an accident of Leaflet's
// packaging, not a guarantee, and it disappears in the ESM-only builds. Setting
// it explicitly means the plugin's prerequisite no longer depends on how
// Leaflet chose to ship.
(window as unknown as { L: typeof L }).L = L;

export default L;
