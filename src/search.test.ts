import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LatLng } from './geo';
import { latLngToEastingNorthing } from './osgb';
import { search } from './search';

/** Glenridding, the near point for every search here unless a test says not. */
const GLENRIDDING: LatLng = [54.544, -2.95];
const CHAMONIX: LatLng = [45.92, 6.87];

/** One Photon feature, as Photon sends it. */
function photon(name: string, lat: number, lng: number, key: string, value: string, id = 1) {
  return {
    geometry: { coordinates: [lng, lat] },
    properties: { name, osm_key: key, osm_value: value, osm_type: 'N', osm_id: id, type: 'other', county: 'Cumbria' }
  };
}

/** One OS Names gazetteer entry, placed by lat/lng so the fixtures read. */
function os(name: string, lat: number, lng: number, type: string, localType: string, extra = {}) {
  const { e, n } = latLngToEastingNorthing(lat, lng);
  return {
    GAZETTEER_ENTRY: {
      NAME1: name,
      TYPE: type,
      LOCAL_TYPE: localType,
      GEOMETRY_X: Math.round(e),
      GEOMETRY_Y: Math.round(n),
      COUNTY_UNITARY: 'Cumbria',
      POPULATED_PLACE: 'Glenridding',
      ...extra
    }
  };
}

type Reply = { status: number; body?: unknown } | 'hang';

/** Stand in for Photon and OS Names; note which were asked, and with what. */
function fakeServices(photonReply: Reply, osReply: Reply = { status: 200, body: {} }) {
  const asked: string[] = [];
  vi.stubGlobal('fetch', (url: string, init: { signal?: AbortSignal }) => {
    asked.push(url);
    const reply = url.startsWith('https://api.os.uk/') ? osReply : photonReply;
    return new Promise((resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      if (reply === 'hang') return;
      resolve({ ok: reply.status < 400, status: reply.status, json: async () => reply.body });
    });
  });
  return asked;
}

const photonOk = (...features: unknown[]): Reply => ({ status: 200, body: { features } });
const osOk = (...results: unknown[]): Reply => ({ status: 200, body: { results } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('search without an OS key', () => {
  it('asks Photon alone', async () => {
    const asked = fakeServices(photonOk(photon('Helvellyn', 54.5271, -3.0164, 'natural', 'peak')));
    const hits = await search('Helvellyn', { near: GLENRIDDING });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('photon.komoot.io');
    expect(hits.map((h) => h.name)).toEqual(['Helvellyn']);
  });

  it('still fails when Photon does', async () => {
    fakeServices({ status: 503 });
    await expect(search('Helvellyn', { near: GLENRIDDING })).rejects.toThrow('Photon 503');
  });

  it('resolves grid references without asking anyone', async () => {
    const asked = fakeServices(photonOk());
    const hits = await search('NY 342 151', { osKey: 'k' });
    expect(asked).toHaveLength(0);
    expect(hits[0].detail).toBe('Grid reference');
  });
});

describe('search with an OS key', () => {
  it('asks OS Names alongside Photon, with the key', async () => {
    const asked = fakeServices(photonOk(), osOk());
    await search('Helvellyn', { near: GLENRIDDING, osKey: 'my key' });
    const osUrl = asked.find((u) => u.startsWith('https://api.os.uk/search/names/v1/find?'));
    expect(osUrl).toContain('query=Helvellyn');
    expect(osUrl).toContain('key=my%20key');
  });

  it('keeps a place both know once, at OpenStreetMap’s point', async () => {
    fakeServices(
      photonOk(photon('Helvellyn', 54.5271, -3.0164, 'natural', 'peak')),
      // OS puts the name a few hundred metres off the top.
      osOk(os('Helvellyn', 54.529, -3.02, 'landform', 'Hill Or Mountain'))
    );
    const hits = await search('Helvellyn', { near: GLENRIDDING, osKey: 'k' });
    expect(hits).toHaveLength(1);
    expect(hits[0].pos).toEqual([54.5271, -3.0164]);
    expect(hits[0].detail).toMatch(/^Summit · Cumbria/);
  });

  it('adds what only OS knows, ranked as the kind of place it is', async () => {
    fakeServices(
      photonOk(photon('Red Tarn Cottage', 54.6, -3.1, 'building', 'house')),
      osOk(os('Red Tarn', 54.5275, -3.0028, 'hydrography', 'Inland Water'))
    );
    const hits = await search('Red Tarn', { near: GLENRIDDING, osKey: 'k' });
    expect(hits.map((h) => h.name)).toEqual(['Red Tarn', 'Red Tarn Cottage']);
    expect(hits[0].detail).toMatch(/^Water · Cumbria · \d/);
    // Back on WGS84 within the Helmert transform's few metres.
    expect(hits[0].pos[0]).toBeCloseTo(54.5275, 3);
    expect(hits[0].pos[1]).toBeCloseTo(-3.0028, 3);
  });

  it('lifts a summit OS confirms above an unconfirmed one of the same name', async () => {
    fakeServices(
      photonOk(
        // Photon's own order puts the nameless knoll first.
        photon('High Street', 54.6, -2.7, 'natural', 'hill', 1),
        photon('High Street', 54.4927, -2.8646, 'natural', 'peak', 2)
      ),
      osOk(os('High Street', 54.4927, -2.8646, 'landform', 'Hill Or Mountain'))
    );
    const hits = await search('High Street', { near: GLENRIDDING, osKey: 'k' });
    expect(hits[0].pos).toEqual([54.4927, -2.8646]);
  });

  it('matches and shows the Welsh name when that is what was typed', async () => {
    fakeServices(photonOk(), osOk(os('Snowdon', 53.0685, -4.0763, 'landform', 'Hill Or Mountain', { NAME2: 'Yr Wyddfa', COUNTY_UNITARY: 'Gwynedd' })));
    const hits = await search('Yr Wyddfa', { near: GLENRIDDING, osKey: 'k' });
    expect(hits[0].name).toBe('Yr Wyddfa');
    expect(hits[0].detail).toMatch(/^Hill · Gwynedd/);
  });

  it('merges across languages, so OS’s English name finds OpenStreetMap’s Welsh one', async () => {
    fakeServices(
      photonOk(
        photon('Snowdon Street', 53.1, -4.2, 'highway', 'residential', 1),
        photon('Yr Wyddfa', 53.0685, -4.0763, 'natural', 'peak', 2)
      ),
      osOk(os('Snowdon', 53.069, -4.077, 'landform', 'Hill Or Mountain', { NAME2: 'Yr Wyddfa' }))
    );
    const hits = await search('Snowdon', { near: GLENRIDDING, osKey: 'k' });
    expect(hits.map((h) => h.name)).toEqual(['Yr Wyddfa', 'Snowdon Street']);
  });

  it('finds a postcode', async () => {
    fakeServices(
      photonOk(photon('Rydal Road', 54.43, -2.96, 'highway', 'residential')),
      osOk(os('LA22 9RH', 54.4335, -2.9625, 'other', 'Postcode', { POPULATED_PLACE: 'Ambleside' }))
    );
    const hits = await search('LA22 9RH', { near: GLENRIDDING, osKey: 'k' });
    expect(hits[0].name).toBe('LA22 9RH');
    expect(hits[0].detail).toMatch(/^Postcode · Ambleside/);
  });

  it('copes with OS finding nothing', async () => {
    fakeServices(photonOk(photon('Helvellyn', 54.5271, -3.0164, 'natural', 'peak')), {
      status: 200,
      body: { header: { totalresults: 0 } }
    });
    const hits = await search('Helvellyn', { near: GLENRIDDING, osKey: 'k' });
    expect(hits.map((h) => h.name)).toEqual(['Helvellyn']);
  });

  it('says when OS refuses the key, and answers from Photon anyway', async () => {
    fakeServices(photonOk(photon('Helvellyn', 54.5271, -3.0164, 'natural', 'peak')), { status: 401 });
    const rejected = vi.fn();
    const hits = await search('Helvellyn', { near: GLENRIDDING, osKey: 'k', onOsRejected: rejected });
    expect(rejected).toHaveBeenCalledWith(401);
    expect(hits.map((h) => h.name)).toEqual(['Helvellyn']);
  });

  it('keeps quiet about OS being merely busy', async () => {
    fakeServices(photonOk(photon('Helvellyn', 54.5271, -3.0164, 'natural', 'peak')), { status: 503 });
    const rejected = vi.fn();
    const hits = await search('Helvellyn', { near: GLENRIDDING, osKey: 'k', onOsRejected: rejected });
    expect(rejected).not.toHaveBeenCalled();
    expect(hits).toHaveLength(1);
  });

  it('answers from OS when Photon is down', async () => {
    fakeServices({ status: 503 }, osOk(os('Helvellyn', 54.529, -3.02, 'landform', 'Hill Or Mountain')));
    const hits = await search('Helvellyn', { near: GLENRIDDING, osKey: 'k' });
    expect(hits.map((h) => h.name)).toEqual(['Helvellyn']);
  });

  it('reports Photon being down rather than "no matches" when OS has nothing', async () => {
    fakeServices({ status: 503 }, osOk());
    await expect(search('Helvellyn', { near: GLENRIDDING, osKey: 'k' })).rejects.toThrow('Photon 503');
  });

  it('fails only when both are down', async () => {
    fakeServices({ status: 503 }, { status: 503 });
    await expect(search('Helvellyn', { near: GLENRIDDING, osKey: 'k' })).rejects.toThrow('Photon 503');
  });

  it('gives up on a slow OS rather than holding the list back', async () => {
    vi.useFakeTimers();
    fakeServices(photonOk(photon('Helvellyn', 54.5271, -3.0164, 'natural', 'peak')), 'hang');
    const result = search('Helvellyn', { near: GLENRIDDING, osKey: 'k' });
    await vi.advanceTimersByTimeAsync(5000);
    expect((await result).map((h) => h.name)).toEqual(['Helvellyn']);
  });

  it('leaves OS out when looking from outside Great Britain', async () => {
    const asked = fakeServices(photonOk(photon('Mont Blanc', 45.8326, 6.8652, 'natural', 'peak')));
    await search('Mont Blanc', { near: CHAMONIX, osKey: 'k' });
    expect(asked.some((u) => u.startsWith('https://api.os.uk/'))).toBe(false);
  });

  it('is cancelled by the next keystroke', async () => {
    fakeServices('hang', 'hang');
    const ctrl = new AbortController();
    const result = search('Helvellyn', { near: GLENRIDDING, osKey: 'k', signal: ctrl.signal });
    ctrl.abort();
    await expect(result).rejects.toThrow();
  });
});
