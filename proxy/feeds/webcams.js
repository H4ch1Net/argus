// Feed registry, public webcams, more DOT traffic camera networks, and land
// border wait times. Same Feed shape as proxy/feeds.js (see its typedefs);
// spread into that list.
//
// Every upstream here was added without network access: each is per the
// provider's documentation, not live-tested here. Re-check each provider's
// terms before relying on it. core/layers/webcams/, core/layers/trafficcams/
// and core/layers/borderwaits/ hold the matching parsers, which accept only
// the still paths these image feeds allow (proxy/test/webcamsFeed.test.js
// checks the two agree).
//
// Keys (WINDY_WEBCAMS_KEY, NPS_API_KEY, WSDOT_ACCESS_CODE and one per 511
// network) are injected here, server side, after the client's query has been
// judged, so a client can neither see a key nor supply its own. A keyed feed
// reports configured: false on /health until its key is set, and the client
// does not offer its source until then.
//
// Each still has its own image-only feed (anything but an image/* body is
// refused), fetched only when a card is opened. Stills are not cached here,
// except the EPIC archive (immutable) and the "latest" Sun images (one frame
// for every viewer).
//
// GUARDRAIL: stills are relayed as published; nothing analyses them.

import { UA, exactPath, MINUTE, HOUR } from './common.js';

const CATALOGUE_CACHE = { ttlMs: 15 * MINUTE, staleMs: 24 * HOUR };

/**
 * allowQuery: every `required` key once, `optional` keys at most once, nothing
 * else, each value passing its test.
 */
const queryOf =
  (required, optional = {}) =>
  (q) => {
    const keys = [...q.keys()];
    if (new Set(keys).size !== keys.length) return false;
    const tests = { ...optional, ...required };
    if (!keys.every((k) => Object.hasOwn(tests, k))) return false;
    if (!Object.keys(required).every((k) => q.has(k))) return false;
    return keys.every((k) => tests[k](q.get(k)));
  };
const noQuery = queryOf({});

const intIn = (lo, hi) => (v) =>
  /^\d{1,6}$/.test(v) && Number(v) >= lo && Number(v) <= hi;
const DECIMAL = /^-?\d{1,3}(?:\.\d{1,6})?$/;

// --- Windy ---------------------------------------------------------------------

const WINDY_INCLUDE = new Set(['categories', 'images', 'location', 'player', 'urls']);

/** "north,east,south,west": a real box, at most 25 by 50 degrees. */
function windyBbox(v) {
  const parts = v.split(',');
  if (parts.length !== 4 || !parts.every((p) => DECIMAL.test(p))) return false;
  const [n, e, s, w] = parts.map(Number);
  return (
    n <= 90 &&
    s >= -90 &&
    n > s &&
    n - s <= 25 &&
    e <= 180 &&
    w >= -180 &&
    e > w &&
    e - w <= 50
  );
}
/** "lat,lon,radius-km", radius at most 250 (Windy's documented maximum). */
function windyNearby(v) {
  const parts = v.split(',');
  if (parts.length !== 3 || !parts.every((p) => DECIMAL.test(p))) return false;
  const [lat, lon, r] = parts.map(Number);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && r > 0 && r <= 250;
}
const windyFilters = {
  limit: intIn(1, 50),
  offset: intIn(0, 1000),
  include: (v) => v.split(',').every((p) => WINDY_INCLUDE.has(p)),
};
const windyOptional = {
  sortKey: (v) => v === 'popularity' || v === 'createdOn',
  sortDirection: (v) => v === 'asc' || v === 'desc',
  lang: (v) => /^[a-z]{2}$/.test(v),
  categories: (v) => /^[a-z_-]{1,30}(?:,[a-z_-]{1,30}){0,19}$/.test(v),
  categoryOperation: (v) => v === 'and' || v === 'or',
};
/** The documented /webcams parameters: a bbox OR a nearby circle, never a key. */
const windyQuery = (q) =>
  q.has('bbox') !== q.has('nearby') &&
  queryOf(
    {
      ...windyFilters,
      ...(q.has('bbox') ? { bbox: windyBbox } : { nearby: windyNearby }),
    },
    windyOptional,
  )(q);

/**
 * A tokenized still's query: at most four plain pairs (Windy's v3 still links
 * carry an expiring token whose parameter name is not documented). The same
 * bounds as core/layers/webcams/parse.js boundedImageQuery.
 */
function boundedImageQuery(q) {
  const pairs = [...q];
  if (pairs.length > 4) return false;
  const keys = new Set();
  for (const [k, v] of pairs) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,23}$/.test(k) || keys.has(k)) return false;
    if (!/^[A-Za-z0-9_.~:+/=-]{0,512}$/.test(v)) return false;
    keys.add(k);
  }
  return true;
}
const WINDY_STILL = /^\/[A-Za-z0-9_/.:-]{1,300}\.(?:jpe?g|png|webp)$/i;

// --- The 511 platform ------------------------------------------------------------

// [feed id, origin, catalogue path, env var holding the developer key]. 511NY
// documents the older /api/getcameras; the others /api/v2/get/cameras.
const FIVE11 = [
  ['ny511', 'https://511ny.org', '/api/getcameras', 'NY511_KEY'],
  ['az511', 'https://az511.gov', '/api/v2/get/cameras', 'AZ511_KEY'],
  ['ga511', 'https://511ga.org', '/api/v2/get/cameras', 'GA511_KEY'],
  ['wi511', 'https://511wi.gov', '/api/v2/get/cameras', 'WI511_KEY'],
  ['id511', 'https://511.idaho.gov', '/api/v2/get/cameras', 'ID511_KEY'],
  ['udot', 'https://udottraffic.utah.gov', '/api/v2/get/cameras', 'UDOT_TRAFFIC_KEY'],
  ['ak511', 'https://511.alaska.gov', '/api/v2/get/cameras', 'AK511_KEY'],
  ['nvroads', 'https://www.nvroads.com', '/api/v2/get/cameras', 'NVROADS_KEY'],
  ['la511', 'https://www.511la.org', '/api/v2/get/cameras', 'LA511_KEY'],
  ['ctroads', 'https://ctroads.org', '/api/v2/get/cameras', 'CTROADS_KEY'],
];
export const FIVE11_NETWORKS = Object.freeze(
  FIVE11.map(([id, origin, path, secret]) => Object.freeze({ id, origin, path, secret })),
);

const five11Feeds = FIVE11.flatMap(([id, origin, path, secret]) => [
  {
    // The developer key goes in the query (?key=), injected here; the platform
    // documents a limit of about 10 calls a minute per key, so 4 a minute and a
    // 15-minute cache.
    // Per the provider's documentation, not live-tested here.
    id,
    baseUrl: `${origin}${path.replace(/\/[^/]+$/, '')}`,
    methods: ['GET'],
    allowPaths: [exactPath(path)],
    allowQuery: queryOf(
      { format: (v) => v === 'json' },
      { lang: (v) => /^(en|es|fr)$/.test(v) },
    ),
    headers: UA,
    inject: [{ secret, as: 'query', name: 'key' }],
    governor: { ratePerMinute: 4 },
    cache: CATALOGUE_CACHE,
  },
  {
    // The platform's stills: /map/Cctv/<view id> on the network's own host, keyless.
    // Per the provider's documentation, not live-tested here.
    id: `${id}-img`,
    imageOnly: true,
    baseUrl: `${origin}/map/Cctv`,
    methods: ['GET'],
    allowPaths: [/^\/map\/Cctv\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}$/],
    allowQuery: noQuery,
    headers: UA,
    governor: { ratePerMinute: 60 },
  },
]);

/** @type {import('../feeds.js').Feed[]} */
export const feeds = [
  // --- Public webcams (core/layers/webcams) ---
  {
    // Windy Webcams API v3. Your own key (free tier: preview-size stills, links that expire
    // after about 10 minutes, so a 4-minute cache), sent as the x-windy-api-key
    // header. Attribution with a link back to windy.com is required (the card
    // carries both). A daily budget keeps a long session inside the free tier.
    // Per the provider's documentation, not live-tested here.
    id: 'windy',
    baseUrl: 'https://api.windy.com/webcams/api/v3',
    methods: ['GET'],
    allowPaths: [exactPath('/webcams/api/v3/webcams')],
    allowQuery: windyQuery,
    headers: UA,
    inject: [{ secret: 'WINDY_WEBCAMS_KEY', as: 'header', name: 'x-windy-api-key' }],
    governor: {
      ratePerMinute: 20,
      creditBudget: 2000,
      creditWindowMs: 24 * HOUR,
      creditCost: 1,
    },
    cache: { ttlMs: 4 * MINUTE, staleMs: 8 * MINUTE, maxEntries: 32 },
  },
  {
    // Windy stills, v2-style host.
    // Per the provider's documentation, not live-tested here.
    id: 'windy-img',
    imageOnly: true,
    baseUrl: 'https://images-webcams.windy.com',
    methods: ['GET'],
    allowPaths: [WINDY_STILL],
    allowQuery: boundedImageQuery,
    headers: UA,
    governor: { ratePerMinute: 60 },
  },
  {
    // Windy stills, v3 image proxy host.
    // Per the provider's documentation, not live-tested here.
    id: 'windy-imgproxy',
    imageOnly: true,
    baseUrl: 'https://imgproxy.windy.com',
    methods: ['GET'],
    allowPaths: [WINDY_STILL],
    allowQuery: boundedImageQuery,
    headers: UA,
    governor: { ratePerMinute: 60 },
  },
  {
    // NPS Data API, /webcams (all US National Park Service webcams, about 300).
    // Your own free key
    // (developer.nps.gov), sent as the X-Api-Key header; NPS allows 1,000
    // requests an hour, and one list a session is all this needs.
    // Per the provider's documentation, not live-tested here.
    id: 'nps-webcams',
    baseUrl: 'https://developer.nps.gov/api/v1',
    methods: ['GET'],
    allowPaths: [exactPath('/api/v1/webcams')],
    allowQuery: queryOf(
      { limit: intIn(1, 1000), start: intIn(0, 10000) },
      { parkCode: (v) => /^[a-z]{4}(?:,[a-z]{4}){0,9}$/.test(v) },
    ),
    headers: UA,
    inject: [{ secret: 'NPS_API_KEY', as: 'header', name: 'X-Api-Key' }],
    governor: {
      ratePerMinute: 10,
      creditBudget: 900,
      creditWindowMs: HOUR,
      creditCost: 1,
    },
    cache: { ttlMs: 6 * HOUR, staleMs: 7 * 24 * HOUR },
  },
  {
    // NPS webcam images as published with each listing.
    // Per the provider's documentation, not live-tested here.
    id: 'nps-img',
    imageOnly: true,
    baseUrl: 'https://www.nps.gov',
    methods: ['GET'],
    allowPaths: [/^\/common\/uploads\/[A-Za-z0-9_/.-]{1,240}\.(?:jpe?g|png|gif|webp)$/i],
    allowQuery: noQuery,
    headers: UA,
    governor: { ratePerMinute: 60 },
  },
  {
    // NASA EPIC (DSCOVR), the latest day's natural-colour Earth images. Keyless,
    // public domain (credit "NASA EPIC Team").
    // Per the provider's documentation, not live-tested here.
    id: 'epic',
    baseUrl: 'https://epic.gsfc.nasa.gov/api',
    methods: ['GET'],
    allowPaths: [exactPath('/api/natural')],
    allowQuery: noQuery,
    headers: UA,
    governor: { ratePerMinute: 6 },
    cache: { ttlMs: 30 * MINUTE, staleMs: 2 * 24 * HOUR },
  },
  {
    // EPIC archive stills: the small "thumbs" JPEG the card shows and the
    // full-size JPEG it links (never the multi-megabyte PNG). Immutable, so
    // cached.
    // Per the provider's documentation, not live-tested here.
    id: 'epic-img',
    imageOnly: true,
    baseUrl: 'https://epic.gsfc.nasa.gov',
    methods: ['GET'],
    allowPaths: [
      /^\/archive\/natural\/\d{4}\/\d{2}\/\d{2}\/(?:thumbs|jpg)\/epic_1b_\d{14}\.jpg$/,
    ],
    allowQuery: noQuery,
    headers: UA,
    governor: { ratePerMinute: 30 },
    cache: { ttlMs: 6 * HOUR, maxEntries: 12 },
  },
  {
    // NASA SDO "The Sun now" latest images (public domain; credit "Courtesy of
    // NASA/SDO and the AIA, EVE, and HMI science teams"). One frame for every
    // viewer, so cached 10 minutes.
    // Per the provider's documentation, not live-tested here.
    id: 'sdo-img',
    imageOnly: true,
    baseUrl: 'https://sdo.gsfc.nasa.gov',
    methods: ['GET'],
    allowPaths: [/^\/assets\/img\/latest\/latest_(?:512|1024|2048)_[A-Z0-9]{3,8}\.jpg$/],
    allowQuery: noQuery,
    headers: UA,
    governor: { ratePerMinute: 30 },
    cache: { ttlMs: 10 * MINUTE, maxEntries: 8 },
  },
  {
    // SOHO real-time images (credit "SOHO (ESA & NASA)").
    // Per the provider's documentation, not live-tested here.
    id: 'soho-img',
    imageOnly: true,
    baseUrl: 'https://soho.nascom.nasa.gov',
    methods: ['GET'],
    allowPaths: [
      /^\/data\/realtime\/(?:c2|c3|eit_(?:171|195|284|304)|hmi_igr)\/(?:512|1024)\/latest\.jpg$/,
    ],
    allowQuery: noQuery,
    headers: UA,
    governor: { ratePerMinute: 30 },
    cache: { ttlMs: 10 * MINUTE, maxEntries: 8 },
  },

  // --- Land border wait times (core/layers/borderwaits) ---
  {
    // US Customs and Border Protection, Border Wait Times (US federal data,
    // public domain). One JSON list of every land crossing, updated about
    // hourly.
    // Per the provider's documentation, not live-tested here.
    id: 'cbp-bwt',
    baseUrl: 'https://bwt.cbp.gov/api',
    methods: ['GET'],
    allowPaths: [exactPath('/api/bwtnew')],
    allowQuery: noQuery,
    headers: UA,
    governor: { ratePerMinute: 6 },
    cache: { ttlMs: 5 * MINUTE, staleMs: 6 * HOUR },
  },
  {
    // Canada Border Services Agency, Border Wait Times open data (Open
    // Government Licence - Canada), one CSV for every land crossing. Its URL
    // is the least certain in this file (from the open-data listing).
    // Per the provider's documentation, not live-tested here.
    id: 'cbsa-bwt',
    baseUrl: 'https://www.cbsa-asfc.gc.ca/bwt-taf',
    methods: ['GET'],
    allowPaths: [/^\/bwt-taf\/bwt-(?:eng|fra)\.csv$/],
    allowQuery: noQuery,
    headers: { ...UA, accept: 'text/csv, text/plain;q=0.9' },
    governor: { ratePerMinute: 6 },
    cache: { ttlMs: 5 * MINUTE, staleMs: 6 * HOUR },
  },

  // --- More traffic camera networks (core/layers/trafficcams) ---
  {
    // NYC DOT traffic cameras (webcams.nyctmc.org), keyless, courtesy credit.
    // Per the provider's documentation, not live-tested here.
    id: 'nycdot',
    baseUrl: 'https://webcams.nyctmc.org/api',
    methods: ['GET'],
    allowPaths: [exactPath('/api/cameras')],
    allowQuery: noQuery,
    headers: UA,
    governor: { ratePerMinute: 6 },
    cache: CATALOGUE_CACHE,
  },
  {
    // Per the provider's documentation, not live-tested here.
    id: 'nycdot-img',
    imageOnly: true,
    baseUrl: 'https://webcams.nyctmc.org/api/cameras',
    methods: ['GET'],
    allowPaths: [/^\/api\/cameras\/[0-9a-f][0-9a-f-]{7,63}\/image$/],
    allowQuery: noQuery,
    headers: UA,
    governor: { ratePerMinute: 120 },
  },
  {
    // Singapore Land Transport Authority traffic images via data.gov.sg
    // (Singapore Open Data Licence v1.0, attribution required), keyless. The
    // still names rotate every capture, hence the short cache.
    // Per the provider's documentation, not live-tested here.
    id: 'lta-sg',
    baseUrl: 'https://api.data.gov.sg/v1/transport',
    methods: ['GET'],
    allowPaths: [exactPath('/v1/transport/traffic-images')],
    allowQuery: noQuery,
    headers: UA,
    governor: { ratePerMinute: 6 },
    cache: { ttlMs: 2 * MINUTE, staleMs: HOUR },
  },
  {
    // Per the provider's documentation, not live-tested here.
    id: 'lta-sg-img',
    imageOnly: true,
    baseUrl: 'https://images.data.gov.sg/api/traffic-images',
    methods: ['GET'],
    allowPaths: [/^\/api\/traffic-images\/\d{4}\/\d{2}\/[A-Za-z0-9_-]{8,64}\.jpg$/],
    allowQuery: noQuery,
    headers: UA,
    governor: { ratePerMinute: 120 },
  },
  {
    // WSDOT Traveler Information API, highway cameras (courtesy credit). Your
    // own access code (WSDOT_ACCESS_CODE), sent as ?AccessCode=.
    // Per the provider's documentation, not live-tested here.
    id: 'wsdot',
    baseUrl: 'https://www.wsdot.wa.gov/Traffic/api/HighwayCameras/HighwayCamerasREST.svc',
    methods: ['GET'],
    allowPaths: [
      exactPath('/Traffic/api/HighwayCameras/HighwayCamerasREST.svc/GetCamerasAsJson'),
    ],
    allowQuery: noQuery,
    headers: UA,
    inject: [{ secret: 'WSDOT_ACCESS_CODE', as: 'query', name: 'AccessCode' }],
    governor: { ratePerMinute: 4 },
    cache: CATALOGUE_CACHE,
  },
  {
    // Per the provider's documentation, not live-tested here.
    id: 'wsdot-img',
    imageOnly: true,
    baseUrl: 'https://images.wsdot.wa.gov',
    methods: ['GET'],
    allowPaths: [
      /^\/[A-Za-z0-9_-]{1,24}(?:\/[A-Za-z0-9_-]{1,40})?\/[A-Za-z0-9_.-]{1,80}\.jpe?g$/i,
    ],
    allowQuery: noQuery,
    headers: UA,
    governor: { ratePerMinute: 60 },
  },
  // The 511-platform states (511NY, AZ511, 511GA, 511WI, Idaho 511, UDOT
  // Traffic, Alaska 511, NVroads, 511LA, CTroads): a keyed catalogue and a
  // keyless image feed each.
  ...five11Feeds,
];
