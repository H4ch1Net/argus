// Feed registry, Navigation and tools: routing, places, enrichment, traces, receivers.
// Same Feed shape as proxy/feeds.js (see its typedefs); spread into that list.
// eslint-disable-next-line no-unused-vars
import { UA, exactPath, MINUTE, HOUR } from './common.js';

// --- Directions (OSRM) ---------------------------------------------------------
// A route path is one FOSSGIS service paired with its own OSRM profile, then 2
// to 12 "lon,lat" stops. A regex cannot check distances, so the allowlist entry
// is a RegExp whose test() also requires every stop on the globe, each
// straight-line leg <= 600 km and the total <= 2,500 km (the limits
// core/route/osrm.js applies before asking). A request made straight at
// /feed/osrm therefore cannot drive heavy routing work either.
const OSRM_MAX_LEG_KM = 600;
const OSRM_MAX_TOTAL_KM = 2500;
const OSRM_COORD = String.raw`-?\d{1,3}(?:\.\d{1,7})?,-?\d{1,2}(?:\.\d{1,7})?`;
const OSRM_ROUTE = new RegExp(
  String.raw`^\/(?:routed-car\/route\/v1\/driving|routed-foot\/route\/v1\/foot|routed-bike\/route\/v1\/bike)\/` +
    `(${OSRM_COORD}(?:;${OSRM_COORD}){1,11})$`,
);

function greatCircleKm([lon1, lat1], [lon2, lat2]) {
  const r = Math.PI / 180;
  const h =
    Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** True when "lon,lat;lon,lat..." is on the globe and within the leg and total limits. */
export function osrmStopsAllowed(coords) {
  const pts = String(coords)
    .split(';')
    .map((p) => p.split(',').map(Number));
  if (pts.some(([lon, lat]) => !(Math.abs(lon) <= 180 && Math.abs(lat) <= 90)))
    return false;
  let total = 0;
  for (let i = 1; i < pts.length; i += 1) {
    const km = greatCircleKm(pts[i - 1], pts[i]);
    if (km > OSRM_MAX_LEG_KM) return false;
    total += km;
  }
  return total <= OSRM_MAX_TOTAL_KM;
}

class OsrmRoutePath extends RegExp {
  test(pathname) {
    const m = OSRM_ROUTE.exec(String(pathname));
    return !!m && osrmStopsAllowed(m[1]);
  }
}

// Exactly these query keys, each pinned: GeoJSON geometry (what the parser
// reads), a single route (no alternatives: no heavy use), maneuvers optional.
const OSRM_QUERY = {
  overview: ['full', 'simplified', 'false'],
  geometries: ['geojson'],
  alternatives: ['false'],
  steps: ['true', 'false'],
};

// --- Places (Photon) ---------------------------------------------------------------
const PHOTON_KEYS = ['q', 'limit', 'lat', 'lon'];
const DEGREES = /^-?\d{1,3}(?:\.\d{1,6})?$/;

function noRepeats(q) {
  const keys = [...q.keys()];
  return new Set(keys).size === keys.length;
}

/** @type {import('../feeds.js').Feed[]} */
export const feeds = [
  {
    // Directions (OSRM on the FOSSGIS servers, routing.openstreetmap.de): drive,
    // walk and cycle. Keyless. Per the reference implementation, not
    // live-tested here: the FOSSGIS policy asks for at most 1 request/s, a valid
    // User-Agent, an attribution with a "fix the map" link
    // (https://www.openstreetmap.org/fixthemap) and no heavy use. The governor
    // caps a burst at 30/min (it has no 1/s gate; the client asks only on an
    // explicit A/B set), and identical routes are served from the cache for 10
    // minutes. Map data © OpenStreetMap contributors (ODbL).
    id: 'osrm',
    baseUrl: 'https://routing.openstreetmap.de',
    methods: ['GET'],
    allowPaths: [new OsrmRoutePath(OSRM_ROUTE.source)],
    allowQuery: (q) =>
      noRepeats(q) &&
      q.get('geometries') === 'geojson' &&
      [...q.keys()].every(
        (k) => Object.hasOwn(OSRM_QUERY, k) && OSRM_QUERY[k].includes(q.get(k)),
      ),
    headers: UA,
    governor: { ratePerMinute: 30 },
    cache: { ttlMs: 10 * MINUTE },
  },
  {
    // Keyless place search (Photon by komoot, OSM data under the ODbL), between
    // the bundled offline places and Nominatim in the search chain. Per the
    // reference implementation, not live-tested here: photon.komoot.io is a
    // fair-use courtesy service (heavy use is throttled, availability not
    // guaranteed). Only q, limit and a lat/lon proximity bias reach it; the
    // governor keeps a typing session polite and answers are cached.
    id: 'photon',
    baseUrl: 'https://photon.komoot.io',
    methods: ['GET'],
    allowPaths: [/^\/api\/?$/],
    allowQuery: (q) => {
      if (!noRepeats(q) || ![...q.keys()].every((k) => PHOTON_KEYS.includes(k)))
        return false;
      const text = q.get('q');
      if (!text || !text.trim() || text.length > 200) return false;
      if (q.has('limit') && !/^(?:[1-9]|10)$/.test(q.get('limit'))) return false;
      if (q.has('lat') !== q.has('lon')) return false;
      if (q.has('lat')) {
        const [lat, lon] = [q.get('lat'), q.get('lon')];
        if (!DEGREES.test(lat) || !DEGREES.test(lon)) return false;
        if (Math.abs(Number(lat)) > 90 || Math.abs(Number(lon)) > 180) return false;
      }
      return true;
    },
    headers: UA,
    governor: { ratePerMinute: 30 },
    cache: { ttlMs: HOUR, staleMs: 24 * HOUR },
  },
];
