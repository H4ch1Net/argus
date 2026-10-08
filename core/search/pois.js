// City landmarks for quick fly-to: a few cities, each with five public
// landmarks and a hand-tuned view of each. Pure (no Cesium, no DOM): the TOOLS
// menu (core/ui/poiTool.js) lists them and global search can match them.
//
// Adapted from gods-eye-view src/locations.js (MIT): the cities, landmark
// coordinates and camera views (CITY_POIS there). The city centre here is the
// middle of the reference's viewBounds. Austin's "The Jenga Tower" is left out:
// it is a residential condominium tower, and inputs here are public places,
// never homes or people (project guardrail). Every landmark kept is a public
// building, monument, bridge, square or port.
//
// View fields, as in the reference:
//   alt      the viewing RANGE in metres from the landmark, not an altitude
//   heading  compass degrees the view looks toward (0 north, 90 east)
//   pitch    degrees, negative looks down
//   targetM  the landmark's centre above the ground (the reference's
//            buildingHeight), so the view frames the building, not its base
// groundM on a city is the reference's fallback ground height (metres) for
// when terrain is not loaded yet.

import { normalizePlaceName } from './places.js';

/** Defaults for a landmark view that lacks a field. */
export const POI_VIEW_DEFAULTS = Object.freeze({
  alt: 1500,
  heading: 0,
  pitch: -35,
  targetM: 0,
});

// [id, city, centre lat, centre lon, groundM, rows]; each row is
// [name, lat, lon, alt (range m), heading, pitch, targetM].
const RAW = [
  [
    'austin',
    'Austin',
    30.31,
    -97.75,
    150,
    [
      ['Texas State Capitol', 30.2747, -97.7403, 550, 180, -28, 35],
      ['Frost Bank Tower', 30.2674, -97.7434, 550, 30, -22, 80],
      ['Pennybacker Bridge', 30.3451, -97.7951, 500, 90, -25, 40],
      ['UT Tower', 30.2862, -97.7394, 500, 180, -22, 50],
    ],
  ],
  [
    'sf',
    'San Francisco',
    37.77,
    -122.44,
    15,
    [
      ['Golden Gate Bridge', 37.8199, -122.4783, 1400, 45, -20, 100],
      ['Transamerica Pyramid', 37.7952, -122.4028, 500, 30, -25, 85],
      ['Salesforce Tower', 37.7897, -122.3972, 680, 330, -25, 100],
      ['Alcatraz Island', 37.8267, -122.423, 800, 0, -30, 20],
      ['Coit Tower', 37.8024, -122.4058, 420, 45, -30, 30],
    ],
  ],
  [
    'nyc',
    'New York',
    40.6975,
    -73.9795,
    10,
    [
      ['Statue of Liberty', 40.6892, -74.0445, 450, 315, -25, 45],
      ['Empire State Building', 40.7484, -73.9857, 850, 30, -12, 130],
      ['One World Trade Center', 40.7127, -74.0134, 850, 0, -25, 170],
      ['Brooklyn Bridge', 40.7061, -73.9969, 850, 45, -25, 40],
      ['Chrysler Building', 40.7516, -73.9755, 700, 225, -20, 100],
    ],
  ],
  [
    'tokyo',
    'Tokyo',
    35.71,
    139.735,
    40,
    [
      ['Tokyo Tower', 35.6586, 139.7454, 850, 0, -25, 110],
      ['Tokyo Skytree', 35.7101, 139.8107, 900, 30, -25, 200],
      ['Imperial Palace', 35.6852, 139.7528, 900, 0, -35, 20],
      ['Senso-ji Temple', 35.7148, 139.7967, 400, 180, -30, 25],
      ['Mode Gakuen Cocoon Tower', 35.6929, 139.6925, 350, 30, -20, 70],
    ],
  ],
  [
    'london',
    'London',
    51.49,
    -0.09,
    15,
    [
      ['Tower Bridge', 51.5055, -0.0754, 400, 270, -25, 65],
      ['The Shard', 51.5045, -0.0865, 850, 0, -20, 100],
      ['Big Ben / Parliament', 51.5007, -0.1246, 600, 180, -25, 50],
      ["St. Paul's Cathedral", 51.5138, -0.0984, 400, 270, -30, 55],
      ['The Gherkin', 51.5145, -0.0803, 350, 30, -20, 60],
    ],
  ],
  [
    'paris',
    'Paris',
    48.8585,
    2.347,
    35,
    [
      ['Eiffel Tower', 48.8584, 2.2945, 750, 315, -25, 150],
      ['Arc de Triomphe', 48.8738, 2.295, 400, 45, -28, 25],
      ['Notre-Dame', 48.853, 2.3499, 400, 225, -25, 35],
      ['Sacré-Cœur', 48.8867, 2.3431, 400, 180, -30, 40],
      ['Louvre Pyramid', 48.8606, 2.3376, 500, 0, -35, 10],
    ],
  ],
  [
    'dubai',
    'Dubai',
    25.15,
    55.225,
    5,
    [
      ['Burj Khalifa', 25.1972, 55.2744, 600, 200, -20, 270],
      ['Burj Al Arab', 25.1412, 55.1853, 500, 90, -25, 100],
      ['Palm Jumeirah', 25.1124, 55.139, 1200, 0, -40, 20],
      ['Dubai Frame', 25.235, 55.3003, 400, 270, -25, 75],
      ['Museum of the Future', 25.2197, 55.2806, 350, 30, -20, 35],
    ],
  ],
  [
    'dc',
    'Washington DC',
    38.8925,
    -77.015,
    10,
    [
      ['US Capitol', 38.8897, -77.0091, 550, 270, -25, 45],
      ['Washington Monument', 38.8895, -77.0353, 500, 0, -30, 85],
      ['Lincoln Memorial', 38.8893, -77.0502, 400, 90, -25, 20],
      ['Pentagon', 38.8711, -77.0559, 800, 0, -40, 20],
      ['Jefferson Memorial', 38.8814, -77.0365, 400, 0, -30, 25],
    ],
  ],
  [
    'tallinn',
    'Tallinn',
    59.44,
    24.76,
    15,
    [
      ['Viru Square', 59.4366, 24.7527, 450, 60, -28, 25],
      ['Old Town / Raekoja plats', 59.4372, 24.7452, 400, 180, -30, 20],
      ['Teatri väljak', 59.4344, 24.7514, 400, 220, -25, 25],
      ['Port of Tallinn', 59.4445, 24.7675, 700, 90, -30, 20],
      ['Ülemiste', 59.421, 24.792, 600, 45, -28, 30],
    ],
  ],
];

/**
 * @type {ReadonlyArray<{ id: string, city: string, lat: number, lon: number,
 *   groundM: number, pois: ReadonlyArray<{ name: string, lat: number, lon: number,
 *   alt: number, heading: number, pitch: number, targetM: number }> }>}
 */
export const CITY_POIS = Object.freeze(
  RAW.map(([id, city, lat, lon, groundM, rows]) =>
    Object.freeze({
      id,
      city,
      lat,
      lon,
      groundM,
      pois: Object.freeze(
        rows.map(([name, pLat, pLon, alt, heading, pitch, targetM]) =>
          Object.freeze({ name, lat: pLat, lon: pLon, alt, heading, pitch, targetM }),
        ),
      ),
    }),
  ),
);

/**
 * The fly-to view for a landmark, defaults filled in:
 * { lon, lat, alt (range m), heading, pitch, targetM }.
 */
export function poiView(poi) {
  const pick = (k) =>
    typeof poi?.[k] === 'number' && Number.isFinite(poi[k])
      ? poi[k]
      : POI_VIEW_DEFAULTS[k];
  return {
    lon: poi.lon,
    lat: poi.lat,
    alt: pick('alt'),
    heading: pick('heading'),
    pitch: pick('pitch'),
    targetM: pick('targetM'),
  };
}

// normalizePlaceName drops what NFD cannot split (œ in Sacré-Cœur), so the
// ligatures are spelled out first.
const fold = (s) =>
  normalizePlaceName(
    String(s ?? '')
      .replace(/[œŒ]/g, 'oe')
      .replace(/[æÆ]/g, 'ae')
      .replace(/ß/g, 'ss'),
  );
const STOP = new Set(['the', 'of', 'a', 'an', 'at', 'in', 'on', 'to']);
const words = (s) => s.split(' ').filter((w) => w && !STOP.has(w));

const INDEX = CITY_POIS.flatMap((c, ci) =>
  c.pois.map((poi, pi) => {
    const n = fold(poi.name);
    const city = fold(c.city);
    return {
      entry: { ...poi, city: c.city, cityId: c.id, label: `${poi.name}, ${c.city}` },
      order: ci * 100 + pi,
      n,
      bare: n.replace(/^the /, ''),
      prefixes: [city, c.id],
      nameWords: words(n),
      cityWords: [...words(city), c.id],
    };
  }),
);

function score(p, q, qWords) {
  if (p.n === q || p.bare === q) return 0;
  if (p.prefixes.some((c) => `${c} ${p.n}` === q || `${c} ${p.bare}` === q)) return 0;
  if (p.n.startsWith(q) || p.bare.startsWith(q)) return 1;
  // "city landmark-prefix", once the query reaches past the city's name.
  if (p.prefixes.some((c) => q.length > c.length + 1 && `${c} ${p.bare}`.startsWith(q)))
    return 1;
  if (!qWords.length) return null;
  // Word prefixes in any order ("eiffel paris", "liberty statue", "nyc empire").
  let named = false;
  for (const w of qWords) {
    if (p.nameWords.some((x) => x.startsWith(w))) named = true;
    else if (!p.cityWords.some((x) => x.startsWith(w))) return null;
  }
  return named ? 2 : 3; // 3: the query names only the city, so all of its landmarks
}

/**
 * Landmark search: the landmark's name, or "city landmark" ("paris eiffel",
 * "nyc empire state"), case, accent and word-order insensitive. Exact names
 * first, then name prefixes, then word prefixes; a bare city name lists that
 * city's landmarks last.
 * @param {string} query
 * @param {{ limit?: number }} [opts]
 * @returns {Array<{ name: string, city: string, cityId: string, label: string,
 *   lat: number, lon: number, alt: number, heading: number, pitch: number,
 *   targetM: number, exact: boolean }>}
 */
export function searchPois(query, { limit = 5 } = {}) {
  const q = fold(query);
  if (q.length < 2) return [];
  const qWords = words(q);
  const hits = [];
  for (const p of INDEX) {
    const s = score(p, q, qWords);
    if (s !== null) hits.push({ p, s });
  }
  return hits
    .sort((a, b) => a.s - b.s || a.p.order - b.p.order)
    .slice(0, Math.max(0, limit))
    .map(({ p, s }) => ({ ...p.entry, exact: s === 0 }));
}

const R_KM = 6371.0088;
const RAD = Math.PI / 180;
function haversineKm(lat1, lon1, lat2, lon2) {
  const h =
    Math.sin(((lat2 - lat1) * RAD) / 2) ** 2 +
    Math.cos(lat1 * RAD) *
      Math.cos(lat2 * RAD) *
      Math.sin(((lon2 - lon1) * RAD) / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Landmarks within km of a point, nearest first, each with its distanceKm.
 * @returns {Array<object>} entries shaped as searchPois results (without exact)
 */
export function poisNear(lat, lon, km = 25) {
  if (![lat, lon, km].every(Number.isFinite)) return [];
  const out = [];
  for (const p of INDEX) {
    const distanceKm = haversineKm(lat, lon, p.entry.lat, p.entry.lon);
    if (distanceKm <= km) out.push({ ...p.entry, distanceKm });
  }
  return out.sort((a, b) => a.distanceKm - b.distanceKm);
}
