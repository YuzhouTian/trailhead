import { describe, it, expect } from 'vitest';
import { BASE_LAYERS, FALLBACK_LAYER_ID, crossOriginFor, keyFor, missingKey } from './config';

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
    expect(fallback.needsKey).toBeUndefined();
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
      expect(l.blurb).toBeTruthy();
      // A retina layer has to have somewhere to put the @2x suffix.
      if (l.retina) expect(l.url).toContain('{r}');
    }
  });

  it('puts the OS layer on the National Grid, with the 1:25k map at zooms 14–16', () => {
    const os = byId('os-leisure');
    expect(os.grid).toBe('osgb');
    // OS level = app zoom + zoomOffset; Leisure's 1:25k levels are 7–9.
    expect(14 + os.zoomOffset!).toBe(7);
    expect(os.maxNativeZoom + os.zoomOffset!).toBe(9);
    expect(os.minNativeZoom! + os.zoomOffset!).toBe(0);
    expect(os.url).toContain('{osKey}');
  });

  it('sharpens only 1:25k levels, from a 1:25k level the server has', () => {
    const os = byId('os-leisure');
    for (const level of os.sharpLevels!) {
      expect(level).toBeGreaterThanOrEqual(7);
      expect(level + 1).toBeLessThanOrEqual(os.maxNativeZoom + os.zoomOffset!);
    }
  });
});

describe('layer keys', () => {
  const keys = { tfKey: 'tf-123', osKey: '' };

  it('reads the key each layer needs from its own Settings field', () => {
    expect(keyFor(byId('tf-outdoors'), keys)).toBe('tf-123');
    expect(keyFor(byId('os-leisure'), keys)).toBe('');
    expect(keyFor(byId('freemap'), keys)).toBeNull();
  });

  it('counts a layer as missing its key only when it needs one and it is blank', () => {
    expect(missingKey(byId('os-leisure'), keys)).toBe(true);
    expect(missingKey(byId('tf-outdoors'), keys)).toBe(false);
    expect(missingKey(byId('osm'), keys)).toBe(false);
    expect(missingKey(byId('os-leisure'), { ...keys, osKey: 'os-456' })).toBe(false);
  });

  it('names a key placeholder in the URL of every layer that needs a key', () => {
    for (const l of BASE_LAYERS) {
      if (l.needsKey === 'tf') expect(l.url).toContain('{tfKey}');
      if (l.needsKey === 'os') expect(l.url).toContain('{osKey}');
    }
  });
});
