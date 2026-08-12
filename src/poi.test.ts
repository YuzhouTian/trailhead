import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POI_KINDS,
  POI_CATEGORIES,
  POI_KINDS_ADVISORY,
  describeKinds,
  poiCategories,
  poiCategory
} from './poi';

const TABLE_ORDER = POI_CATEGORIES.map((c) => c.id);

describe('poiCategories', () => {
  it('returns the categories asked for', () => {
    expect(poiCategories(['summit', 'water']).map((c) => c.id)).toEqual(['summit', 'water']);
  });

  it('returns them in table order, whatever order they were asked for in', () => {
    // The tick list in Settings is rendered from this, so it has to be stable.
    const asked = ['transport', 'summit', 'toilets', 'trig'];
    expect(poiCategories(asked).map((c) => c.id)).toEqual(
      TABLE_ORDER.filter((id) => asked.includes(id))
    );
  });

  it('ignores ids it does not know', () => {
    // Old installs can carry categories that have since been renamed or dropped.
    expect(poiCategories(['summit', 'dragons', 'water']).map((c) => c.id)).toEqual([
      'summit',
      'water'
    ]);
  });

  it('is empty for no ids and for only unknown ids', () => {
    expect(poiCategories([])).toEqual([]);
    expect(poiCategories(['dragons', 'wyverns'])).toEqual([]);
  });

  it('returns a category once even if asked for twice', () => {
    expect(poiCategories(['summit', 'summit']).map((c) => c.id)).toEqual(['summit']);
  });

  it('returns the whole table when asked for everything', () => {
    expect(poiCategories(TABLE_ORDER).map((c) => c.id)).toEqual(TABLE_ORDER);
  });
});

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

describe('describeKinds', () => {
  it('says "nothing" when nothing is ticked', () => {
    expect(describeKinds([])).toBe('nothing');
    expect(describeKinds(['dragons'])).toBe('nothing');
  });

  it('names a single category on its own', () => {
    expect(describeKinds(['summit'])).toBe('summits');
  });

  it('joins two with "and"', () => {
    expect(describeKinds(['summit', 'viewpoint'])).toBe('summits and viewpoints');
  });

  it('joins three or more with commas and a final "and"', () => {
    // The example in the function's own documentation. Note there is no comma
    // before the "and" — house style, and the phrase reads inside a sentence
    // in a toast, so it needs to sound spoken.
    expect(describeKinds(['summit', 'viewpoint', 'water'])).toBe(
      'summits, viewpoints and water sources'
    );
    expect(describeKinds(['summit', 'trig', 'viewpoint', 'water'])).toBe(
      'summits, trig points, viewpoints and water sources'
    );
  });

  it('describes them in table order, not the order they were passed', () => {
    expect(describeKinds(['water', 'summit'])).toBe('summits and water sources');
  });

  it('leaves out ids it does not know', () => {
    expect(describeKinds(['summit', 'dragons', 'water'])).toBe('summits and water sources');
  });

  it('is all lower case, because it lands mid-sentence', () => {
    const described = describeKinds(TABLE_ORDER);
    expect(described).toBe(described.toLowerCase());
  });
});

describe('the category table', () => {
  // These are not tests of a function so much as of the table itself: it drives
  // the Overpass query, the markers, the map key and the Settings list at once,
  // so a duplicated id or a missing field breaks four things quietly.

  it('has unique ids', () => {
    expect(new Set(TABLE_ORDER).size).toBe(TABLE_ORDER.length);
  });

  it('gives every category a singular label, a plural and an icon', () => {
    for (const c of POI_CATEGORIES) {
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.plural.length).toBeGreaterThan(0);
      expect(c.icon.length).toBeGreaterThan(0);
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

  it('does not let two categories claim the same tag', () => {
    // Overlap is resolved by table order, which is deliberate for a trig pillar
    // on a peak — but an accidental duplicate would silently starve the later
    // category of every feature it was meant to find.
    const seen = new Map<string, string>();
    for (const c of POI_CATEGORIES) {
      for (const [key, value] of c.tags) {
        const tag = `${key}=${value}`;
        expect(seen.has(tag), `${tag} claimed by both ${seen.get(tag)} and ${c.id}`).toBe(false);
        seen.set(tag, c.id);
      }
    }
  });

  it('defaults to categories that are actually in the table', () => {
    for (const id of DEFAULT_POI_KINDS) expect(TABLE_ORDER).toContain(id);
  });

  it('sets the advisory threshold below the number of categories', () => {
    // Otherwise the warning about a slow search could never appear.
    expect(POI_KINDS_ADVISORY).toBeGreaterThan(0);
    expect(POI_KINDS_ADVISORY).toBeLessThan(POI_CATEGORIES.length);
  });
});
