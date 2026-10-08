// Feed registry, Public traffic and city cameras (image-only feeds beside each catalogue).
// Same Feed shape as proxy/feeds.js (see its typedefs); spread into that list.
//
// Every network here is keyless and per the reference implementation
// (gods-eye-view server/providers/cctv/constants.js and sources.js, MIT, read
// Oct 2026), not live-tested here: egress was blocked at build time. Re-check
// each network's terms before relying on it. core/layers/trafficcams/ holds the
// matching registry (coverage boxes, caps) and the parsers, which accept only
// the still paths these image feeds allow.
//
// Each network has a catalogue feed (cached 15 minutes, its query pinned) and
// an image-only feed for its stills, fetched when a camera's card is opened.
// The two curated networks (Tallinn, Warendorf) ship their catalogue in the
// repo, so they have an image feed only.
//
// Skipped: Live Traffic NSW (its image host serves stills only to a spoofed
// browser User-Agent, and the proxy does not impersonate browsers) and DelDOT
// (HLS video only, no stills; a video relay would be a new subsystem).
//
// GUARDRAIL: stills are relayed as published; nothing analyses them.

import { UA, exactPath, MINUTE, HOUR } from './common.js';

const CATALOGUE_CACHE = { ttlMs: 15 * MINUTE, staleMs: 24 * HOUR };

/** allowQuery: exactly these keys, each once, each value passing its test. */
const queryExactly = (tests) => (q) => {
  const keys = [...q.keys()];
  if (keys.length !== Object.keys(tests).length || new Set(keys).size !== keys.length)
    return false;
  return Object.entries(tests).every(([k, ok]) => q.has(k) && ok(q.get(k)));
};
const noQuery = queryExactly({});

/** The 25 district codes TxDOT's ITS catalogue knows. */
const TXDOT_DISTRICTS = new Set(
  (
    'ABL AMA ATL AUS BMT BWD BRY CHS CRP DAL ELP FTW HOU ' +
    'LRD LBB LFK ODA PAR PHR SJT SAT TYL WAC WFS YKM'
  ).split(' '),
);
const district = (v) => TXDOT_DISTRICTS.has(v);

// Digitraffic asks every client to name itself (company/application).
const DIGITRAFFIC = { ...UA, 'digitraffic-user': 'H4ch1Net/Argus' };

/** @type {import('../feeds.js').Feed[]} */
export const feeds = [
  {
    // Ontario 511 (Open Government Licence - Ontario, credit "Ontario 511"), this
    // feed and on511-img. Per the reference implementation, not live-tested here.
    id: 'on511',
    baseUrl: 'https://511on.ca/api/v2/get',
    methods: ['GET'],
    allowPaths: [exactPath('/api/v2/get/cameras')],
    allowQuery: queryExactly({
      format: (v) => v === 'json',
      lang: (v) => /^(en|fr)$/.test(v),
    }),
    headers: UA,
    governor: { ratePerMinute: 6 },
    cache: CATALOGUE_CACHE,
  },
  {
    id: 'on511-img',
    baseUrl: 'https://511on.ca/map/Cctv',
    methods: ['GET'],
    allowPaths: [/^\/map\/Cctv\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}$/],
    allowQuery: noQuery,
    headers: UA,
    governor: { ratePerMinute: 120 },
  },
  {
    // DriveBC, British Columbia (Open Government Licence - British Columbia,
    // attribution required). The list the DriveBC.ca site itself serves; stills
    // are built from the numeric id (the old images.drivebc.ca host is retired).
    // Per the reference implementation, not live-tested here.
    id: 'drivebc',
    baseUrl: 'https://www.drivebc.ca/api',
    methods: ['GET'],
    allowPaths: [exactPath('/api/webcams/')],
    allowQuery: noQuery,
    headers: UA,
    governor: { ratePerMinute: 6 },
    cache: CATALOGUE_CACHE,
  },
  {
    id: 'drivebc-img',
    baseUrl: 'https://www.drivebc.ca/images',
    methods: ['GET'],
    allowPaths: [/^\/images\/\d{1,7}\.jpg$/],
    allowQuery: noQuery,
    headers: UA,
    governor: { ratePerMinute: 120 },
  },
  {
    // Open Calgary, Socrata dataset k7p9-kppz (Open Government Licence - City of
    // Calgary, attribution required). The whole city is ~215 rows.
    // Per the reference implementation, not live-tested here.
    id: 'calgary',
    baseUrl: 'https://data.calgary.ca/resource',
    methods: ['GET'],
    allowPaths: [exactPath('/resource/k7p9-kppz.json')],
    allowQuery: queryExactly({ $limit: (v) => /^\d{1,4}$/.test(v) && Number(v) <= 1000 }),
    headers: UA,
    governor: { ratePerMinute: 6 },
    cache: CATALOGUE_CACHE,
  },
  {
    // Stills on the city's own host (the catalogue's http:// URLs are upgraded).
    id: 'calgary-img',
    baseUrl: 'https://trafficcam.calgary.ca',
    methods: ['GET'],
    allowPaths: [/^\/[A-Za-z0-9_-]{1,64}\.jpg$/],
    allowQuery: noQuery,
    headers: UA,
    governor: { ratePerMinute: 120 },
  },
  {
    // Fintraffic road weather cameras via Digitraffic (CC BY 4.0, credit
    // "Fintraffic / digitraffic.fi"). One station list for all of Finland.
    // Digitraffic expects compressed transfers: Node's fetch offers gzip itself.
    // Per the reference implementation, not live-tested here.
    id: 'fintraffic',
    baseUrl: 'https://tie.digitraffic.fi/api/weathercam/v1',
    methods: ['GET'],
    allowPaths: [exactPath('/api/weathercam/v1/stations')],
    allowQuery: noQuery,
    headers: DIGITRAFFIC,
    governor: { ratePerMinute: 6 },
    cache: CATALOGUE_CACHE,
  },
  {
    // A preset still: C + station + two-digit view. Refreshed upstream every 10 min.
    id: 'fintraffic-img',
    baseUrl: 'https://weathercam.digitraffic.fi',
    methods: ['GET'],
    allowPaths: [/^\/C\d{7}\.jpg$/],
    allowQuery: noQuery,
    headers: DIGITRAFFIC,
    governor: { ratePerMinute: 120 },
  },
  {
    // TxDOT ITS, one catalogue per district (courtesy credit, Texas Department
    // of Transportation). Only the district status list is reachable here.
    // Per the reference implementation, not live-tested here.
    id: 'txdot',
    baseUrl: 'https://its.txdot.gov/its/DistrictIts',
    methods: ['GET'],
    allowPaths: [exactPath('/its/DistrictIts/GetCctvStatusListByDistrict')],
    allowQuery: queryExactly({ districtCode: district }),
    headers: UA,
    governor: { ratePerMinute: 20 },
    cache: CATALOGUE_CACHE,
  },
  {
    // A TxDOT still is JSON ({ snippet: <base64 JPEG> }), not an image body; the
    // relay passes it through untouched and the card decodes it (validated
    // base64, JPEG magic) in core/layers/trafficcams/format.js.
    id: 'txdot-img',
    baseUrl: 'https://its.txdot.gov/its/DistrictIts',
    methods: ['GET'],
    allowPaths: [exactPath('/its/DistrictIts/GetCctvSnapshotByIcdId')],
    allowQuery: queryExactly({
      icdId: (v) => /^[\x20-\x7e]{1,100}$/.test(v),
      districtCode: district,
    }),
    headers: UA,
    governor: { ratePerMinute: 60 },
  },
  {
    // City of Austin Open Data, Socrata rows.json (City of Austin Open Data
    // terms, credit "City of Austin, TX: data.austintexas.gov"). A large file,
    // hence the cache and a low rate.
    // Per the reference implementation, not live-tested here.
    id: 'austin',
    baseUrl: 'https://data.austintexas.gov/api/views',
    methods: ['GET'],
    allowPaths: [exactPath('/api/views/b4k4-adkb/rows.json')],
    allowQuery: queryExactly({ accessType: (v) => v === 'DOWNLOAD' }),
    headers: UA,
    governor: { ratePerMinute: 4 },
    cache: CATALOGUE_CACHE,
  },
  {
    id: 'austin-img',
    baseUrl: 'https://cctv.austinmobility.io/image',
    methods: ['GET'],
    allowPaths: [/^\/image\/\d{1,7}\.jpg$/],
    allowQuery: noQuery,
    headers: UA,
    governor: { ratePerMinute: 120 },
  },
  {
    // Transpordiamet / Tarktee, Estonia (courtesy credit): two DATEX II XML
    // documents, camera locations and the current still of each, joined by a
    // regex parser that refuses any DOCTYPE or ENTITY declaration.
    // Per the reference implementation, not live-tested here.
    id: 'tarktee',
    baseUrl: 'https://tarktee.transpordiamet.ee/api/v1/datex',
    methods: ['GET'],
    allowPaths: [/^\/api\/v1\/datex\/(roadCameraLocations|roadCameraImages)$/],
    allowQuery: noQuery,
    // Asked for as XML whatever Accept the client's text request carried.
    headers: { ...UA, accept: 'application/xml, text/xml;q=0.9' },
    governor: { ratePerMinute: 8 },
    cache: CATALOGUE_CACHE,
  },
  {
    // Still file names rotate with each capture; the catalogue cache keeps them current.
    id: 'tarktee-img',
    baseUrl: 'https://tarktee.transpordiamet.ee/images',
    methods: ['GET'],
    allowPaths: [/^\/images\/\d{1,6}\/[A-Za-z0-9_-]{1,64}\.jpe?g$/],
    allowQuery: noQuery,
    headers: UA,
    governor: { ratePerMinute: 120 },
  },
  {
    // City of Tallinn intersection cameras (courtesy credit). The catalogue is
    // curated and bundled (core/layers/trafficcams/data/tallinn.js).
    // Per the reference implementation, not live-tested here.
    id: 'tallinn-img',
    baseUrl: 'https://ristmikud.tallinn.ee/last',
    methods: ['GET'],
    allowPaths: [/^\/last\/cam\d{3}\.jpg$/],
    allowQuery: noQuery,
    headers: UA,
    governor: { ratePerMinute: 120 },
  },
  {
    // The Stadt Warendorf Marktplatz webcam (courtesy credit), one camera from a
    // bundled curated catalogue. The city serves it over plain http; the
    // browser only ever sees it on the proxy's HTTPS origin.
    // Per the reference implementation, not live-tested here.
    id: 'warendorf-img',
    baseUrl: 'http://webcam.warendorf.de/image',
    methods: ['GET'],
    allowPaths: [exactPath('/image/jpeg.cgi')],
    allowQuery: noQuery,
    headers: UA,
    governor: { ratePerMinute: 30 },
  },
];
