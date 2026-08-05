import 'leaflet';

// Additions patched onto Leaflet by the leaflet-rotate plugin.
declare module 'leaflet' {
  interface Map {
    setBearing(degrees: number): void;
    getBearing(): number;
  }
  interface MapOptions {
    rotate?: boolean;
    touchRotate?: boolean;
    rotateControl?: boolean | { closeOnZeroBearing?: boolean };
    bearing?: number;
  }
}
