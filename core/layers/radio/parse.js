// Public radio stations with coordinates, from the Radio Browser directory
// (public domain, PDDL 1.0). Pure.
//
// Fields read (as the reference project does): stationuuid, name, geo_lat,
// geo_long, url_resolved || url, homepage, tags, language, country,
// countrycode, state, codec, bitrate, clickcount, lastcheckok, hls. Broken
// stations, HLS-only streams and non-https streams are dropped; favicons are
// never fetched (they would load third-party images straight into the page).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const num = (v) => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const text = (v, max = 100) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
const httpsUrl = (v) => {
  try {
    const u = new URL(String(v));
    return u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
};

/** Query parameters for the proxy request: the most-listened stations with a location. */
export function radioQuery(limit = 1500) {
  return {
    has_geo_info: 'true',
    is_https: 'true',
    hidebroken: 'true',
    order: 'clickcount',
    reverse: 'true',
    limit,
  };
}

/**
 * @param {object[]} stations
 * @returns {object[]} normalized entities (type 'radio')
 */
export function parseRadio(stations) {
  const list = Array.isArray(stations) ? stations : [];
  const out = [];
  const seen = new Set();
  for (const s of list) {
    if (!s || !UUID.test(String(s.stationuuid)) || seen.has(s.stationuuid)) continue;
    if (s.lastcheckok != null && Number(s.lastcheckok) !== 1) continue;
    if (Number(s.hls) === 1) continue;
    const latitude = num(s.geo_lat);
    const longitude = num(s.geo_long);
    if (latitude === null || longitude === null) continue;
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) continue;
    if (latitude === 0 && longitude === 0) continue;
    const stream = httpsUrl(s.url_resolved || s.url);
    if (!stream) continue;
    seen.add(s.stationuuid);
    out.push({
      id: `radio:${s.stationuuid}`,
      type: 'radio',
      position: { longitude, latitude, altitude: 0 },
      meta: {
        name: text(s.name) || 'Radio station',
        stream,
        homepage: httpsUrl(s.homepage),
        tags: (text(s.tags, 300) || '')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
          .slice(0, 8),
        language: text(s.language, 60),
        country: text(s.country, 60),
        countryCode: text(s.countrycode, 4),
        state: text(s.state, 60),
        codec: text(s.codec, 16),
        bitrate: num(s.bitrate),
        clicks: num(s.clickcount),
      },
    });
  }
  return out;
}
