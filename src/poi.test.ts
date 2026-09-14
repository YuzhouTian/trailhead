import indexHtml from '../index.html?raw';
import { describe, expect, it } from 'vitest';
import { NEARBY_MAX_HALF_M, NEARBY_MIN_HALF_M, POI_CATEGORIES, nearbyBox, poiCategory } from './poi';

const TABLE_ORDER = POI_CATEGORIES.map((c) => c.id);

describe('poiCategory', () => {
  it('finds a category by id', () => {
    expect(poiCategory('summit')?.label).toBe('Summit');
  });

  it('is undefined for an id that is not in the table', () => {
    expect(poiCategory('dragons')).toBeUndefined();
    expect(poiCategory('')).toBeUndefined();
  });

  it('finds every id in the table', () => {
    for (const id of TABLE_ORDER) expect(poiCategory(id)?.id).toBe(id);
  });
});

describe('the category table', () => {
  // These are not tests of a function so much as of the table itself: it drives
  // the Overpass query, the markers and the Map sheet's chips at once, so a
  // duplicated id or a missing field breaks three things quietly.

  it('has unique ids', () => {
    expect(new Set(TABLE_ORDER).size).toBe(TABLE_ORDER.length);
  });

  it('gives every category a singular label, a plural and an icon', () => {
    for (const c of POI_CATEGORIES) {
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.plural.length).toBeGreaterThan(0);
      // The icon is the id of a `<symbol>` in index.html's sprite, not a
      // character: emoji rendered differently on every phone.
      expect(c.icon).toMatch(/^c-[a-z]+$/);
      expect(c.colour).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('gives every category at least one OSM tag to match on', () => {
    for (const c of POI_CATEGORIES) {
      expect(c.tags.length).toBeGreaterThan(0);
      for (const [key, value] of c.tags) {
        expect(key).toMatch(/^[a-z_:]+$/);
        expect(value).toMatch(/^[a-z_]+$/);
      }
    }
  });

  it('gives every category its own positive quota', () => {
    // A shared budget was the Dartmoor bug: 199 tors ate the whole allowance
    // and hid every viewpoint and spring.
    for (const c of POI_CATEGORIES) {
      expect(c.quota).toBeGreaterThan(0);
    }
  });

  it('draws every icon from a symbol that exists in the sprite', () => {
    // A typo in an icon id draws nothing at all, on the marker and the chip
    // alike.
    for (const c of POI_CATEGORIES) expect(indexHtml).toContain(`<symbol id="${c.icon}"`);
  });

  it('shares its ids with the saved-pin categories', () => {
    // So a point found nearby can be saved as a pin of the same kind.
    const pinCategories = ['summit', 'viewpoint', 'water', 'camp', 'parking', 'other'];
    for (const id of TABLE_ORDER) expect(pinCategories).toContain(id);
  });

  it('does not let two categories claim the same tag', () => {
    // A feature would turn up under both chips, as two markers on one spot.
    const seen = new Map<string, string>();
    for (const c of POI_CATEGORIES) {
      for (const [key, value] of c.tags) {
        const tag = `${key}=${value}`;
        expect(seen.has(tag), `${tag} claimed by both ${seen.get(tag)} and ${c.id}`).toBe(false);
        seen.set(tag, c.id);
      }
    }
  });
});

describe('nearbyBox', () => {
  // Sheeps Tor on Dartmoor, as a phone shows it at about zoom 14.
  const SHEEPS_TOR = { south: 50.5, west: -4.06, north: 50.53, east: -4.02 };
  const M_PER_DEG = 111320;
  const halfHeightM = (b: { south: number; north: number }) => ((b.north - b.south) / 2) * M_PER_DEG;
  const halfWidthM = (b: { south: number; north: number; west: number; east: number }) =>
    ((b.east - b.west) / 2) * M_PER_DEG * Math.cos((((b.south + b.north) / 2) * Math.PI) / 180);

  it('searches exactly the map on screen when it is a sensible size', () => {
    // The #98 bug: the search went where the GPS was, not where the map was.
    const box = nearbyBox(SHEEPS_TOR);
    expect(box.south).toBeCloseTo(SHEEPS_TOR.south, 9);
    expect(box.west).toBeCloseTo(SHEEPS_TOR.west, 9);
    expect(box.north).toBeCloseTo(SHEEPS_TOR.north, 9);
    expect(box.east).toBeCloseTo(SHEEPS_TOR.east, 9);
  });

  it('widens a view zoomed right in, keeping its middle', () => {
    const tiny = { south: 50.515, west: -4.041, north: 50.516, east: -4.039 };
    const box = nearbyBox(tiny);
    expect(halfHeightM(box)).toBeCloseTo(NEARBY_MIN_HALF_M, 3);
    expect(halfWidthM(box)).toBeCloseTo(NEARBY_MIN_HALF_M, 3);
    expect((box.south + box.north) / 2).toBeCloseTo(50.5155, 9);
    expect((box.west + box.east) / 2).toBeCloseTo(-4.04, 9);
  });

  it('cuts a view zoomed right out down to what the servers answer, keeping its middle', () => {
    const devon = { south: 50.2, west: -4.6, north: 51.2, east: -3.0 };
    const box = nearbyBox(devon);
    expect(halfHeightM(box)).toBeCloseTo(NEARBY_MAX_HALF_M, 3);
    expect(halfWidthM(box)).toBeCloseTo(NEARBY_MAX_HALF_M, 3);
    expect((box.south + box.north) / 2).toBeCloseTo(50.7, 9);
    expect((box.west + box.east) / 2).toBeCloseTo(-3.8, 9);
  });

  it('clamps each direction on its own, so a tall narrow view stays narrow', () => {
    const strip = { south: 50.0, west: -4.041, north: 50.1, east: -4.039 };
    const box = nearbyBox(strip);
    expect(halfHeightM(box)).toBeCloseTo((0.05 * M_PER_DEG), 3);
    expect(halfWidthM(box)).toBeCloseTo(NEARBY_MIN_HALF_M, 3);
  });

  it('clips at the antimeridian rather than wrapping', () => {
    const box = nearbyBox({ south: -17.1, west: 179.9, north: -17.0, east: 180.1 });
    expect(box.east).toBe(180);
    expect(box.west).toBeLessThan(box.east);
  });
});
