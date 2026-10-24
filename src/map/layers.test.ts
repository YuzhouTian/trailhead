// Which base map the walker lands on, and what they are told about it.
//
// map.ts makes these calls with a real map on screen; here they are made with
// the map's view written out, so every way the chosen layer can be unavailable
// — no key, a retired id, the wrong country, tiles that keep failing — can be
// asked about directly.

import { describe, expect, it } from 'vitest';
import { BASE_LAYERS, DEFAULT_LAYER_ID, FALLBACK_LAYER_ID } from '../config';
import {
  DEFAULT_LAYER,
  FALLBACK_LAYER,
  KEY_FAILING_TOAST,
  NEEDS_KEY_TOAST,
  TILE_FAILURES_BEFORE_FALLBACK,
  chooseBaseLayer,
  failingTilesNotice,
  layerDef,
  needsRematch,
  tileUrl,
  viewTouchesGB,
  type ViewBounds
} from './layers';

/** A screenful around a point, about 10 km across. */
const around = (lat: number, lng: number, half = 0.05): ViewBounds => ({
  south: lat - half,
  west: lng - half,
  north: lat + half,
  east: lng + half
});

const LAKES = around(54.54, -3.0);
const CHAMONIX = around(45.92, 6.87);

const freemap = layerDef('freemap')!;
const os = layerDef('os-leisure')!;
const osm = layerDef('osm')!;

describe('the layers the app falls back on', () => {
  it('opens on Freemap, the hill map that needs no key', () => {
    expect(DEFAULT_LAYER.id).toBe(DEFAULT_LAYER_ID);
    expect(DEFAULT_LAYER).toBe(freemap);
    expect(DEFAULT_LAYER.needsKey).toBeUndefined();
  });

  it('bails out to OpenStreetMap: no key, and tiles it can check', () => {
    expect(FALLBACK_LAYER.id).toBe(FALLBACK_LAYER_ID);
    expect(FALLBACK_LAYER).toBe(osm);
    expect(FALLBACK_LAYER.needsKey).toBeUndefined();
    expect(FALLBACK_LAYER.cors).not.toBe(false);
  });

  it('looks layers up by id, and knows nothing of retired ones', () => {
    expect(BASE_LAYERS.map((l) => layerDef(l.id))).toEqual(BASE_LAYERS);
    expect(layerDef('thunderforest-outdoors')).toBeUndefined();
  });
});

describe('a tile URL', () => {
  it('asks Freemap for @2x tiles on a high-density screen, and plain ones otherwise', () => {
    expect(tileUrl(freemap, '', true)).toBe('https://outdoor.tiles.freemap.sk/{z}/{x}/{y}@2x');
    expect(tileUrl(freemap, '', false)).toBe('https://outdoor.tiles.freemap.sk/{z}/{x}/{y}');
  });

  it('puts the OS key in, and asks no @2x of a layer that has none', () => {
    expect(tileUrl(os, 'K3Y', true)).toBe('https://api.os.uk/maps/raster/v1/zxy/Leisure_27700/{z}/{x}/{y}.png?key=K3Y');
    expect(tileUrl(osm, 'K3Y', true)).toBe('https://tile.openstreetmap.org/{z}/{x}/{y}.png');
  });

  it('asks @2x only of a layer whose server has them, whatever its URL allows', () => {
    // A layer that takes a suffix but has no @2x tiles to give: none today,
    // which is exactly why the rule is pinned on a made-up one.
    const plain = { ...freemap, id: 'plain', retina: false };
    expect(tileUrl(plain, '', true)).toBe('https://outdoor.tiles.freemap.sk/{z}/{x}/{y}');
  });

  it('leaves nothing for the server to choke on in any layer', () => {
    for (const def of BASE_LAYERS) {
      for (const dense of [true, false]) {
        expect(tileUrl(def, 'K3Y', dense).replace(/\{[zxys]\}/g, '')).not.toMatch(/[{}]/);
      }
    }
  });
});

describe('whether the view touches Great Britain', () => {
  it('does in the middle of it, and does not in the Alps', () => {
    expect(viewTouchesGB(LAKES)).toBe(true);
    expect(viewTouchesGB(CHAMONIX)).toBe(false);
  });

  it('does when only a corner of the screen is over it', () => {
    // Mostly the Channel and northern France; the north-west corner is in Kent.
    const view = { south: 50.0, west: 1.0, north: 51.2, east: 2.5 };
    expect(viewTouchesGB(around((50.0 + 51.2) / 2, (1.0 + 2.5) / 2, 0.01))).toBe(false);
    expect(viewTouchesGB(view)).toBe(true);
  });

  it('does when the screen spans it with Britain under the edge, not the middle', () => {
    // Centred out in the North Sea, with the east coast under the west edge.
    expect(viewTouchesGB({ south: 54.0, west: -1.5, north: 55.0, east: 3.5 })).toBe(true);
  });

  it('does when Britain is only under the middle of a wide screen', () => {
    // Across the Midlands from the Irish Sea to the North Sea: both side
    // edges are water, and only the middle column of samples lands on land.
    expect(viewTouchesGB({ south: 51.9, west: -6.0, north: 52.1, east: 2.5 })).toBe(true);
  });

  it('does not for Ireland, which is on the OS grid but not in GB', () => {
    expect(viewTouchesGB(around(53.35, -6.26))).toBe(false);
  });
});

describe('choosing the base layer', () => {
  it('keeps the layer chosen when it can be shown', () => {
    expect(chooseBaseLayer('freemap', { osKey: '' }, CHAMONIX)).toEqual({ layer: freemap, notice: null });
    expect(chooseBaseLayer('os-leisure', { osKey: 'K3Y' }, LAKES)).toEqual({ layer: os, notice: null });
  });

  it('keeps OpenStreetMap when that is what Settings names', () => {
    // Where a run of failing tiles leaves you: it must stay put, not bounce back.
    expect(chooseBaseLayer('osm', { osKey: '' }, LAKES)).toEqual({ layer: osm, notice: null });
  });

  it('shows Freemap, and asks for a key, for OS Explorer without one', () => {
    expect(chooseBaseLayer('os-leisure', { osKey: '' }, LAKES)).toEqual({ layer: freemap, notice: NEEDS_KEY_TOAST });
  });

  it('asks for the key, not about the country, for OS without a key abroad', () => {
    expect(chooseBaseLayer('os-leisure', { osKey: '' }, CHAMONIX).notice).toBe(NEEDS_KEY_TOAST);
  });

  it('shows Freemap for OS Explorer outside Great Britain, and says why', () => {
    expect(chooseBaseLayer('os-leisure', { osKey: 'K3Y' }, CHAMONIX)).toEqual({
      layer: freemap,
      notice: 'OS Explorer (1:25k) covers Great Britain only — showing Freemap'
    });
  });

  it('moves a retired layer on to Freemap without a word', () => {
    expect(chooseBaseLayer('thunderforest-outdoors', { osKey: 'K3Y' }, LAKES)).toEqual({ layer: freemap, notice: null });
  });

  it('never strands you on the fallback just for a missing key or an old id', () => {
    for (const id of ['os-leisure', 'thunderforest-outdoors', '']) {
      expect(chooseBaseLayer(id, { osKey: '' }, LAKES).layer).not.toBe(FALLBACK_LAYER);
    }
  });
});

describe('when tiles keep failing', () => {
  it('gives a layer four failures, not one, so a blip does not switch it', () => {
    expect(TILE_FAILURES_BEFORE_FALLBACK).toBe(4);
  });

  it('says a keyless layer has no tiles here, naming where it went', () => {
    expect(failingTilesNotice(freemap)).toBe('Outdoor (Freemap) has no tiles here — switched to OpenStreetMap');
  });

  it('points at the key and the plan for OS, the causes only it has', () => {
    expect(failingTilesNotice(os)).toBe(`OS Explorer (1:25k) ${KEY_FAILING_TOAST}`);
    expect(KEY_FAILING_TOAST).toMatch(/OS key/);
    expect(KEY_FAILING_TOAST).toMatch(/Premium/);
  });

  it('never gives up on the fallback, which would loop', () => {
    expect(failingTilesNotice(osm)).toBeNull();
  });
});

describe('re-matching the OS grid', () => {
  const REF = { lat: 54.5, lng: -3.0 };

  it('leaves it be within half a degree north–south and a degree east–west', () => {
    expect(needsRematch({ lat: 54.5, lng: -3.0 }, REF)).toBe(false);
    expect(needsRematch({ lat: 55.0, lng: -2.0 }, REF)).toBe(false);
    expect(needsRematch({ lat: 54.0, lng: -4.0 }, REF)).toBe(false);
  });

  it('re-matches past either, in any direction', () => {
    expect(needsRematch({ lat: 55.01, lng: -3.0 }, REF)).toBe(true);
    expect(needsRematch({ lat: 53.99, lng: -3.0 }, REF)).toBe(true);
    expect(needsRematch({ lat: 54.5, lng: -1.99 }, REF)).toBe(true);
    expect(needsRematch({ lat: 54.5, lng: -4.01 }, REF)).toBe(true);
  });
});
