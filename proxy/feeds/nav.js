// Feed registry, Navigation and tools: routing, places, enrichment, traces, receivers.
// Same Feed shape as proxy/feeds.js (see its typedefs); spread into that list.
import { UA, exactPath, MINUTE, HOUR } from './common.js';
import { pinnedQuery } from './earth.js';

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
// reads), maneuvers optional, and OSRM's own alternatives as a yes/no (OSRM
// finds them in the same search, up to two more; a count is never accepted).
const OSRM_QUERY = {
  overview: ['full', 'simplified', 'false'],
  geometries: ['geojson'],
  alternatives: ['false', 'true'],
  steps: ['true', 'false'],
};

// --- Directions (Valhalla) and TomTom Routing / Search ---------------------------
const LAT6 = /^-?\d{1,2}(?:\.\d{1,6})?$/;
const LON6 = /^-?\d{1,3}(?:\.\d{1,6})?$/;
const latOk = (v) => typeof v === 'number' && Math.abs(v) <= 90;
const lonOk = (v) => typeof v === 'number' && Math.abs(v) <= 180;
const only = (obj, keys) =>
  obj &&
  typeof obj === 'object' &&
  !Array.isArray(obj) &&
  Object.keys(obj).every((k) => keys.includes(k));

/**
 * The one Valhalla request shape core/nav/providers.js sends: two stops on the
 * globe within the OSRM leg limit (the first may carry a heading), one of three
 * costings, highways avoidable for driving only, kilometres in US English, at
 * most two alternates. Anything else (matrix, isochrone, more stops, other
 * costing options) is refused, so /feed/valhalla cannot drive heavy work.
 */
export function valhallaQueryOk(json) {
  if (typeof json !== 'string' || json.length > 1024) return false;
  let b;
  try {
    b = JSON.parse(json);
  } catch {
    return false;
  }
  if (
    !only(b, [
      'locations',
      'costing',
      'costing_options',
      'directions_options',
      'alternates',
    ])
  )
    return false;
  if (!['auto', 'pedestrian', 'bicycle'].includes(b.costing)) return false;
  const locs = b.locations;
  if (!Array.isArray(locs) || locs.length !== 2) return false;
  if (!only(locs[0], ['lat', 'lon', 'heading', 'heading_tolerance'])) return false;
  if (!only(locs[1], ['lat', 'lon'])) return false;
  if (!locs.every((l) => latOk(l.lat) && lonOk(l.lon))) return false;
  const h = locs[0];
  if (
    'heading' in h &&
    !(Number.isInteger(h.heading) && h.heading >= 0 && h.heading < 360)
  )
    return false;
  if (
    'heading_tolerance' in h &&
    !(Number.isInteger(h.heading_tolerance) && h.heading_tolerance <= 90)
  )
    return false;
  if (!osrmStopsAllowed(`${locs[0].lon},${locs[0].lat};${locs[1].lon},${locs[1].lat}`))
    return false;
  if ('costing_options' in b) {
    const o = b.costing_options;
    if (b.costing !== 'auto' || !only(o, ['auto']) || !only(o.auto, ['use_highways']))
      return false;
    if (![0, 0.5, 1].includes(o.auto.use_highways)) return false;
  }
  if ('directions_options' in b) {
    const d = b.directions_options;
    if (!only(d, ['units', 'language'])) return false;
    if ('units' in d && d.units !== 'kilometers') return false;
    if ('language' in d && d.language !== 'en-US') return false;
  }
  if ('alternates' in b && ![0, 1, 2].includes(b.alternates)) return false;
  return true;
}

// TomTom calculateRoute: exactly two "lat,lon" stops in the path, same limits.
const TT_STOP = String.raw`(-?\d{1,2}(?:\.\d{1,6})?),(-?\d{1,3}(?:\.\d{1,6})?)`;
const TT_ROUTE = new RegExp(
  String.raw`^\/routing\/1\/calculateRoute\/${TT_STOP}:${TT_STOP}\/json$`,
);

class TomTomRoutePath extends RegExp {
  test(pathname) {
    const m = TT_ROUTE.exec(String(pathname));
    if (!m) return false;
    const [lat1, lon1, lat2, lon2] = m.slice(1).map(Number);
    if (Math.abs(lat1) > 90 || Math.abs(lat2) > 90) return false;
    return osrmStopsAllowed(`${lon1},${lat1};${lon2},${lat2}`);
  }
}

// TomTom fuzzy search: the query is the last path segment (URL-encoded, no
// slash), then .json.
const TT_SEARCH = /^\/search\/2\/search\/[^/]{1,600}\.json$/;

// --- Places (Photon) ---------------------------------------------------------------
const PHOTON_KEYS = ['q', 'limit', 'lat', 'lon'];
const DEGREES = /^-?\d{1,3}(?:\.\d{1,6})?$/;

function noRepeats(q) {
  const keys = [...q.keys()];
  return new Set(keys).size === keys.length;
}

// --- Addresses (US Census Bureau Geocoder) and where the user is (Photon reverse)
// One line of address text: 3 to 200 characters, no control characters
// (spelled out: the phone's Node has no Unicode property data).
const ADDRESS_LINE = (v) =>
  typeof v === 'string' &&
  v.trim().length >= 3 &&
  v.length <= 200 &&
  // eslint-disable-next-line no-control-regex
  !/[\u0000-\u001f\u007f-\u009f]/.test(v);
const DEG1 = /^-?\d{1,3}(?:\.\d)?$/;

// --- Nominatim (proxy/feeds.js): the keys Argus sends, each pinned -------------
// Search: q, JSON, a limit, address details, a bias box (never bounded).
// Reverse: a point, JSON, a zoom, address details, the answer's language.
const VIEWBOX = (v) => {
  const n = String(v).split(',');
  return (
    n.length === 4 &&
    n.every((x) => DEGREES.test(x)) &&
    Math.abs(Number(n[0])) <= 180 &&
    Math.abs(Number(n[2])) <= 180 &&
    Math.abs(Number(n[1])) <= 90 &&
    Math.abs(Number(n[3])) <= 90
  );
};
const NOMINATIM_SEARCH = {
  q: (v) => v.trim().length > 0 && v.length <= 200,
  format: ['json', 'jsonv2'],
  limit: /^(?:[1-9]|10)$/,
  addressdetails: ['0', '1'],
  viewbox: VIEWBOX,
};
const NOMINATIM_REVERSE = {
  lat: (v) => DEGREES.test(v) && Math.abs(Number(v)) <= 90,
  lon: (v) => DEGREES.test(v) && Math.abs(Number(v)) <= 180,
  format: ['json', 'jsonv2'],
  zoom: /^(?:\d|1[0-8])$/,
  addressdetails: ['0', '1'],
  'accept-language': /^[a-z]{2}(?:-[A-Za-z]{2})?$/,
};

/** Nominatim queries: a search (q required) or a reverse (lat and lon required). */
export function nominatimQueryOk(q) {
  if (q.has('q')) {
    const { q: text, ...rest } = NOMINATIM_SEARCH;
    return pinnedQuery({ q: text }, rest)(q);
  }
  const { lat, lon, ...rest } = NOMINATIM_REVERSE;
  return pinnedQuery({ lat, lon }, rest)(q);
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
  {
    // Where the user is, as an address names it (Photon's reverse geocoder,
    // same komoot instance and terms as 'photon'), so a bare street address
    // can be looked up in the user's state (core/search/region.js).
    // Live-tested Oct 2026: /reverse?lat=33.7&lon=-116.2&limit=1 answered a
    // street in Coachella, California, US. Pinned to one rounded point and one
    // answer; the client asks once per ~10 km square per session, and the
    // answers are cached a day.
    id: 'photon-reverse',
    baseUrl: 'https://photon.komoot.io',
    methods: ['GET'],
    allowPaths: [exactPath('/reverse')],
    allowQuery: (q) =>
      pinnedQuery({ lat: DEG1, lon: DEG1, limit: '1' })(q) &&
      Math.abs(Number(q.get('lat'))) <= 90 &&
      Math.abs(Number(q.get('lon'))) <= 180,
    headers: UA,
    governor: { ratePerMinute: 10 },
    cache: { ttlMs: 24 * HOUR, staleMs: 7 * 24 * HOUR, maxEntries: 64 },
  },
  {
    // US street addresses (U.S. Census Bureau Geocoder, onelineaddress on the
    // current public address ranges). Keyless; a US Government work, public
    // domain. Photon (OSM) often lacks the house number, so a numbered US
    // address asks here too (core/search/address.js), with the user's state
    // appended when the query names none. Live-tested Oct 2026: "46211
    // Jackson street, CA" answered 46211 JACKSON ST, INDIO, CA, 92201 at
    // 33.71306, -116.21643; without a state, nothing. Pinned to that one
    // endpoint and query shape (the address, the benchmark, JSON); addresses
    // never change quickly, so answers are cached a day, and a governor keeps
    // typing polite (the client asks only for a house number and a street).
    id: 'census-geocoder',
    baseUrl: 'https://geocoding.geo.census.gov/geocoder',
    methods: ['GET'],
    allowPaths: [exactPath('/geocoder/locations/onelineaddress')],
    allowQuery: pinnedQuery({
      address: ADDRESS_LINE,
      benchmark: 'Public_AR_Current',
      format: 'json',
    }),
    headers: { ...UA, accept: 'application/json' },
    timeoutMs: 15_000,
    governor: {
      ratePerMinute: 20,
      creditBudget: 1000,
      creditWindowMs: 24 * HOUR,
      creditCost: 1,
    },
    cache: { ttlMs: 24 * HOUR, staleMs: 7 * 24 * HOUR, maxEntries: 300, maxBytes: 4e6 },
  },
  {
    // Directions (Valhalla on the FOSSGIS servers, valhalla1.openstreetmap.de):
    // drive, walk, cycle, and driving that avoids highways (OSRM there cannot:
    // exclude=motorway answers 400). Keyless; live-tested Oct 2026 (GET
    // /route?json=..., use_highways 0 honoured, maneuvers with instructions).
    // The FOSSGIS usage policy is as for OSRM: a valid User-Agent, about one
    // request a second, no heavy use, attribution. The client asks only on an
    // explicit plan or a reroute (at most every 10 s); the governor caps a
    // burst at 30/min and identical requests are served from the cache.
    // Map data © OpenStreetMap contributors (ODbL).
    id: 'valhalla',
    baseUrl: 'https://valhalla1.openstreetmap.de',
    methods: ['GET'],
    allowPaths: [exactPath('/route')],
    allowQuery: (q) =>
      noRepeats(q) &&
      [...q.keys()].every((k) => k === 'json') &&
      valhallaQueryOk(q.get('json')),
    headers: UA,
    governor: { ratePerMinute: 30 },
    cache: { ttlMs: 10 * MINUTE },
  },
  {
    // Traffic-aware routing (TomTom Routing API v1, calculateRoute): live
    // traffic travel times with the delay against free flow
    // (computeTravelTimeFor=all), avoid=motorways, up to two alternatives, text
    // guidance and the traffic sections (jams, roadworks, closures) along each
    // route. Needs the same TOMTOM_API_KEY as the flow tiles and incidents,
    // injected here as ?key=. Terms: TomTom for Developers (your own key),
    // attribution "© TomTom". The free tier shares about 2,500 non-tile
    // requests a day across TomTom's APIs: incidents may use 2,000, so routing
    // gets 200 and search 250 (2,450 in all). Cached 2 minutes (traffic moves),
    // a stale answer may stand in for 10. Pinned to one query shape.
    // Per the provider's documentation, not live-tested here (no key).
    id: 'tomtom-routing',
    baseUrl: 'https://api.tomtom.com/routing/1',
    methods: ['GET'],
    allowPaths: [new TomTomRoutePath(TT_ROUTE.source)],
    allowQuery: pinnedQuery(
      {
        travelMode: ['car', 'pedestrian', 'bicycle'],
        traffic: ['true', 'false'],
        computeTravelTimeFor: 'all',
        maxAlternatives: ['0', '1', '2'],
        instructionsType: 'text',
        language: 'en-GB',
        routeType: 'fastest',
        sectionType: 'traffic',
      },
      {
        avoid: 'motorways',
        vehicleHeading: (v) => /^\d{1,3}$/.test(v) && Number(v) < 360,
      },
    ),
    inject: [{ secret: 'TOMTOM_API_KEY', as: 'query', name: 'key' }],
    headers: UA,
    governor: {
      ratePerMinute: 10,
      creditBudget: 200,
      creditWindowMs: 24 * HOUR,
      creditCost: 1,
    },
    cache: { ttlMs: 2 * MINUTE, staleMs: 10 * MINUTE, maxEntries: 32 },
  },
  {
    // Destination search (TomTom Search API v2, fuzzy search): addresses and
    // points of interest, biased (never bounded) near the user. Places and
    // addresses only, never people. Same TOMTOM_API_KEY, injected as ?key=.
    // 250 requests a day, 20 a minute; the client debounces typing, asks only
    // from 3 characters, and answers are cached an hour (a day stale). Photon
    // answers beside it, so a refused or exhausted TomTom costs nothing visible.
    // Per the provider's documentation, not live-tested here (no key).
    id: 'tomtom-search',
    baseUrl: 'https://api.tomtom.com/search/2',
    methods: ['GET'],
    allowPaths: [TT_SEARCH],
    allowQuery: (q) => {
      const ok = pinnedQuery(
        { limit: /^(?:[1-9]|10)$/, typeahead: ['true', 'false'], language: 'en-GB' },
        { lat: LAT6, lon: LON6 },
      )(q);
      if (!ok || q.has('lat') !== q.has('lon')) return false;
      return (
        !q.has('lat') ||
        (Math.abs(Number(q.get('lat'))) <= 90 && Math.abs(Number(q.get('lon'))) <= 180)
      );
    },
    inject: [{ secret: 'TOMTOM_API_KEY', as: 'query', name: 'key' }],
    headers: UA,
    governor: {
      ratePerMinute: 20,
      creditBudget: 250,
      creditWindowMs: 24 * HOUR,
      creditCost: 1,
    },
    cache: { ttlMs: HOUR, staleMs: 24 * HOUR, maxEntries: 200 },
  },
];
