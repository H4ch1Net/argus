// Local-first ranking for place search: how well a result's text matches the
// query, plus a bonus for a town or country named as typed, less a penalty
// for how far it is from the user (their own position, else the middle of
// the view). Within ~300 km the nearer of two similar matches wins; a result
// farther than that comes first only when its text matches clearly better (a
// house number the near ones lack, an exact name against a partial one), and
// among far results the provider's own order stands. Live-checked Oct 2026
// against Photon near Indio, CA: "walmart" now leads with the stores in
// Coachella and Indio rather than Palm Springs and San Jacinto, "fresno" is
// still the city. (Photon's own location_bias_scale and zoom were tried and
// left alone: a stronger bias lost Paris, France for "paris".) Pure: the
// navigator, the search launcher and the terminal share it.
//
// Places here are { name, detail?, lat, lon } (core/nav/search.js) or
// { name, latitude, longitude } (core/search/geocoder.js); both are read.

/** Beyond this a result is "far": it needs a clearly better text match. */
export const LOCAL_RADIUS_KM = 300;

// Street words and their usual abbreviations, one spelling each, so
// "Jackson Street" matches "JACKSON ST" (US Census) and "jackson st".
const CANON = new Map(
  Object.entries({
    street: 'st',
    avenue: 'ave',
    av: 'ave',
    boulevard: 'blvd',
    road: 'rd',
    drive: 'dr',
    lane: 'ln',
    court: 'ct',
    place: 'pl',
    parkway: 'pkwy',
    highway: 'hwy',
    terrace: 'ter',
    circle: 'cir',
    square: 'sq',
    trail: 'trl',
    mount: 'mt',
    fort: 'ft',
    north: 'n',
    south: 's',
    east: 'e',
    west: 'w',
    northeast: 'ne',
    northwest: 'nw',
    southeast: 'se',
    southwest: 'sw',
  }),
);

/** Lower case, accents off, words only, street words abbreviated. */
export function placeTokens(s) {
  return (
    String(s ?? '')
      .toLowerCase()
      .normalize('NFKD')
      // Combining marks (U+0300-036F), spelled out.
      .replace(/[̀-ͯ]/g, '')
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .map((t) => CANON.get(t) ?? t)
  );
}

const has = (list, t, prefix) =>
  list.some((x) => x === t || (prefix && t.length >= 2 && x.startsWith(t)));

/**
 * 0..1: 1 the name is the query; 0.95 the name starts with it (whole words,
 * the last one may be half typed); 0.75 every query word is in the name;
 * 0.65 every word is in the name or where it is; else a share of 0.5. A
 * house number in the query that the result lacks costs it the number's
 * share: a street is not the address.
 */
export function textScore(query, name, detail = '') {
  const q = placeTokens(query);
  if (!q.length) return 0;
  const n = placeTokens(name);
  const all = [...n, ...placeTokens(detail)];
  const last = q.length - 1;
  if (n.length === q.length && n.every((t, i) => t === q[i])) return 1;
  if (
    n.length >= q.length &&
    q.every((t, i) => t === n[i] || (i === last && t.length >= 2 && n[i].startsWith(t)))
  )
    return 0.95;
  const inName = q.filter((t, i) => has(n, t, i === last)).length;
  const inAll = q.filter((t, i) => has(all, t, i === last)).length;
  const numbers = q.filter((t) => /^\d/.test(t));
  const numberMissing = numbers.some((t) => !all.includes(t));
  if (!numberMissing && inName === q.length) return 0.75;
  if (!numberMissing && inAll === q.length) return 0.65;
  return (0.5 * inAll) / q.length;
}

const R = 6371;
/** Great-circle distance in km. */
export function distanceKm(aLat, aLon, bLat, bLon) {
  const r = Math.PI / 180;
  const h =
    Math.sin(((bLat - aLat) * r) / 2) ** 2 +
    Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(((bLon - aLon) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The cost of distance: 0 here, growing with the square root to 0.3 at
 * LOCAL_RADIUS_KM, and no more beyond it: among far results the provider's
 * own order (its sense of importance) decides. Null distance: none.
 */
export function distancePenalty(km) {
  if (!Number.isFinite(km) || km < 0) return 0;
  return 0.3 * Math.sqrt(Math.min(km, LOCAL_RADIUS_KM) / LOCAL_RADIUS_KM);
}

// A town or country named exactly as typed is what was meant, however far
// ("Fresno" from Indio is the city, not a street named Fresno in Tijuana):
// settlements get a bonus by size that outweighs distance, so between two of
// them the nearer one still wins. OSM classes (Photon, Nominatim), the bundled
// cities ('city') and TomTom's 'geography'.
const SETTLEMENTS = [
  [
    /^(place=(city|state|country|county|province|region)|boundary=administrative|city|geography)$/,
    0.35,
  ],
  [/^place=town$/, 0.3],
  [/^place=(village|municipality|borough|suburb)$/, 0.2],
  [/^place=(hamlet|locality|neighbourhood|quarter|isolated_dwelling)$/, 0.1],
];

/** The bonus for a result of this kind whose name matches the query (0 for most). */
export function kindBonus(kind) {
  const k = String(kind ?? '').toLowerCase();
  for (const [re, bonus] of SETTLEMENTS) if (re.test(k)) return bonus;
  return 0;
}

/** One result's rank: text match, a settlement's bonus, less distance. */
export function placeScore(query, place, km = null) {
  const text = textScore(query, place.name, place.detail ?? '');
  const bonus = text >= 0.95 ? kindBonus(place.kind) : 0;
  return text + bonus - distancePenalty(km);
}

const latOf = (p) => Number(p.lat ?? p.latitude);
const lonOf = (p) => Number(p.lon ?? p.longitude);
const validNear = (near) => {
  const lat = Number(near?.lat ?? near?.latitude);
  const lon = Number(near?.lon ?? near?.longitude);
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90
    ? { lat, lon }
    : null;
};

/**
 * Sort places best first: text match less distance cost; equal scores keep
 * the order given (the provider's own relevance). The same name again within
 * 200 m of one kept is dropped.
 * @template P
 * @param {string} query
 * @param {P[]} places
 * @param {{ near?: {lat:number, lon:number}|null, limit?: number }} [opts]
 * @returns {P[]}
 */
export function rankPlaces(query, places, { near = null, limit = Infinity } = {}) {
  const here = validNear(near);
  const scored = (places ?? [])
    .filter((p) => p && Number.isFinite(latOf(p)) && Number.isFinite(lonOf(p)))
    .map((p, i) => {
      const km = here ? distanceKm(here.lat, here.lon, latOf(p), lonOf(p)) : null;
      const score = placeScore(query, p, km);
      return { p, i, score };
    })
    .sort((a, b) => b.score - a.score || a.i - b.i);
  const out = [];
  const key = (p) => placeTokens(p.name).join(' ');
  for (const { p } of scored) {
    const dup = out.some(
      (q) =>
        key(q) === key(p) && distanceKm(latOf(q), lonOf(q), latOf(p), lonOf(p)) < 0.2,
    );
    if (!dup) out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}
