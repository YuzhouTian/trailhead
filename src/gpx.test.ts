// @vitest-environment jsdom
//
// The one exception to the node environment: `parseGpx` uses `DOMParser`, which
// node has no equivalent of. Swapping in a hand-rolled XML parser to keep the
// test in node would test something other than what ships, so this file gets a
// real DOM instead.

import { describe, expect, it } from 'vitest';
import { parseGpx, toGpx } from './gpx';

/** A minimal but real GPX 1.1 track, of the shape every exporter writes. */
const TRACK_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Trailhead" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>File level name</name></metadata>
  <trk>
    <name>Scafell Pike from Wasdale</name>
    <trkseg>
      <trkpt lat="54.427100" lon="-3.247200"><ele>76.0</ele></trkpt>
      <trkpt lat="54.440000" lon="-3.230000"><ele>500.5</ele></trkpt>
      <trkpt lat="54.454200" lon="-3.211600"><ele>978.0</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

describe('parseGpx', () => {
  it('reads track points with their elevations', () => {
    const { coords } = parseGpx(TRACK_GPX, 'ignored.gpx');
    expect(coords).toEqual([
      [54.4271, -3.2472, 76],
      [54.44, -3.23, 500.5],
      [54.4542, -3.2116, 978]
    ]);
  });

  it('reads track points with no elevations at all', () => {
    const noEle = TRACK_GPX.replace(/<ele>[^<]*<\/ele>/g, '');
    const { coords } = parseGpx(noEle, 'ignored.gpx');
    // Two-element points, not points with a third slot of NaN or 0 — the rest
    // of the app tests `typeof p[2] === 'number'` to decide there is a profile.
    expect(coords).toEqual([
      [54.4271, -3.2472],
      [54.44, -3.23],
      [54.4542, -3.2116]
    ]);
  });

  it('takes the track name in preference to the file-level name', () => {
    expect(parseGpx(TRACK_GPX, 'download (3).gpx').name).toBe('Scafell Pike from Wasdale');
  });

  it('takes the track name when there is no file-level name', () => {
    const noMeta = TRACK_GPX.replace('<metadata><name>File level name</name></metadata>', '');
    expect(parseGpx(noMeta, 'download (3).gpx').name).toBe('Scafell Pike from Wasdale');
  });

  it('takes the file-level name when the track has none', () => {
    const noTrackName = TRACK_GPX.replace('<name>Scafell Pike from Wasdale</name>', '');
    expect(parseGpx(noTrackName, 'download (3).gpx').name).toBe('File level name');
  });

  it('falls back to the file name when the file names nothing', () => {
    const nameless = TRACK_GPX.replace(/<name>[^<]*<\/name>/g, '');
    expect(parseGpx(nameless, 'download (3).gpx').name).toBe('download (3).gpx');
  });

  it('falls back to the file name when the name element is only whitespace', () => {
    const blank = TRACK_GPX.replace('<name>Scafell Pike from Wasdale</name>', '<name>  </name>')
      .replace('<name>File level name</name>', '<name> </name>');
    expect(parseGpx(blank, 'walk.gpx').name).toBe('walk.gpx');
  });

  it('reads route points when there is no track', () => {
    const rte = `<?xml version="1.0"?>
      <gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
        <rte>
          <name>Planned route</name>
          <rtept lat="54.4271" lon="-3.2472"/>
          <rtept lat="54.4542" lon="-3.2116"/>
        </rte>
      </gpx>`;
    const { name, coords } = parseGpx(rte, 'ignored.gpx');
    expect(name).toBe('Planned route');
    expect(coords).toEqual([
      [54.4271, -3.2472],
      [54.4542, -3.2116]
    ]);
  });

  it('reads waypoints when there is neither track nor route', () => {
    const wpts = `<?xml version="1.0"?>
      <gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
        <wpt lat="54.4271" lon="-3.2472"><name>Car park</name></wpt>
        <wpt lat="54.4542" lon="-3.2116"><name>Summit</name></wpt>
      </gpx>`;
    expect(parseGpx(wpts, 'pins.gpx').coords).toEqual([
      [54.4271, -3.2472],
      [54.4542, -3.2116]
    ]);
  });

  it('drops points with unreadable coordinates rather than plotting NaN', () => {
    const dodgy = `<?xml version="1.0"?>
      <gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>
        <trkpt lat="54.4271" lon="-3.2472"/>
        <trkpt lat="" lon="-3.2400"/>
        <trkpt lon="-3.2300"/>
        <trkpt lat="not-a-number" lon="-3.2200"/>
        <trkpt lat="54.4542" lon="-3.2116"/>
      </trkseg></trk></gpx>`;
    expect(parseGpx(dodgy, 'x.gpx').coords).toEqual([
      [54.4271, -3.2472],
      [54.4542, -3.2116]
    ]);
  });

  it('ignores an unreadable elevation instead of recording NaN metres', () => {
    const dodgy = `<?xml version="1.0"?>
      <gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>
        <trkpt lat="54.4271" lon="-3.2472"><ele></ele></trkpt>
        <trkpt lat="54.4542" lon="-3.2116"><ele>978</ele></trkpt>
      </trkseg></trk></gpx>`;
    expect(parseGpx(dodgy, 'x.gpx').coords).toEqual([
      [54.4271, -3.2472],
      [54.4542, -3.2116, 978]
    ]);
  });

  it('spans multiple track segments, as a paused recording produces', () => {
    const twoSegs = `<?xml version="1.0"?>
      <gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk>
        <trkseg><trkpt lat="54.4271" lon="-3.2472"/></trkseg>
        <trkseg><trkpt lat="54.4542" lon="-3.2116"/></trkseg>
      </trk></gpx>`;
    expect(parseGpx(twoSegs, 'x.gpx').coords).toHaveLength(2);
  });

  it('throws on something that is not XML', () => {
    expect(() => parseGpx('this is not a GPX file', 'x.gpx')).toThrow('Not a valid GPX file');
  });

  it('throws on XML that is not well formed', () => {
    expect(() => parseGpx('<gpx><trk><trkseg></gpx>', 'x.gpx')).toThrow('Not a valid GPX file');
  });

  it('throws on well-formed XML with nothing to plot', () => {
    const empty = `<?xml version="1.0"?>
      <gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
        <metadata><name>Empty</name></metadata>
      </gpx>`;
    expect(() => parseGpx(empty, 'x.gpx')).toThrow('No track points found in GPX');
  });
});

describe('toGpx', () => {
  const coords = [
    [54.4271, -3.2472, 76],
    [54.4542, -3.2116, 978.04]
  ] as [number, number, number][];

  it('writes a GPX 1.1 document', () => {
    const xml = toGpx('Walk', coords);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<gpx version="1.1"');
    expect(xml).toContain('xmlns="http://www.topografix.com/GPX/1/1"');
  });

  it('writes coordinates to six decimals and elevations to one', () => {
    // Six decimals is about 10 cm — finer than any consumer GPS — and keeps the
    // file from being mostly noise.
    const xml = toGpx('Walk', coords);
    expect(xml).toContain('<trkpt lat="54.427100" lon="-3.247200"><ele>76.0</ele></trkpt>');
    expect(xml).toContain('<trkpt lat="54.454200" lon="-3.211600"><ele>978.0</ele></trkpt>');
  });

  it('omits the elevation element for points that have none', () => {
    const xml = toGpx('Walk', [[54.4271, -3.2472]]);
    expect(xml).toContain('<trkpt lat="54.427100" lon="-3.247200"/>');
    expect(xml).not.toContain('<ele>');
  });

  it('escapes XML metacharacters in the name', () => {
    // A route named from a search result can contain anything the user typed.
    const xml = toGpx('Fish & Chips <b>route</b>', []);
    expect(xml).toContain('<name>Fish &amp; Chips &lt;b&gt;route&lt;/b&gt;</name>');
    expect(() => parseGpx(xml.replace('<trkseg>\n\n', '<trkseg>'), 'x.gpx')).toThrow(
      'No track points found in GPX'
    );
  });

  it('round trips a route back through the parser', () => {
    const { name, coords: back } = parseGpx(toGpx('Scafell Pike & back', coords), 'x.gpx');
    expect(name).toBe('Scafell Pike & back');
    expect(back).toEqual([
      [54.4271, -3.2472, 76],
      [54.4542, -3.2116, 978] // one decimal place, so 978.04 lands on 978.0
    ]);
  });

  it('round trips a route with no elevations', () => {
    const flat: [number, number][] = [
      [54.4271, -3.2472],
      [54.4542, -3.2116]
    ];
    expect(parseGpx(toGpx('Flat', flat), 'x.gpx').coords).toEqual(flat);
  });
});
