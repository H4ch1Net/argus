// Feed registry, Imagery and briefing: the recent-imagery catalogue (NASA CMR,
// GIBS tiles, Worldview snapshots), TomTom traffic flow tiles, and the cockpit
// briefing sources (Open-Meteo weather, GDELT and Google News headlines).
// Same Feed shape as proxy/feeds.js (see its typedefs); spread into that list.
//
// Ported from the reference project (bilawalsidhu/gods-eye-view, MIT code):
// endpoints, parameters and limits below are as that project uses them, read
// from its source. Egress was blocked when these were added, so every feed here
// is per the reference implementation, not live-tested here. Re-check each
// upstream's terms before relying on it.
import { UA, MINUTE, HOUR } from './common.js';

// The query builders that produce these requests live in core (Cesium-free):
// core/layers/imagery/catalog.js, core/layers/trafficflow/spec.js and
// core/cockpit/briefing.js. proxy/test/imageryFeeds.test.js checks that what
// they build passes the pins below, so the two cannot drift apart.

/**
 * An allowQuery that admits exactly these parameters: each key at most once,
 * each value passing its rule (a RegExp, an exact string, or a predicate). Keys
 * not listed are refused; listed keys are required unless named in `optional`.
 * @param {Record<string, RegExp | string | ((v: string) => boolean)>} rules
 * @param {string[]} [optional]
 */
function pinQuery(rules, optional = []) {
  return (q) => {
    const keys = [...q.keys()];
    if (new Set(keys).size !== keys.length) return false;
    for (const k of keys) if (!Object.hasOwn(rules, k)) return false;
    for (const [k, rule] of Object.entries(rules)) {
      const v = q.get(k);
      if (v === null) {
        if (optional.includes(k)) continue;
        return false;
      }
      const ok =
        rule instanceof RegExp
          ? rule.test(v)
          : typeof rule === 'function'
            ? rule(v)
            : v === rule;
      if (!ok) return false;
    }
    return true;
  };
}

const NUM = String.raw`-?\d{1,3}(?:\.\d{1,6})?`;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const between = (lo, hi) => (v) =>
  /^\d{1,5}$/.test(v) && Number(v) >= lo && Number(v) <= hi;

// NASA HLS collections (LP DAAC) and the GIBS layers that tile them.
const CMR_COLLECTIONS = ['C2021957295-LPCLOUD', 'C2021957657-LPCLOUD']; // S30, L30
const GIBS_LAYERS = [
  'HLS_S30_Nadir_BRDF_Adjusted_Reflectance',
  'HLS_L30_Nadir_BRDF_Adjusted_Reflectance',
  'VIIRS_NOAA21_CorrectedReflectance_TrueColor',
];

// TomTom raster flow styles, from TomTom's documented Raster Flow Tiles pattern
// (/traffic/map/4/tile/flow/{style}/{zoom}/{x}/{y}.png). UNVERIFIED offline:
// the reference uses the vector variant (flow/relative/...pbf) only.
const TOMTOM_FLOW_STYLES = [
  'absolute',
  'relative',
  'relative0',
  'relative0-dark',
  'relative-delay',
  'reduced-sensitivity',
];

// Open-Meteo current-conditions fields the cockpit briefing reads; the builder
// in core/cockpit/briefing.js (OPEN_METEO_CURRENT) sends exactly this list.
const OPEN_METEO_CURRENT =
  'temperature_2m,apparent_temperature,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,visibility';

// Coordinates rounded to 2 decimals (about 1 km): enough for weather, and it
// keeps the cache key per cell instead of per metre of a moving subject.
const COORD2 = /^-?\d{1,3}(?:\.\d{1,2})?$/;
const inRange = (lim) => (v) => COORD2.test(v) && Math.abs(Number(v)) <= lim;

// A place name for the news searches: printable, short, no quotes or control
// characters. The cockpit briefing derives it from the reverse-geocoded place
// only; nothing should wire a free-text box to these feeds (people guardrail:
// news about a place, never a search for a person).
const PLACE_TERM = (v) =>
  v.length >= 1 &&
  v.length <= 100 &&
  [...v].every((ch) => {
    const c = ch.codePointAt(0);
    return c >= 0x20 && c !== 0x7f && ch !== '"' && ch !== '\\';
  });

/** @type {import('../feeds.js').Feed[]} */
export const feeds = [
  {
    // Recent imagery catalogue: NASA CMR granule search for the two Harmonized
    // Landsat Sentinel-2 collections (HLS S30 and L30). Keyless, US public domain,
    // acknowledgement requested. One 30-day query per selected box, at most
    // 1000 km a side (validated client side); the window is quantized to whole
    // UTC days so the same box asked twice in a day is one upstream call.
    // Paging: CMR answers with a CMR-Search-After response header that the next
    // page sends back as a request header. The relay forwards neither today, so
    // a search returns the newest page only (marked truncated); `passHeaders`
    // records what the relay must forward once it supports it.
    // Per the reference implementation, not live-tested here.
    id: 'cmr',
    baseUrl: 'https://cmr.earthdata.nasa.gov/search',
    methods: ['GET'],
    allowPaths: [/^\/search\/granules\.umm_json$/],
    allowQuery: pinQuery({
      collection_concept_id: (v) => CMR_COLLECTIONS.includes(v),
      bounding_box: new RegExp(`^${NUM},${NUM},${NUM},${NUM}$`),
      temporal:
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z,\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
      sort_key: '-start_date',
      page_size: between(1, 2000),
    }),
    passHeaders: {
      request: ['cmr-search-after'],
      response: ['cmr-search-after', 'cmr-hits'],
    },
    headers: UA,
    governor: { ratePerMinute: 30 },
    cache: { ttlMs: 15 * MINUTE, staleMs: 6 * HOUR, maxEntries: 8 },
  },
  {
    // Recent imagery tiles: NASA GIBS WMTS (EPSG:3857, "best" collection) for
    // the HLS S30/L30 daily layers (png, z <= 12) and the VIIRS NOAA-21 daily
    // true-colour overview (jpg, z <= 9). Keyless, public domain, acknowledgement
    // requested. The reference spreads tiles over gibs-{a,b,c} for browser
    // parallelism; behind the proxy the browser sees one host either way, so this
    // feed uses the documented main host. Tiles for a past day never change, so
    // the browser cache (upstream cache-control is relayed) does the caching.
    // Per the reference implementation, not live-tested here.
    id: 'gibs',
    baseUrl: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best',
    methods: ['GET'],
    allowPaths: [
      /^\/wmts\/epsg3857\/best\/HLS_[SL]30_Nadir_BRDF_Adjusted_Reflectance\/default\/\d{4}-\d{2}-\d{2}\/GoogleMapsCompatible_Level12\/(?:\d|1[0-2])\/\d{1,4}\/\d{1,4}\.png$/,
      /^\/wmts\/epsg3857\/best\/VIIRS_NOAA21_CorrectedReflectance_TrueColor\/default\/\d{4}-\d{2}-\d{2}\/GoogleMapsCompatible_Level9\/\d\/\d{1,3}\/\d{1,3}\.jpg$/,
    ],
    allowQuery: pinQuery({}),
    headers: UA,
    governor: { ratePerMinute: 600 },
  },
  {
    // Recent imagery thumbnails and PNG export: NASA Worldview Snapshots
    // (GetSnapshot of one GIBS layer over a lat/lon box). Image-only: one path,
    // one request type, the three imagery layers, at most 2048 px a side.
    // Availability lives in the Data-Present and Acquisition-Time response
    // headers (GIBS answers an empty day with HTTP 200), which the relay does
    // not forward yet; see `passHeaders`. Without them a thumbnail still shows.
    // Per the reference implementation, not live-tested here.
    id: 'wvs',
    baseUrl: 'https://wvs.earthdata.nasa.gov/api/v1',
    methods: ['GET'],
    allowPaths: [/^\/api\/v1\/snapshot$/],
    allowQuery: pinQuery({
      REQUEST: 'GetSnapshot',
      LAYERS: (v) => GIBS_LAYERS.includes(v),
      CRS: 'EPSG:4326',
      TIME: DAY,
      BBOX: new RegExp(`^${NUM},${NUM},${NUM},${NUM}$`),
      WIDTH: between(16, 2048),
      HEIGHT: between(16, 2048),
      FORMAT: (v) => v === 'image/png' || v === 'image/jpeg',
    }),
    passHeaders: { response: ['data-present', 'acquisition-time'] },
    headers: UA,
    governor: { ratePerMinute: 60 },
  },
  {
    // Traffic flow raster tiles (TomTom Traffic API, Raster Flow Tiles). Needs a
    // free TOMTOM_API_KEY, injected here as ?key= so it never reaches the
    // browser. Terms: TomTom for Developers terms (your own key); attribution
    // "Traffic flow data (c) TomTom" whenever the tiles are shown. The free tier
    // is about 200,000 tile requests a month, so the governor caps upstream
    // tiles at 6,000 a day (31 days fit inside the allowance, as the reference
    // sizes it); cache hits cost nothing. Traffic is fresh data: cached 120 s.
    // The raster path and style names follow TomTom's documented pattern, but
    // the reference only used the vector (.pbf) tiles: UNVERIFIED offline.
    // Per the reference implementation, not live-tested here.
    id: 'tomtom-flow',
    baseUrl: 'https://api.tomtom.com/traffic/map/4/tile/flow',
    methods: ['GET'],
    allowPaths: [
      new RegExp(
        `^/traffic/map/4/tile/flow/(?:${TOMTOM_FLOW_STYLES.join('|')})/(?:\\d|1\\d|2[0-2])/\\d{1,7}/\\d{1,7}\\.png$`,
      ),
    ],
    // The client may tune line thickness and tile size, nothing else (and never
    // `key`: that is the proxy's to set).
    allowQuery: pinQuery(
      { thickness: between(1, 20), tileSize: (v) => v === '256' || v === '512' },
      ['thickness', 'tileSize'],
    ),
    inject: [{ secret: 'TOMTOM_API_KEY', as: 'query', name: 'key' }],
    headers: UA,
    governor: {
      ratePerMinute: 300,
      creditBudget: 6000,
      creditWindowMs: 24 * HOUR,
      creditCost: 1,
    },
    cache: { ttlMs: 2 * MINUTE, staleMs: 10 * MINUTE, maxEntries: 64 },
  },
  {
    // Cockpit briefing weather: Open-Meteo current conditions at the subject.
    // Keyless; the free API is for non-commercial use (about 10,000 calls a
    // day) and the data is CC BY 4.0 with a linked "Weather data by
    // Open-Meteo.com" credit beside it. Pinned to one query shape: the eight
    // current fields, UTC, coordinates rounded to 2 decimals.
    // Per the reference implementation, not live-tested here.
    id: 'openmeteo',
    baseUrl: 'https://api.open-meteo.com/v1',
    methods: ['GET'],
    allowPaths: [/^\/v1\/forecast$/],
    allowQuery: pinQuery({
      latitude: inRange(90),
      longitude: inRange(180),
      current: OPEN_METEO_CURRENT,
      timezone: 'UTC',
    }),
    headers: UA,
    governor: { ratePerMinute: 30, creditBudget: 5000, creditWindowMs: 24 * HOUR },
    cache: { ttlMs: 5 * MINUTE, staleMs: 30 * MINUTE, maxEntries: 32 },
  },
  {
    // Cockpit briefing headlines, fallback source: the GDELT DOC 2.0 API's
    // article list for a quoted place name over the last hours. Keyless; GDELT
    // terms allow use with a citation and a link to the project, and each
    // linked article keeps its publisher's terms. GDELT asks for at most one
    // request every 5 seconds, so the governor allows 6 a minute.
    // Per the reference implementation, not live-tested here.
    id: 'gdelt',
    baseUrl: 'https://api.gdeltproject.org/api/v2/doc',
    methods: ['GET'],
    allowPaths: [/^\/api\/v2\/doc\/doc$/],
    allowQuery: pinQuery({
      query: (v) => /^"[^"]+"$/.test(v) && PLACE_TERM(v.slice(1, -1)),
      mode: 'artlist',
      format: 'json',
      maxrecords: between(1, 10),
      sort: 'datedesc',
      timespan: /^(?:\d{1,2}h|[1-7]d)$/,
    }),
    headers: UA,
    governor: { ratePerMinute: 6 },
    cache: { ttlMs: 15 * MINUTE, staleMs: 2 * HOUR, maxEntries: 32 },
  },
  {
    // Cockpit briefing headlines, primary source: Google News RSS search for the
    // place name. TERMS FLAG: Google News terms restrict this to personal,
    // non-commercial use (which is what Argus is); linked articles keep their
    // publishers' terms. Keyless. The client parses the RSS with a parser that
    // refuses DOCTYPE/ENTITY declarations (core/cockpit/briefing.js).
    // Per the reference implementation, not live-tested here.
    id: 'gnews',
    baseUrl: 'https://news.google.com/rss',
    methods: ['GET'],
    allowPaths: [/^\/rss\/search$/],
    allowQuery: pinQuery({
      q: PLACE_TERM,
      hl: 'en-US',
      gl: 'US',
      ceid: 'US:en',
    }),
    headers: UA,
    governor: { ratePerMinute: 6 },
    cache: { ttlMs: 15 * MINUTE, staleMs: 2 * HOUR, maxEntries: 32 },
  },
];
