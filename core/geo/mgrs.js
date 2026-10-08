// MGRS and DMS formatting for readouts (the Intel HUD, cards, the terminal).
// Pure: no Cesium, no DOM, no dependencies. WGS84 UTM by the Krueger series
// (Karney 2011, sixth order in n), accurate to well under a millimetre inside
// a zone, so the 1 m MGRS digits are exact up to truncation.
//
// MGRS = grid zone (UTM zone + 8 degree latitude band) + 100 km square letters
// + easting/northing digits inside that square. Covers -80..84 latitude; the
// polar caps (UPS) are out of scope and return null.

const A = 6378137; // WGS84 semi-major axis (m)
const F = 1 / 298.257223563; // WGS84 flattening
const K0 = 0.9996; // UTM central scale factor
const FALSE_EASTING = 500000;
const FALSE_NORTHING_SOUTH = 10000000;

const N = F / (2 - F); // third flattening
const E = Math.sqrt(F * (2 - F)); // first eccentricity
// Rectifying radius: the meridian arc length per radian of rectifying latitude.
const RECT_A = (A / (1 + N)) * (1 + N ** 2 / 4 + N ** 4 / 64 + N ** 6 / 256);
// Krueger alpha coefficients (forward projection), sixth order in n.
const ALPHA = [
  N / 2 -
    (2 * N ** 2) / 3 +
    (5 * N ** 3) / 16 +
    (41 * N ** 4) / 180 -
    (127 * N ** 5) / 288 +
    (7891 * N ** 6) / 37800,
  (13 * N ** 2) / 48 -
    (3 * N ** 3) / 5 +
    (557 * N ** 4) / 1440 +
    (281 * N ** 5) / 630 -
    (1983433 * N ** 6) / 1935360,
  (61 * N ** 3) / 240 -
    (103 * N ** 4) / 140 +
    (15061 * N ** 5) / 26880 +
    (167603 * N ** 6) / 181440,
  (49561 * N ** 4) / 161280 - (179 * N ** 5) / 168 + (6601661 * N ** 6) / 7257600,
  (34729 * N ** 5) / 80640 - (3418889 * N ** 6) / 1995840,
  (212378941 * N ** 6) / 319334400,
];

const RAD = Math.PI / 180;

// Latitude bands, 8 degrees each from -80; X is stretched to 84 (12 degrees).
const BANDS = 'CDEFGHJKLMNPQRSTUVWX';
// 100 km column letters cycle through three sets by zone; rows through 20
// letters, offset by 5 for even zones (the "AA" lettering scheme).
const COL_SETS = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'];
const ROWS = 'ABCDEFGHJKLMNPQRSTUV';

/** Wrap a longitude into [-180, 180). */
function wrapLon(lon) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/**
 * UTM zone number for a point, with the Norway (32V) and Svalbard (31X, 33X,
 * 35X, 37X) exceptions.
 * @param {number} lat degrees
 * @param {number} lon degrees
 * @returns {number} 1..60
 */
export function utmZone(lat, lon) {
  const lo = wrapLon(lon);
  let zone = Math.floor((lo + 180) / 6) + 1;
  if (zone > 60) zone = 60;
  // Norway: zone 32V is widened west to 3E (32V covers 3..12E).
  if (lat >= 56 && lat < 64 && lo >= 3 && lo < 12) zone = 32;
  // Svalbard: band X uses only the odd zones 31, 33, 35 and 37 between 0 and 42E.
  if (lat >= 72 && lat <= 84 && lo >= 0 && lo < 42) {
    if (lo < 9) zone = 31;
    else if (lo < 21) zone = 33;
    else if (lo < 33) zone = 35;
    else zone = 37;
  }
  return zone;
}

/**
 * MGRS latitude band letter, or null outside -80..84.
 * @param {number} lat degrees
 */
export function latBand(lat) {
  if (!(lat >= -80 && lat <= 84)) return null;
  return BANDS[Math.min(19, Math.floor((lat + 80) / 8))];
}

/**
 * WGS84 geographic to UTM.
 * @param {number} lat degrees
 * @param {number} lon degrees
 * @param {number} [zone] force a zone (default: utmZone(lat, lon))
 * @returns {{ zone: number, hemisphere: 'N'|'S', easting: number, northing: number }}
 */
export function toUtm(lat, lon, zone = utmZone(lat, lon)) {
  const lon0 = (zone - 1) * 6 - 180 + 3;
  let dLon = wrapLon(lon - lon0) * RAD;
  const phi = lat * RAD;
  const sinPhi = Math.sin(phi);
  // Conformal latitude via its tangent.
  const t = Math.sinh(Math.atanh(sinPhi) - E * Math.atanh(E * sinPhi));
  const xiP = Math.atan2(t, Math.cos(dLon));
  const etaP = Math.atanh(Math.sin(dLon) / Math.sqrt(1 + t * t));
  let xi = xiP;
  let eta = etaP;
  for (let j = 1; j <= 6; j++) {
    const a = ALPHA[j - 1];
    xi += a * Math.sin(2 * j * xiP) * Math.cosh(2 * j * etaP);
    eta += a * Math.cos(2 * j * xiP) * Math.sinh(2 * j * etaP);
  }
  const easting = FALSE_EASTING + K0 * RECT_A * eta;
  let northing = K0 * RECT_A * xi;
  const hemisphere = lat < 0 ? 'S' : 'N';
  if (hemisphere === 'S') northing += FALSE_NORTHING_SOUTH;
  return { zone, hemisphere, easting, northing };
}

/**
 * MGRS reference for a WGS84 point, e.g. "33U UP 04827 58405".
 * Digits are truncated (not rounded), as MGRS requires: a reference names the
 * square the point lies in.
 * @param {number} lat degrees
 * @param {number} lon degrees
 * @param {number} [precision] digits per axis, 0..5 (5 = 1 m, 4 = 10 m, ...)
 * @returns {string|null} null outside -80..84 latitude or for bad input
 */
export function toMgrs(lat, lon, precision = 5) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const band = latBand(lat);
  if (!band) return null;
  const p = Math.max(0, Math.min(5, Math.round(precision)));
  const { zone, easting, northing } = toUtm(lat, lon);
  const colIdx = Math.floor(easting / 100000) - 1; // 100 km column 1..8
  const cols = COL_SETS[(zone - 1) % 3];
  const col = cols[Math.max(0, Math.min(7, colIdx))];
  const rowIdx = Math.floor(northing / 100000) + (zone % 2 === 0 ? 5 : 0);
  const row = ROWS[((rowIdx % 20) + 20) % 20];
  const gzd = `${zone}${band} ${col}${row}`;
  if (p === 0) return gzd;
  const div = 10 ** (5 - p);
  const digits = (v) =>
    String(Math.floor((((v % 100000) + 100000) % 100000) / div)).padStart(p, '0');
  return `${gzd} ${digits(easting)} ${digits(northing)}`;
}

/** One axis as D°MM'SS" with the hemisphere letter; seconds rounded. */
function dmsAxis(value, degWidth, pos, neg) {
  const total = Math.round(Math.abs(value) * 3600); // whole arc-seconds
  const d = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const hemi = value < 0 && total > 0 ? neg : pos;
  return `${String(d).padStart(degWidth, '0')}°${String(m).padStart(2, '0')}'${String(s).padStart(2, '0')}"${hemi}`;
}

/**
 * Degrees, minutes, seconds, e.g. `48°51'24"N 002°21'08"E`.
 * @param {number} lat degrees
 * @param {number} lon degrees
 * @returns {string} empty for bad input
 */
export function toDms(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '';
  const lo = wrapLon(lon);
  // The antimeridian reads as 180E rather than 180W.
  return `${dmsAxis(lat, 2, 'N', 'S')} ${dmsAxis(lo === -180 ? 180 : lo, 3, 'E', 'W')}`;
}
