// Where the user is, as an address would name it (town, state, country), so
// a bare street address can be looked up in the right state. Photon's reverse
// geocoder (komoot, OSM data) through the proxy feed 'photon-reverse'; one
// question per ~10 km square per session (memo), and the proxy caches too.
// Live-tested Oct 2026: 33.7, -116.2 answers a street in Coachella with
// state "California", countrycode "US" and postcode "92201". Pure apart from
// the injected proxy client.

export const PHOTON_REVERSE_FEED = 'photon-reverse';
export const PHOTON_REVERSE_PATH = '/reverse';

/** Rounded to 0.1 degree, so nearby positions share one question and cache entry. */
export function regionParams(near) {
  const lat = Number(near?.lat ?? near?.latitude);
  const lon = Number(near?.lon ?? near?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const r = (v) => String(Number(v.toFixed(1)));
  return { lat: r(lat), lon: r(lon), limit: '1' };
}

const text = (v, max = 80) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Photon reverse GeoJSON -> { city, state, country, countryCode, postcode } or null. */
export function parseRegion(json) {
  const p = (Array.isArray(json?.features) ? json.features : [])[0]?.properties;
  if (!p) return null;
  const out = {
    city: text(p.city) || text(p.town) || text(p.village) || text(p.district) || null,
    state: text(p.state) || null,
    country: text(p.country) || null,
    countryCode: text(p.countrycode, 4).toUpperCase() || null,
    postcode: text(p.postcode, 12) || null,
  };
  return out.state || out.countryCode ? out : null;
}

const MEMO_MAX = 32;

/**
 * A memoised lookup: (near, signal) => Promise<region|null>. A failed or
 * empty answer is not kept (asked again next time).
 * @param {{ getJson: Function }} proxyClient
 */
export function createRegionLookup(proxyClient) {
  const memo = new Map(); // "lat,lon" -> Promise<region|null>
  return (near, signal) => {
    const params = regionParams(near);
    if (!proxyClient || !params) return Promise.resolve(null);
    const key = `${params.lat},${params.lon}`;
    if (memo.has(key)) return memo.get(key);
    const ask = proxyClient
      .getJson(PHOTON_REVERSE_FEED, PHOTON_REVERSE_PATH, { params, signal })
      .then(parseRegion)
      .then((r) => {
        if (!r) memo.delete(key);
        return r;
      })
      .catch((err) => {
        memo.delete(key);
        throw err;
      });
    memo.set(key, ask);
    while (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value);
    return ask;
  };
}

// The lookup every caller shares: the memo outlives the proxy client, which
// is only the transport (the navigator wraps its client per search).
let transport = null;
let shared = createRegionLookup({ getJson: (...a) => transport.getJson(...a) });

/** The user's region near `near` (memoised per area for the session). */
export function regionNear(proxyClient, near, signal) {
  if (!proxyClient) return Promise.resolve(null);
  transport = proxyClient;
  return shared(near, signal);
}

/** Forget every remembered region (tests). */
export function resetRegionMemo() {
  shared = createRegionLookup({ getJson: (...a) => transport.getJson(...a) });
}
