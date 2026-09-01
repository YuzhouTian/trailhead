import { describe, it, expect } from 'vitest';
import { BASE_LAYERS, FALLBACK_LAYER_ID, crossOriginFor } from './config';

const byId = (id: string) => {
  const def = BASE_LAYERS.find((l) => l.id === id);
  if (!def) throw new Error(`no such layer: ${id}`);
  return def;
};

describe('base layers', () => {
  it('defaults to asking for CORS, which is what most tile servers send', () => {
    expect(crossOriginFor(byId('osm'))).toBe('anonymous');
    expect(crossOriginFor(byId('tf-outdoors'))).toBe('anonymous');
  });

  it('leaves crossOrigin off for a server that sends no CORS header', () => {
    // Freemap returns 200 with a real tile but no Access-Control-Allow-Origin.
    // Asking for it anyway makes the browser discard the image, which reads as
    // "this layer has no tiles here" and bounces you to the fallback — the
    // whole layer looks dead. Verified against the live server.
    expect(byId('freemap').cors).toBe(false);
    expect(crossOriginFor(byId('freemap'))).toBeUndefined();
  });

  it('points the fallback at a layer that exists and needs no key', () => {
    const fallback = byId(FALLBACK_LAYER_ID);
    expect(fallback.needsTfKey).not.toBe(true);
    // The fallback is what a failing layer bails out to, so it has to be the
    // dependable one: global coverage, and CORS so its tiles can be checked
    // before caching.
    expect(fallback.cors).not.toBe(false);
  });

  it('never serves a layer past the zoom its server actually renders', () => {
    for (const l of BASE_LAYERS) {
      expect(l.maxNativeZoom).toBeLessThanOrEqual(l.maxZoom);
    }
  });

  it('gives every layer the fields the Map panel and offline download read', () => {
    for (const l of BASE_LAYERS) {
      expect(l.url).toMatch(/\{z\}.*\{x\}.*\{y\}/);
      expect(l.attribution).toBeTruthy();
      expect(l.blurb).toBeTruthy();
      // A retina layer has to have somewhere to put the @2x suffix.
      if (l.retina) expect(l.url).toContain('{r}');
    }
  });
});
