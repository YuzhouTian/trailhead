import indexHtml from '../index.html?raw';
import { describe, expect, it } from 'vitest';
import { POI_CATEGORIES, poiCategory } from './poi';

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
  // the Overpass query, the markers, the map key and the Map sheet's chips at
  // once, so a duplicated id or a missing field breaks four things quietly.

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
    // A typo in an icon id draws nothing at all, on the marker, the chip and
    // the map key alike.
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
