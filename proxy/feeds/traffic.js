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
    // Per public CHP feed consumers, not live-tested here.
    id: 'chp-cad',
    baseUrl: 'https://media.chp.ca.gov/sa_xml',
    baseUrlEnv: 'CHP_CAD_URL',
    methods: ['GET'],
    allowPaths: [exactPath('/sa_xml/sa.xml')],
    allowQuery: pinnedQuery({}),
    headers: UA,
    governor: { ratePerMinute: 6 },
    cache: { ttlMs: MINUTE, staleMs: 30 * MINUTE, maxEntries: 2 },
  },
];
