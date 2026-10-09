// Feed registry, road traffic: TomTom traffic incidents and California CHP
// dispatch incidents. Same Feed shape as proxy/feeds.js (see its typedefs);
// spread into that list.
//
// Neither was reachable when these were added (no network), so each is "per
// the provider's documentation, not live-tested here". Re-check terms before
// relying on one. The query builders live in core (Cesium-free):
// core/layers/incidents/parse.js and core/layers/chp/parse.js;
// proxy/test/trafficFeeds.test.js checks that what they build passes the pins.

import { UA, exactPath, MINUTE, HOUR } from './common.js';
import { pinnedQuery } from './earth.js';

// Exactly the field selection core asks for (core/layers/incidents/parse.js
// TOMTOM_INCIDENT_FIELDS, kept equal by the test).
export const TOMTOM_INCIDENT_FIELDS =
  '{incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,events{description,code,iconCategory},startTime,endTime,from,to,length,delay,roadNumbers,timeValidity}}}';

const NUM5 = /^-?\d{1,3}(?:\.\d{1,5})?$/;

/** "minLon,minLat,maxLon,maxLat" within range and under TomTom's 10,000 km2. */
export function incidentBboxOk(v) {
  if (typeof v !== 'string' || v.length > 64) return false;
  const parts = v.split(',');
  if (parts.length !== 4 || !parts.every((p) => NUM5.test(p))) return false;
  const [lomin, lamin, lomax, lamax] = parts.map(Number);
  if (lomin < -180 || lomax > 180 || lamin < -90 || lamax > 90) return false;
  if (lomax <= lomin || lamax <= lamin) return false;
  const mid = ((lamin + lamax) / 2) * (Math.PI / 180);
  const km2 = (lamax - lamin) * 111.32 * (lomax - lomin) * 111.32 * Math.cos(mid);
  return km2 <= 10_000;
}

/** @type {import('../feeds.js').Feed[]} */
export const feeds = [
  {
    // Traffic incidents (TomTom Traffic API, Incident Details v5): accidents,
    // jams, roadworks, closures, hazards, weather, with the affected stretch.
    // Needs the same free TOMTOM_API_KEY as the flow tiles, injected here as
    // ?key= so it never reaches the browser; the client may never send one.
    // Terms: TomTom for Developers (your own key), attribution "© TomTom".
    // The free tier allows about 2,500 non-tile requests a day: the governor
    // caps this feed at 2,000 a day and 20 a minute, answers are cached 2
    // minutes per box (the client snaps boxes to a grid so nearby views share
    // one), and a stale answer may stand in for 15 minutes when TomTom fails.
    // Pinned to one query shape: a bbox under the API's 10,000 km2 limit, the
    // one field selection, English, current incidents only.
    // Per the provider's documentation, not live-tested here.
    id: 'tomtom-incidents',
    baseUrl: 'https://api.tomtom.com/traffic/services/5',
    methods: ['GET'],
    allowPaths: [exactPath('/traffic/services/5/incidentDetails')],
    allowQuery: pinnedQuery({
      bbox: incidentBboxOk,
      fields: TOMTOM_INCIDENT_FIELDS,
      language: 'en-GB',
      timeValidityFilter: 'present',
    }),
    inject: [{ secret: 'TOMTOM_API_KEY', as: 'query', name: 'key' }],
    headers: UA,
    governor: {
      ratePerMinute: 20,
      creditBudget: 2000,
      creditWindowMs: 24 * HOUR,
      creditCost: 1,
    },
    cache: { ttlMs: 2 * MINUTE, staleMs: 15 * MINUTE, maxEntries: 32 },
  },
  {
    // California Highway Patrol CAD incidents: the public statewide list CHP
    // publishes for its traffic incident page (incident type, place, area,
    // time). Keyless; California public records, credit "California Highway
    // Patrol". One XML document, no query. Cached a minute for every client;
    // the client parses only the header fields and never the dispatch
    // narrative (core/layers/chp/parse.js). CHP_CAD_URL may point at another
    // copy of the same file (e.g. http://media.chp.ca.gov/sa_xml if https is
    // refused); the path stays pinned.
    // Live-tested Oct 2026: CHP answers 406 Not Acceptable when the request's Accept
    // header is exactly application/xml, application/json or text/html (what a browser
    // fetch may forward), and 200 for text/xml or */*. The relay forwards the client's
    // Accept, so this feed pins its own.
    // Live-sampled Oct 2026 (curl, a new connection each time): about one answer
    // in three came from a server holding an hour-old copy cut off at 160 KiB,
    // mid-element (the current file is ~250 KB and ends with </State>). So a
    // document without its closing </State> is not an answer: it is never
    // cached, and the request is tried twice more on a fresh connection, which
    // usually reaches a current server; failing that, the last good copy (up to
    // an hour old) stands in, and only then the cut copy (the parser reads its
    // complete logs). The retry path is not live-tested through Node here.
    id: 'chp-cad',
    baseUrl: 'https://media.chp.ca.gov/sa_xml',
    baseUrlEnv: 'CHP_CAD_URL',
    methods: ['GET'],
    allowPaths: [exactPath('/sa_xml/sa.xml')],
    allowQuery: pinnedQuery({}),
    headers: { ...UA, accept: 'text/xml, */*;q=0.1' },
    validate: chpDocumentComplete,
    retries: 2,
    freshConnection: true,
    governor: { ratePerMinute: 6 },
    cache: { ttlMs: MINUTE, staleMs: HOUR, maxEntries: 2 },
  },
  {
    // Waze alerts and jams from the endpoint Waze's public live map draws from
    // (waze.com/live-map). Unofficial: not a documented API and outside Waze's
    // terms for automated use; added for the owner's personal, educational use
    // and off by default in the app. Pinned to alerts and jams only (never
    // "users", the nearby Wazers' positions the endpoint can also return), a
    // box of at most about a degree, and the three server regions. Argus sends
    // its own User-Agent (it never poses as a browser); Waze answered 403 to
    // that from a cloud host in Oct 2026, so it may only work, if at all, from
    // a home connection. Cached a minute per box (the client snaps boxes to a
    // 0.01 degree grid), 6 a minute, 1,500 a day. Not live-tested here.
    id: 'waze',
    baseUrl: 'https://www.waze.com',
    methods: ['GET'],
    allowPaths: [exactPath('/live-map/api/georss')],
    allowQuery: (q) =>
      wazeLiveQuery(q) &&
      wazeSpanOk(q.get('bottom'), q.get('top'), q.get('left'), q.get('right')),
    headers: { ...UA, accept: 'application/json' },
    governor: {
      ratePerMinute: 6,
      creditBudget: 1500,
      creditWindowMs: 24 * HOUR,
      creditCost: 1,
    },
    cache: { ttlMs: MINUTE, staleMs: 10 * MINUTE, maxEntries: 64 },
  },
  {
    // Your own waze-server (Nimrod007/waze-api, the companion server
    // JMoore335/waze_traffic_api runs): LOCAL_WAZE_URL=http://localhost:8080.
    // It must be on this machine or the LAN (localOnly); without it the feed is
    // not configured. Same box pins as above.
    id: 'waze-local',
    baseUrl: 'http://localhost:8080',
    baseUrlEnv: 'LOCAL_WAZE_URL',
    localOnly: true,
    methods: ['GET'],
    allowPaths: [exactPath('/waze/traffic-notifications')],
    allowQuery: (q) =>
      wazeLocalQuery(q) &&
      wazeSpanOk(
        q.get('latBottom'),
        q.get('latTop'),
        q.get('lonLeft'),
        q.get('lonRight'),
      ),
    headers: UA,
    governor: { ratePerMinute: 12 },
    cache: { ttlMs: MINUTE, staleMs: 10 * MINUTE, maxEntries: 64 },
  },
];

// The Waze pins: degrees with two decimals (core/layers/waze/parse.js snaps
// boxes to 0.01), a box of at most about a degree each way.
const DEG2 = /^-?\d{1,3}\.\d{2}$/;
const wazeLat = (v) => DEG2.test(v) && Math.abs(Number(v)) <= 85;
const wazeLon = (v) => DEG2.test(v) && Math.abs(Number(v)) <= 180;
const wazeLiveQuery = pinnedQuery({
  top: wazeLat,
  bottom: wazeLat,
  left: wazeLon,
  right: wazeLon,
  env: ['na', 'row', 'il'],
  types: 'alerts,traffic',
});
const wazeLocalQuery = pinnedQuery({
  latBottom: wazeLat,
  latTop: wazeLat,
  lonLeft: wazeLon,
  lonRight: wazeLon,
});

/** South < north and west < east, each span at most 1.02 degrees. */
export function wazeSpanOk(south, north, west, east) {
  const [s, n, w, e] = [south, north, west, east].map(Number);
  return n > s && e > w && n - s <= 1.02 && e - w <= 1.02;
}

/** True when a CHP sa.xml body ends with its closing </State> (not cut off). */
export function chpDocumentComplete(body) {
  return /<\/State>\s*$/.test(
    body.subarray(Math.max(0, body.length - 64)).toString('latin1'),
  );
}
