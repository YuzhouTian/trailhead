import { describe, expect, it } from 'vitest';
import {
  eastingNorthingToLatLng,
  formatGridRef,
  latLngToEastingNorthing,
  parseGridRef
} from './osgb';

/**
 * Ordnance Survey's own published transformation test points — the 40 rows of
 * `OSTN15_OSGM15_TestInput_ETRStoOSGB.txt` (ETRS89 latitude/longitude, which
 * for our purposes is WGS84) paired with the OSGB36 easting/northing from the
 * matching `TestOutput` file. They span the whole grid, from St Mary's in the
 * Scillies to Shetland, plus the Isle of Man and the Western Isles.
 *
 * These are the answers OS considers definitive, so they check the projection
 * against the specification rather than against itself. Source:
 * https://www.ordnancesurvey.co.uk/geodesy-positioning/coordinate-transformations/resources
 *
 * [id, latitude, longitude, easting, northing]
 */
const OS_TEST_POINTS: [string, number, number, number, number][] = [
  ['TP01', 49.92226394, -6.29977752, 91492.146, 11318.804],
  ['TP02', 49.96006138, -5.20304610, 170370.718, 11572.405],
  ['TP03', 50.43885826, -4.10864564, 250359.811, 62016.569],
  ['TP04', 50.57563665, -1.29782277, 449816.371, 75335.861],
  ['TP05', 50.93127938, -1.45051434, 438710.920, 114792.250],
  ['TP06', 51.40078220, -3.55128349, 292184.870, 168003.465],
  ['TP07', 51.37447026, 1.44454730, 639821.835, 169565.858],
  ['TP08', 51.42754743, -2.54407618, 362269.991, 169978.690],
  ['TP09', 51.48936565, -0.11992557, 530624.974, 178388.464],
  ['TP10', 51.85890896, -4.30852477, 241124.584, 220332.641],
  ['TP11', 51.89436637, 0.89724327, 599445.590, 225722.826],
  ['TP12', 52.25529382, -2.15458614, 389544.190, 261912.153],
  ['TP13', 52.25160951, -0.91248957, 474335.969, 262047.755],
  ['TP14', 52.75136687, 0.40153547, 562180.547, 319784.995],
  ['TP15', 52.96219109, -1.19747656, 454002.834, 340834.943],
  ['TP16', 53.34480280, -2.64049321, 357455.843, 383290.436],
  ['TP17', 53.41628516, -4.28918070, 247958.971, 393492.909],
  ['TP18', 53.41630925, -4.28917793, 247959.241, 393495.583],
  ['TP19', 53.77911026, -3.04045491, 331534.564, 431920.794],
  ['TP20', 53.80021520, -1.66379168, 422242.186, 433818.701],
  ['TP21', 54.08666318, -4.63452168, 227778.330, 468847.388],
  ['TP22', 54.11685144, -0.07773133, 525745.670, 470703.214],
  ['TP23', 54.32919541, -4.38849118, 244780.636, 495254.887],
  ['TP24', 54.89542340, -2.93827741, 339921.145, 556034.761],
  ['TP25', 54.97912274, -1.61657685, 424639.355, 565012.703],
  ['TP26', 55.85399953, -4.29649016, 256340.925, 664697.269],
  ['TP27', 55.92478266, -3.29479219, 319188.434, 670947.534],
  ['TP28', 57.00606696, -5.82836692, 167634.202, 797067.144],
  ['TP29', 57.13902519, -2.04856031, 397160.491, 805349.736],
  ['TP30', 57.48625001, -4.21926399, 267056.768, 846176.972],
  ['TP31', 57.81351838, -8.57854456, 9587.909, 899448.996],
  ['TP32', 58.21262247, -7.59255561, 71713.132, 938516.404],
  ['TP33', 58.51560361, -6.26091456, 151968.652, 966483.780],
  ['TP34', 58.58120461, -3.72631022, 299721.891, 967202.992],
  ['TP35', 59.03743871, -3.21454001, 330398.323, 1017347.016],
  ['TP36', 59.09335035, -4.41757675, 261596.778, 1025447.602],
  ['TP37', 59.09671617, -5.82799340, 180862.461, 1029604.114],
  ['TP38', 59.53470794, -1.62516966, 421300.525, 1072147.239],
  ['TP39', 59.85409914, -1.27486910, 440725.073, 1107878.448],
  ['TP40', 60.13308092, -2.07382823, 395999.668, 1138728.951]
];

/**
 * OS's definitive transformation is OSTN15, a grid of measured shifts that
 * absorbs the distortions in the original 1936 triangulation. osgb.ts uses a
 * seven-parameter Helmert transform instead, which is a smooth approximation
 * to that grid and is documented as accurate to a few metres. Five metres is
 * the observed worst case across the forty points below (TP31, St Kilda), and
 * is far finer than the 100 m squares the app actually prints.
 */
const HELMERT_TOLERANCE_M = 5;

describe('latLngToEastingNorthing', () => {
  it.each(OS_TEST_POINTS)(
    '%s agrees with the OS published easting/northing',
    (_id, lat, lng, expectedE, expectedN) => {
      const { e, n } = latLngToEastingNorthing(lat, lng);
      expect(Math.hypot(e - expectedE, n - expectedN)).toBeLessThan(HELMERT_TOLERANCE_M);
    }
  );
});

describe('eastingNorthingToLatLng', () => {
  it.each(OS_TEST_POINTS)(
    '%s inverts the OS published easting/northing back to its latitude/longitude',
    (_id, lat, lng, e, n) => {
      const [gotLat, gotLng] = eastingNorthingToLatLng(e, n);
      // Compared as a ground distance so the tolerance means the same thing at
      // Shetland as it does in Cornwall (a degree of longitude is half as wide
      // at 60°N as at 50°N).
      const dLatM = (gotLat - lat) * 111320;
      const dLngM = (gotLng - lng) * 111320 * Math.cos((lat * Math.PI) / 180);
      expect(Math.hypot(dLatM, dLngM)).toBeLessThan(HELMERT_TOLERANCE_M);
    }
  );

  it('round trips latitude/longitude through the grid and back', () => {
    // Nothing external here: this is the two functions checking each other, so
    // the tolerance is numerical noise rather than the Helmert approximation.
    // 1e-7 degrees is about a centimetre — the residue of an iterative inverse
    // and a truncated series, not a modelling error.
    for (const [, lat, lng] of OS_TEST_POINTS) {
      const { e, n } = latLngToEastingNorthing(lat, lng);
      const [backLat, backLng] = eastingNorthingToLatLng(e, n);
      expect(backLat).toBeCloseTo(lat, 7);
      expect(backLng).toBeCloseTo(lng, 7);
    }
  });
});

describe('formatGridRef', () => {
  /**
   * Summits with widely published grid references, checked against their
   * published WGS84 positions. Wikipedia's summit coordinates are given to the
   * nearest arcsecond (~30 m), so these are asserted at 100 m precision.
   */
  it.each([
    ['Scafell Pike', 54.4542, -3.2116, 'NY 215 072'],
    ['Snowdon / Yr Wyddfa', 53.06861, -4.07611, 'SH 609 543'],
    ['Ben Nevis', 56.79694, -5.00333, 'NN 166 712']
  ])('gives %s its published grid reference', (_name, lat, lng, expected) => {
    expect(formatGridRef(lat, lng, 3)).toBe(expected);
  });

  it('picks the right 100 km square letters across the grid', () => {
    // One per corner of the country, so a wrong letter table shows up as a
    // square in the wrong row or column rather than a near miss.
    expect(formatGridRef(49.92226394, -6.29977752, 3)?.slice(0, 2)).toBe('SV'); // Scillies
    expect(formatGridRef(51.48936565, -0.11992557, 3)?.slice(0, 2)).toBe('TQ'); // London
    expect(formatGridRef(55.92478266, -3.29479219, 3)?.slice(0, 2)).toBe('NT'); // Edinburgh
    expect(formatGridRef(59.85409914, -1.27486910, 3)?.slice(0, 2)).toBe('HU'); // Shetland
    expect(formatGridRef(54.32919541, -4.38849118, 3)?.slice(0, 2)).toBe('SC'); // Isle of Man
  });

  it('never emits the letter I, which the grid skips', () => {
    // The 5x5 lettering runs A-Z omitting I. An off-by-one in that shuffle is
    // invisible on a single point but wrong for a whole band of the country.
    for (const [, lat, lng] of OS_TEST_POINTS) {
      expect(formatGridRef(lat, lng, 3)?.slice(0, 2)).not.toMatch(/I/);
    }
  });

  it('cuts the digits to the requested precision', () => {
    // Same point, three precisions: 100 m, 10 m, 1 m. Each is the one above
    // with another digit revealed, never rounded up.
    expect(formatGridRef(54.4542, -3.2116, 3)).toBe('NY 215 072');
    expect(formatGridRef(54.4542, -3.2116, 4)).toBe('NY 2154 0721');
    expect(formatGridRef(54.4542, -3.2116, 5)).toBe('NY 21544 07210');
  });

  it('pads short easting/northing digits with leading zeros', () => {
    // TP31 sits at easting 9,587 — without padding this reads "NF 95 899",
    // which points at a different square entirely.
    const ref = formatGridRef(57.81351838, -8.57854456, 3);
    expect(ref).toBe('NF 095 994');
  });

  it('defaults to 10 m precision', () => {
    expect(formatGridRef(54.4542, -3.2116)).toBe(formatGridRef(54.4542, -3.2116, 4));
  });

  it('returns null off the grid', () => {
    expect(formatGridRef(48.8566, 2.3522)).toBeNull(); // Paris
    expect(formatGridRef(50, -20)).toBeNull(); // mid-Atlantic
    expect(formatGridRef(62.5, -1.2)).toBeNull(); // north of Shetland
    expect(formatGridRef(60.39, 5.32)).toBeNull(); // Bergen
    expect(formatGridRef(0, 0)).toBeNull(); // Gulf of Guinea
  });

  it('still covers Shetland, which is on the grid', () => {
    // The northern islands are the case most easily lost to an over-tight
    // bound: they sit above the 1,000 km line, in the H squares.
    expect(formatGridRef(60.13308092, -2.07382823, 3)).toBe('HT 959 387');
    expect(formatGridRef(59.53470794, -1.62516966, 3)).toBe('HZ 213 721');
  });
});

describe('parseGridRef', () => {
  const SCAFELL_PIKE: [number, number] = [54.4542, -3.2116];

  it.each([
    'NY 215 072',
    'NY215072',
    'ny 215 072',
    'ny215072',
    '  NY  215  072  ',
    'NY\t215 072'
  ])('accepts %j', (input) => {
    const parsed = parseGridRef(input);
    expect(parsed).not.toBeNull();
    // Within a 100 m square of the summit, which is all a 3-digit ref promises.
    const [lat, lng] = parsed!;
    expect(Math.abs(lat - SCAFELL_PIKE[0]) * 111320).toBeLessThan(150);
    expect(Math.abs(lng - SCAFELL_PIKE[1]) * 111320 * Math.cos(54.45 * Math.PI / 180))
      .toBeLessThan(150);
  });

  it('accepts every even digit count from none to ten', () => {
    for (const ref of ['NY', 'NY 2 0', 'NY 21 07', 'NY 215 072', 'NY 2154 0721', 'NY 21544 07210']) {
      expect(parseGridRef(ref)).not.toBeNull();
    }
  });

  it('aims at the middle of the square, not its corner', () => {
    // "NY" alone means the whole 100 km square, so it should resolve to that
    // square's centre — 50 km east and north of its south-west corner.
    const square = parseGridRef('NY')!;
    const corner = eastingNorthingToLatLng(300000, 500000);
    expect(square[0]).toBeGreaterThan(corner[0]);
    expect(square[1]).toBeGreaterThan(corner[1]);
    const { e, n } = latLngToEastingNorthing(square[0], square[1]);
    expect(e).toBeCloseTo(350000, -1);
    expect(n).toBeCloseTo(550000, -1);
  });

  it.each([
    ['', 'empty'],
    ['banana', 'not a grid reference'],
    ['NY 12345', 'an odd number of digits'],
    ['NY 123456789012', 'more digits than 1 m precision'],
    ['IY 123 456', 'uses the skipped letter I'],
    ['NI 123 456', 'uses the skipped letter I second'],
    ['N 123 456', 'only one letter'],
    ['NYY 123 456', 'three letters'],
    ['123 456', 'no letters'],
    ['NY 12a 456', 'a letter among the digits'],
    ['ZZ 123 456', 'a letter pair off the grid']
  ])('rejects %j (%s)', (input) => {
    expect(parseGridRef(input)).toBeNull();
  });

  it('round trips through formatGridRef', () => {
    for (const [, lat, lng] of OS_TEST_POINTS) {
      const ref = formatGridRef(lat, lng, 5);
      expect(ref).not.toBeNull();
      const [backLat, backLng] = parseGridRef(ref!)!;
      // A 1 m reference names a 1 m square; parsing returns its centre, so the
      // worst case is half a metre on each axis.
      expect(Math.abs(backLat - lat) * 111320).toBeLessThan(1);
      expect(Math.abs(backLng - lng) * 111320 * Math.cos((lat * Math.PI) / 180)).toBeLessThan(1);
    }
  });
});
