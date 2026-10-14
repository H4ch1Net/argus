// What is at a point, as an address names it: Photon's reverse geocoder
// (komoot, OSM data) through the proxy feed 'photon-reverse', for the map's
// WHAT'S HERE sheet (a long press or right click) and the place an
// intersection is in. Live-tested Oct 2026: 33.71491, -116.21031 answers
// "46th Avenue", Indio, California; 33.71306, -116.21643 "Jackson Street",
// Indio. One answer per ~1 m (five decimals), remembered for the session;
// the proxy caches a day. Pure apart from the injected proxy client.

import { PHOTON_REVERSE_FEED, PHOTON_REVERSE_PATH } from './region.js';

const text = (v, max = 80) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
// Countries whose addresses put the house number before the street.
const NUMBER_FIRST = new Set(['US', 'CA', 'GB', 'IE', 'AU', 'NZ', 'FR']);

/** Proxy params for a point (five decimals, one answer), or null off the globe. */
export function reverseParams(lat, lon, decimals = 5) {
  const la = Number(lat);
  const lo = Number(lon);
  if (
    !Number.isFinite(la) ||
    !Number.isFinite(lo) ||
    Math.abs(la) > 90 ||
    Math.abs(lo) > 180
  )
    return null;
  const r = (v) => String(Number(v.toFixed(decimals)));
  return { lat: r(la), lon: r(lo), limit: '1' };
}

/**
 * Photon reverse GeoJSON -> { name, detail, city, state, country } or null:
 * name "46211 Jackson Street" for an address, the place's own name ("Indio
 * Fashion Mall"), else the street; detail where it is ("Indio, California").
 */
export function parseReverse(json) {
  const p = (Array.isArray(json?.features) ? json.features : [])[0]?.properties;
  if (!p) return null;
  const cc = text(p.countrycode, 4).toUpperCase();
  const street = (
    NUMBER_FIRST.has(cc) ? [p.housenumber, p.street] : [p.street, p.housenumber]
  )
    .map((x) => text(x))
    .filter(Boolean)
    .join(' ');
  const own = text(p.name);
  const name = own || street;
  const city = text(p.city) || text(p.town) || text(p.village) || text(p.district) || '';
  const parts = [];
  for (const v of [own && street !== own ? street : '', city, text(p.state)])
    if (v && !parts.includes(v) && v !== name) parts.push(v);
  if (!name && !parts.length) return null;
  return {
    name: name || parts.shift(),
    detail: parts.join(', '),
    city,
    state: text(p.state),
    country: text(p.country),
  };
}

const MEMO_MAX = 64;
const memo = new Map(); // "lat,lon" -> Promise

/**
 * What is at lat, lon (memoised per point for the session; a failure is not
 * kept). Resolves null when nothing answers.
 * @param {{ getJson: Function }|null} proxyClient
 */
export function reversePlace(proxyClient, lat, lon, { signal, decimals = 5 } = {}) {
  const params = reverseParams(lat, lon, decimals);
  if (!proxyClient || !params) return Promise.resolve(null);
  const key = `${params.lat},${params.lon}`;
  if (memo.has(key)) return memo.get(key);
  const ask = proxyClient
    .getJson(PHOTON_REVERSE_FEED, PHOTON_REVERSE_PATH, { params, signal })
    .then(parseReverse)
    .catch(() => null)
    .then((r) => {
      if (!r) memo.delete(key);
      return r;
    });
  memo.set(key, ask);
  while (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value);
  return ask;
}

/** Forget every remembered answer (tests). */
export function resetReverseMemo() {
  memo.clear();
}
