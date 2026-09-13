// Routing with a profile of our own. The public server only knows its stock
// profiles, so "Save my legs" has to be uploaded before it can be asked for,
// and every route after that has to name it by the id the server gave back.
// Getting that wrong fails quietly — the planner falls back to a straight line
// and blames the router — so the handshake is pinned here against a fake server.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BROUTER_PROFILES, knownProfile } from './config';
import { compactProfile, resetProfileUploads, routeMixed, routeViaBrouter } from './routing';
import type { LatLng } from './geo';
import source from './profiles/mountain-hiking.brf?raw';

const A: LatLng = [54.5436, -2.951];
const B: LatLng = [54.5271, -3.0165];
const C: LatLng = [54.52, -3.03];
const D: LatLng = [54.51, -3.04];

const geojson = (from: LatLng, to: LatLng) => ({
  features: [
    {
      geometry: { coordinates: [[from[1], from[0], 150], [to[1], to[0], 950]] },
      properties: { 'track-length': '5641', 'filtered ascend': '794' }
    }
  ]
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Every request the fake server saw, in order. */
let calls: { method: string; url: string; body?: string }[];
/** What the next route request answers with, if not a route. */
let routeStatus: number[];
/** Profile ids the fake server currently holds. */
let stored: Set<string>;
let uploadError: string | null;

beforeEach(() => {
  resetProfileUploads();
  calls = [];
  routeStatus = [];
  stored = new Set();
  uploadError = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ method, url, body: init?.body as string | undefined });
      if (method === 'POST') {
        const id = url.split('/profile/')[1];
        stored.add(id);
        return json(uploadError ? { profileid: id, error: uploadError } : { profileid: id });
      }
      const profile = new URL(url).searchParams.get('profile')!;
      const forced = routeStatus.shift();
      if (forced) return new Response('', { status: forced });
      // A custom profile the server does not have is a bare 500, as brouter.de does.
      if (profile.startsWith('custom_') && !stored.has(profile)) return new Response('', { status: 500 });
      return json(geojson(A, B));
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const uploads = () => calls.filter((c) => c.method === 'POST');
const routes = () => calls.filter((c) => c.method === 'GET');
const profileOf = (url: string) => new URL(url).searchParams.get('profile');

describe('the profile list', () => {
  it('offers Standard first and Save my legs second, and nothing else', () => {
    expect(BROUTER_PROFILES.map((p) => p.id)).toEqual(['hiking-beta', 'hiking-mountain']);
  });

  it('sends a profile that has been dropped back to Standard', () => {
    expect(knownProfile('trekking')).toBe('hiking-beta');
    expect(knownProfile('shortest')).toBe('hiking-beta');
    expect(knownProfile(undefined)).toBe('hiking-beta');
    expect(knownProfile('hiking-mountain')).toBe('hiking-mountain');
  });
});

describe('a stock profile', () => {
  it('is asked for by name, with nothing uploaded', async () => {
    const r = await routeViaBrouter([A, B], 'hiking-beta');
    expect(uploads()).toHaveLength(0);
    expect(routes()).toHaveLength(1);
    expect(profileOf(routes()[0].url)).toBe('hiking-beta');
    expect(r.distanceM).toBe(5641);
    expect(r.ascentM).toBe(794);
  });
});

describe('Save my legs', () => {
  it('uploads our profile first, then routes with the id the server keeps it under', async () => {
    await routeViaBrouter([A, B], 'hiking-mountain');
    expect(uploads()).toHaveLength(1);
    const id = uploads()[0].url.split('/profile/')[1];
    expect(id).toMatch(/^custom_trailhead-hiking-mountain-[0-9a-f]{8}$/);
    expect(calls[0].method).toBe('POST'); // before the route, not after
    expect(profileOf(routes()[0].url)).toBe(id);
    // What is sent is the profile that counts the climb, minus its comments.
    const body = uploads()[0].body!;
    expect(body).toMatch(/assign\s+consider_elevation\s+=\s+true/);
    expect(body).not.toContain('#');
  });

  it('never asks the server for hiking-mountain by name', async () => {
    await routeViaBrouter([A, B], 'hiking-mountain');
    expect(routes().map((c) => profileOf(c.url))).not.toContain('hiking-mountain');
  });

  it('uploads once per session, not once per route', async () => {
    await routeViaBrouter([A, B], 'hiking-mountain');
    await routeViaBrouter([B, A], 'hiking-mountain');
    await routeViaBrouter([A, B], 'hiking-mountain');
    expect(uploads()).toHaveLength(1);
    expect(routes()).toHaveLength(3);
  });

  it('shares one upload between legs routed at the same time', async () => {
    // Snapped, straight, snapped: two router calls that start together.
    await routeMixed([A, B, C, D], [true, true, false, true], 'hiking-mountain');
    expect(routes()).toHaveLength(2);
    expect(uploads()).toHaveLength(1);
  });

  it('puts the profile back and asks again once if the server has lost it', async () => {
    await routeViaBrouter([A, B], 'hiking-mountain');
    stored.clear(); // the server tidied its uploads away mid-session
    const r = await routeViaBrouter([B, A], 'hiking-mountain');
    expect(uploads()).toHaveLength(2);
    expect(routes()).toHaveLength(3); // first route, the 500, the retry
    expect(r.distanceM).toBe(5641);
  });

  it('gives up after one retry, so a route that cannot be found still fails', async () => {
    routeStatus = [500, 500];
    await expect(routeViaBrouter([A, B], 'hiking-mountain')).rejects.toThrow(/Routing failed \(500\)/);
    expect(routes()).toHaveLength(2);
  });

  it('does not retry a refusal that is not a 500', async () => {
    routeStatus = [403];
    await expect(routeViaBrouter([A, B], 'hiking-mountain')).rejects.toThrow(/403/);
    expect(routes()).toHaveLength(1);
    expect(uploads()).toHaveLength(1);
  });

  it('fails without routing if the server will not compile the profile, and tries again next time', async () => {
    uploadError = 'Profile error: does not contain expressions for context way';
    await expect(routeViaBrouter([A, B], 'hiking-mountain')).rejects.toThrow(/routing profile/);
    expect(routes()).toHaveLength(0);
    uploadError = null;
    await routeViaBrouter([A, B], 'hiking-mountain');
    expect(uploads()).toHaveLength(2);
    expect(routes()).toHaveLength(1);
  });

  it('fails the route, rather than hanging, when the upload cannot reach the server', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(routeViaBrouter([A, B], 'hiking-mountain')).rejects.toThrow('Failed to fetch');
  });
});

describe('the profile file', () => {
  it('differs from BRouter\'s hiking-mountain only in counting the climb', () => {
    const settings = source.split('\n').filter((l) => /^assign\s+consider_elevation/.test(l));
    expect(settings).toHaveLength(1);
    expect(settings[0]).toMatch(/=\s+true/);
  });

  it('still has all three contexts once the comments are gone', () => {
    const compact = compactProfile(source);
    for (const ctx of ['---context:global', '---context:way', '---context:node']) {
      expect(compact).toContain(ctx);
    }
    expect(compact.length).toBeLessThan(source.length * 0.7);
  });

  it('reads the same from a Windows checkout', () => {
    expect(compactProfile(source.replace(/\n/g, '\r\n'))).toBe(compactProfile(source));
  });
});
