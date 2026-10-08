// Public traffic-camera networks, as the reference project reads them plus
// more DOT networks per their own documentation, and the layer's source: which
// catalogues the view needs, how each is loaded, and how many of its cameras
// are kept. Each catalogue is a proxy feed;
// each camera's still is a second, image-only proxy feed, so the browser never
// talks to a camera host directly. Two networks are curated catalogues bundled
// here (data/), so only their stills are fetched. Parsing lives in ./parse.js.
//
// The networks after Statens vegvesen, their coverage, caps and anchors, are
// adapted from gods-eye-view server/providers/cctv/constants.js and
// sources.js (MIT). Their endpoints are per the reference implementation, not
// live-tested here.
//
// Added from each provider's documentation (not live-tested here): Caltrans
// districts 1, 2, 5, 6, 8, 9, 10 and 12; NYC DOT; Singapore LTA (data.gov.sg);
// and the keyed networks (WSDOT and the 511-platform states: 511NY, AZ511,
// 511GA, 511WI, Idaho 511, UDOT Traffic, Alaska 511, NVroads, 511LA, CTroads),
// each offered only when the proxy holds its key (`keyed`, see isConfigured).
//
// Not ported, on purpose:
// - Live Traffic NSW: its image host answers non-browser clients with an HTML
//   placeholder, so the reference spoofs a Chrome User-Agent. Argus names
//   itself to every upstream and does not impersonate a browser.
// - DelDOT (Delaware): HLS video only, no still to show; relaying it would be
//   a new proxy subsystem, and redistribution beyond personal viewing is
//   unconfirmed.
//
// GUARDRAIL: stills are shown as published, on request (a card), and nothing in
// this project analyses them: no plate reading, no tracking, no detection.

import { insideView, padBBox } from '../sdk/bbox.js';
import { parseCameraCatalog } from './parse.js';

export { parseCameraCatalog };

/**
 * @typedef {{ lat: number, lon: number }} Anchor
 * @typedef {{ id: string, provider: string, region: string,
 *   bbox: [number, number, number, number], feedId: string|null, path?: string,
 *   paths?: string[], params?: Record<string, string|number>,
 *   kind: 'caltrans'|'tfl'|'vegvesen'|'ontario511'|'drivebc'|'calgary'|'fintraffic'|
 *     'txdot'|'austin'|'tarktee'|'tallinn'|'warendorf'|'traveliq'|'wsdot'|'nycdot'|
 *     'ltasg',
 *   license: string, licenseUrl?: string, network?: string, cap?: number,
 *   anchors?: Anchor[], curated?: boolean,
 *   boxes?: Array<[number, number, number, number]>,
 *   keyed?: boolean, env?: string, host?: string, imageFeed?: string }} CameraSource
 * bbox: the network's whole coverage; boxes, when given, a finer cover inside
 * it for a network one rectangle fits badly (Norway's would take in Sweden,
 * Finland and Estonia). A catalogue is fetched only when a box overlaps the view.
 * feedId null: a curated catalogue bundled in data/, nothing to fetch.
 * network: sources sharing it (TxDOT's districts) share one cap.
 * cap: at most this many of the network's cameras in view are kept, nearest
 * first to the view centre and the network's anchors in view.
 * keyed: the catalogue feed needs a key on the proxy (env names it); such a
 * network is offered only when the proxy reports its feed configured. host and
 * imageFeed: a 511-platform network's own host and its image-only feed.
 */

const caltrans = (district, region, bbox) => ({
  id: `caltrans-d${district}`,
  provider: 'Caltrans',
  region,
  bbox,
  feedId: 'caltrans',
  path: `/d${district}/cctv/cctvStatusD${String(district).padStart(2, '0')}.json`,
  kind: 'caltrans',
  license: 'Caltrans public highway camera',
});

// TxDOT: one catalogue per district. The five metro districts the reference
// anchors on; bboxes are the districts' counties, rounded outward (they only
// decide which catalogues a view fetches). The proxy accepts all 25 codes.
const TXDOT_ANCHORS = [
  { lat: 30.2672, lon: -97.7431 }, // Austin
  { lat: 29.4241, lon: -98.4936 }, // San Antonio
  { lat: 29.7604, lon: -95.3698 }, // Houston
  { lat: 32.7767, lon: -96.797 }, // Dallas
  { lat: 32.7555, lon: -97.3308 }, // Fort Worth
];
const txdot = (code, region, bbox, boxes) => ({
  id: `txdot-${code.toLowerCase()}`,
  provider: 'TxDOT',
  region,
  bbox,
  ...(boxes ? { boxes } : {}),
  feedId: 'txdot',
  path: '/GetCctvStatusListByDistrict',
  params: { districtCode: code },
  kind: 'txdot',
  license: 'Texas Department of Transportation (courtesy)',
  licenseUrl: 'https://its.txdot.gov/',
  network: 'txdot',
  cap: 500,
  anchors: TXDOT_ANCHORS,
});

// The 511 platform (the one Ontario 511 runs): one developer key per state,
// injected by the proxy (proxy/feeds/webcams.js). keyed: offered only when the
// proxy reports the feed configured. Per each network's documentation, not
// live-tested here.
const travelIq = (id, provider, region, host, bbox, cap, anchors, env, path) => ({
  id,
  provider,
  region,
  bbox,
  feedId: id,
  path: path ?? '/cameras',
  params: { format: 'json' },
  kind: 'traveliq',
  keyed: true,
  env,
  host,
  imageFeed: `${id}-img`,
  license: `${provider} (courtesy; developer API terms with your own key)`,
  licenseUrl: `https://${host}/`,
  cap,
  anchors,
});
const at = (lat, lon) => ({ lat, lon });

/** @type {CameraSource[]} bbox is [west, south, east, north]. */
export const CAMERA_SOURCES = [
  caltrans(4, 'San Francisco Bay Area', [-123.6, 36.9, -121.2, 38.9]),
  caltrans(7, 'Los Angeles and Ventura', [-119.5, 33.6, -117.6, 34.9]),
  caltrans(11, 'San Diego and Imperial', [-117.7, 32.5, -114.4, 33.6]),
  caltrans(3, 'Sacramento Valley and Sierra', [-123.1, 38.0, -119.9, 40.8]),
  // The rest of the twelve Caltrans districts: same catalogue and still shapes
  // on the same host (the proxy's caltrans pins accept every district).
  caltrans(1, 'North Coast', [-124.5, 38.6, -122.3, 42.05]),
  caltrans(2, 'Northeastern California', [-123.7, 39.6, -119.9, 42.05]),
  caltrans(5, 'Central Coast', [-122.2, 34.3, -119.4, 37.3]),
  caltrans(6, 'Fresno and Bakersfield', [-121.0, 34.8, -117.6, 37.6]),
  caltrans(8, 'Inland Empire', [-117.85, 33.4, -114.1, 35.85]),
  caltrans(9, 'Eastern Sierra', [-119.7, 35.1, -115.6, 38.75]),
  caltrans(10, 'Stockton and the Mother Lode', [-121.6, 36.7, -119.2, 38.95]),
  caltrans(12, 'Orange County', [-118.15, 33.35, -117.4, 33.95]),
  {
    id: 'tfl',
    provider: 'Transport for London',
    region: 'London',
    bbox: [-0.6, 51.25, 0.35, 51.72],
    feedId: 'tfl',
    path: '/Place/Type/JamCam',
    kind: 'tfl',
    license: 'Powered by TfL Open Data',
  },
  {
    id: 'vegvesen',
    provider: 'Statens vegvesen',
    region: 'Norway',
    bbox: [4, 57.8, 31.5, 71.5],
    boxes: [
      [4.0, 57.8, 13.0, 63.0], // southern Norway
      [8.0, 62.0, 15.0, 66.0], // Trondelag and southern Nordland
      [11.5, 65.5, 23.0, 70.5], // Nordland and Troms
      [20.5, 68.5, 31.5, 71.5], // Finnmark
    ],
    feedId: 'vegvesen',
    path: '/datex_3_1:CctvSimple/items',
    params: { f: 'application/geo+json', limit: 5000 },
    kind: 'vegvesen',
    license: 'NLOD (Statens vegvesen)',
  },
  {
    id: 'on511',
    provider: 'Ontario 511',
    region: 'Ontario',
    bbox: [-95.2, 41.6, -74.3, 56.9],
    feedId: 'on511',
    path: '/cameras',
    params: { format: 'json', lang: 'en' },
    kind: 'ontario511',
    license: 'Ontario 511, Open Government Licence - Ontario',
    licenseUrl: 'https://www.ontario.ca/page/open-government-licence-ontario',
    cap: 1000,
    anchors: [
      { lat: 43.4516, lon: -80.4925 }, // Kitchener
      { lat: 43.6532, lon: -79.3832 }, // Toronto
      { lat: 45.4215, lon: -75.6972 }, // Ottawa
      { lat: 43.2557, lon: -79.8711 }, // Hamilton
      { lat: 42.9849, lon: -81.2453 }, // London, Ontario
      { lat: 42.3149, lon: -83.0364 }, // Windsor
    ],
  },
  {
    id: 'drivebc',
    provider: 'DriveBC',
    region: 'British Columbia',
    bbox: [-139.1, 48.2, -114.0, 60.0],
    feedId: 'drivebc',
    path: '/webcams/',
    kind: 'drivebc',
    license:
      'DriveBC. Contains information licensed under the Open Government Licence - British Columbia',
    licenseUrl:
      'https://www2.gov.bc.ca/gov/content/data/open-data/open-government-licence-bc',
    cap: 250,
    anchors: [
      { lat: 49.2827, lon: -123.1207 }, // Vancouver
      { lat: 48.4284, lon: -123.3656 }, // Victoria
    ],
  },
  {
    id: 'calgary',
    provider: 'The City of Calgary',
    region: 'Calgary',
    bbox: [-114.4, 50.8, -113.8, 51.25],
    feedId: 'calgary',
    path: '/k7p9-kppz.json',
    params: { $limit: 500 },
    kind: 'calgary',
    license:
      'Contains information licensed under the Open Government Licence - City of Calgary',
    licenseUrl: 'https://data.calgary.ca/stories/s/Open-Calgary-Terms-of-Use/u45n-7awa',
    cap: 220,
    anchors: [{ lat: 51.0461, lon: -114.0626 }], // Centre Street / 7 Avenue
  },
  {
    id: 'fintraffic',
    provider: 'Fintraffic',
    region: 'Finland',
    bbox: [19.0, 59.75, 32.0, 70.5],
    feedId: 'fintraffic',
    path: '/stations',
    kind: 'fintraffic',
    license: 'Fintraffic / digitraffic.fi, CC BY 4.0',
    licenseUrl: 'https://www.digitraffic.fi/en/terms-of-service/',
    cap: 300,
    anchors: [
      { lat: 60.1699, lon: 24.9384 }, // Helsinki
      { lat: 60.4518, lon: 22.2666 }, // Turku
      { lat: 61.4978, lon: 23.761 }, // Tampere
      { lat: 62.2426, lon: 25.7473 }, // Jyvaskyla
      { lat: 62.8924, lon: 27.677 }, // Kuopio
      { lat: 65.0121, lon: 25.4651 }, // Oulu
      { lat: 66.5039, lon: 25.7294 }, // Rovaniemi
    ],
  },
  // The two districts interlock: Austin's reaches south of 30 N only east of
  // 98.3 W (Hays, Caldwell), San Antonio's north of it only west of there
  // (Kendall, Kerr), so a single box for either would take in the other's city.
  txdot(
    'AUS',
    'Austin district',
    [-99.6, 29.5, -96.6, 31.1],
    [
      [-99.6, 29.95, -96.6, 31.1],
      [-98.3, 29.55, -96.6, 30.0],
    ],
  ),
  txdot(
    'SAT',
    'San Antonio district',
    [-100.2, 28.0, -97.5, 30.4],
    [
      [-100.2, 28.0, -98.25, 30.4],
      [-98.3, 28.0, -97.5, 30.05],
    ],
  ),
  txdot('HOU', 'Houston district', [-96.3, 28.7, -94.3, 30.7]),
  txdot('DAL', 'Dallas district', [-97.45, 31.7, -95.95, 33.45]),
  txdot('FTW', 'Fort Worth district', [-98.6, 31.9, -97.0, 33.45]),
  {
    id: 'austin',
    provider: 'City of Austin',
    region: 'Austin',
    bbox: [-98.12, 30.02, -97.4, 30.58],
    feedId: 'austin',
    path: '/b4k4-adkb/rows.json',
    params: { accessType: 'DOWNLOAD' },
    kind: 'austin',
    license: 'City of Austin, TX: data.austintexas.gov (City of Austin Open Data terms)',
    licenseUrl: 'https://data.austintexas.gov',
    cap: 250,
    anchors: [{ lat: 30.2672, lon: -97.7431 }], // Congress and 6th
  },
  {
    id: 'tarktee',
    provider: 'Transpordiamet (Tarktee)',
    region: 'Estonia',
    bbox: [21.5, 57.4, 28.4, 59.9],
    feedId: 'tarktee',
    paths: ['/roadCameraLocations', '/roadCameraImages'],
    kind: 'tarktee',
    license: 'Transpordiamet / Tarktee, tarktee.transpordiamet.ee (courtesy)',
    licenseUrl: 'https://tarktee.transpordiamet.ee/',
    cap: 179,
    anchors: [
      { lat: 59.437, lon: 24.753 }, // Tallinn
      { lat: 58.378, lon: 26.729 }, // Tartu
      { lat: 58.3859, lon: 24.4971 }, // Parnu
      { lat: 59.3797, lon: 28.1791 }, // Narva
    ],
  },
  {
    id: 'tallinn',
    provider: 'City of Tallinn',
    region: 'Tallinn',
    bbox: [24.3, 59.2, 25.4, 59.7],
    feedId: null,
    kind: 'tallinn',
    curated: true,
    license: 'City of Tallinn, ristmikud.tallinn.ee (courtesy)',
    licenseUrl: 'https://ristmikud.tallinn.ee/',
    cap: 255,
    anchors: [{ lat: 59.437, lon: 24.753 }],
  },
  {
    id: 'warendorf',
    provider: 'Stadt Warendorf',
    region: 'Warendorf',
    bbox: [7.9, 51.9, 8.1, 52.0],
    feedId: null,
    kind: 'warendorf',
    curated: true,
    license:
      'Stadt Warendorf webcam (courtesy); pose from OpenStreetMap, (c) OpenStreetMap contributors (ODbL)',
    licenseUrl: 'https://www.openstreetmap.org/copyright',
    cap: 1,
  },
  // --- Keyless networks per their documentation (not live-tested here) ---
  {
    id: 'nycdot',
    provider: 'NYC DOT',
    region: 'New York City',
    bbox: [-74.27, 40.49, -73.68, 40.92],
    feedId: 'nycdot',
    path: '/cameras',
    kind: 'nycdot',
    license: 'NYC DOT traffic cameras, webcams.nyctmc.org (courtesy)',
    licenseUrl: 'https://webcams.nyctmc.org/',
    cap: 900,
    anchors: [at(40.758, -73.9855)], // Midtown
  },
  {
    id: 'lta-sg',
    provider: 'Land Transport Authority',
    region: 'Singapore',
    bbox: [103.6, 1.2, 104.1, 1.48],
    feedId: 'lta-sg',
    path: '/traffic-images',
    kind: 'ltasg',
    license:
      'Contains information from Traffic Images accessed from data.gov.sg, made available under the Singapore Open Data Licence version 1.0',
    licenseUrl: 'https://data.gov.sg/open-data-licence',
    cap: 120,
  },
  // --- Keyed networks: offered only when the proxy has the key ---
  {
    id: 'wsdot',
    provider: 'WSDOT',
    region: 'Washington State',
    bbox: [-124.85, 45.5, -116.9, 49.05],
    feedId: 'wsdot',
    path: '/GetCamerasAsJson',
    kind: 'wsdot',
    keyed: true,
    env: 'WSDOT_ACCESS_CODE',
    license: 'Washington State Department of Transportation (courtesy)',
    licenseUrl: 'https://wsdot.wa.gov/',
    cap: 500,
    anchors: [
      at(47.6062, -122.3321), // Seattle
      at(47.2529, -122.4443), // Tacoma
      at(47.6588, -117.426), // Spokane
      at(45.6387, -122.6615), // Vancouver, WA
      at(48.9935, -122.7543), // Blaine (the border crossings)
    ],
  },
  travelIq(
    'ny511',
    '511NY',
    'New York State',
    '511ny.org',
    [-79.8, 40.45, -71.8, 45.05],
    600,
    [
      at(40.7128, -74.006), // New York City
      at(40.79, -73.13), // Long Island
      at(42.6526, -73.7562), // Albany
      at(43.0481, -76.1474), // Syracuse
      at(43.1566, -77.6088), // Rochester
      at(42.8864, -78.8784), // Buffalo
    ],
    'NY511_KEY',
    '/getcameras',
  ),
  travelIq(
    'az511',
    'AZ511',
    'Arizona',
    'az511.gov',
    [-114.85, 31.3, -109.0, 37.0],
    400,
    [at(33.4484, -112.074), at(32.2226, -110.9747), at(35.1983, -111.6513)],
    'AZ511_KEY',
  ),
  travelIq(
    'ga511',
    '511GA',
    'Georgia',
    '511ga.org',
    [-85.65, 30.35, -80.8, 35.0],
    600,
    [
      at(33.749, -84.388),
      at(32.0809, -81.0912),
      at(33.4735, -82.0105),
      at(32.8407, -83.6324),
    ],
    'GA511_KEY',
  ),
  travelIq(
    'wi511',
    '511WI',
    'Wisconsin',
    '511wi.gov',
    [-92.9, 42.45, -86.75, 47.1],
    300,
    [at(43.0389, -87.9065), at(43.0731, -89.4012), at(44.5133, -88.0133)],
    'WI511_KEY',
  ),
  travelIq(
    'id511',
    'Idaho 511',
    'Idaho',
    '511.idaho.gov',
    [-117.25, 41.95, -111.0, 49.0],
    250,
    [at(43.615, -116.2023), at(47.6777, -116.7805), at(43.4917, -112.0339)],
    'ID511_KEY',
  ),
  travelIq(
    'udot',
    'UDOT Traffic',
    'Utah',
    'udottraffic.utah.gov',
    [-114.05, 36.95, -109.0, 42.0],
    500,
    [
      at(40.7608, -111.891),
      at(40.2338, -111.6585),
      at(41.223, -111.9738),
      at(37.0965, -113.5684),
    ],
    'UDOT_TRAFFIC_KEY',
  ),
  travelIq(
    'ak511',
    'Alaska 511',
    'Alaska',
    '511.alaska.gov',
    [-170.0, 51.0, -129.9, 71.5],
    200,
    [at(61.2181, -149.9003), at(64.8378, -147.7164), at(58.3019, -134.4197)],
    'AK511_KEY',
  ),
  travelIq(
    'nvroads',
    'NVroads',
    'Nevada',
    'www.nvroads.com',
    [-120.0, 35.0, -114.0, 42.0],
    400,
    [at(36.1699, -115.1398), at(39.5296, -119.8138)],
    'NVROADS_KEY',
  ),
  travelIq(
    'la511',
    '511LA',
    'Louisiana',
    'www.511la.org',
    [-94.05, 28.9, -88.8, 33.05],
    300,
    [
      at(29.9511, -90.0715),
      at(30.4515, -91.1871),
      at(32.5252, -93.7502),
      at(30.2241, -92.0198),
    ],
    'LA511_KEY',
  ),
  travelIq(
    'ctroads',
    'CTroads',
    'Connecticut',
    'ctroads.org',
    [-73.75, 40.95, -71.78, 42.05],
    300,
    [at(41.7658, -72.6734), at(41.3083, -72.9279), at(41.0534, -73.5387)],
    'CTROADS_KEY',
  ),
];

/** The networks that need a key on the proxy: [{ id, feedId, env, provider }]. */
export const KEYED_CAMERA_SOURCES = Object.freeze(
  CAMERA_SOURCES.filter((s) => s.keyed).map(({ id, feedId, env, provider }) => ({
    id,
    feedId,
    env,
    provider,
  })),
);

/** Views wider than this (degrees of latitude) skip cameras. */
export const CAMERA_MAX_SPAN_DEG = 12;

export function sourcesInView(bbox, sources = CAMERA_SOURCES) {
  if (!bbox) return { sources: [], tooWide: false };
  if (bbox.lamax - bbox.lamin > CAMERA_MAX_SPAN_DEG)
    return { sources: [], tooWide: true };
  const overlaps = (b) =>
    b[0] <= bbox.lomax && b[2] >= bbox.lomin && b[1] <= bbox.lamax && b[3] >= bbox.lamin;
  return {
    sources: sources.filter((src) => (src.boxes ?? [src.bbox]).some(overlaps)),
    tooWide: false,
  };
}

// How a catalogue is loaded, by kind; anything not listed is one JSON GET.
// Curated catalogues are imported only when their city is in view.
const LOADERS = {
  tarktee: async (src, client, signal) => {
    const [locations, images] = await Promise.all(
      src.paths.map((p) => client.getText(src.feedId, p, { signal })),
    );
    return { locations, images };
  },
  tallinn: async () => (await import('./data/tallinn.js')).TALLINN_CAMERAS,
  warendorf: async () => (await import('./data/warendorf.js')).WARENDORF_CAMERAS,
};
const loadCatalog = (src, client, signal) =>
  LOADERS[src.kind]
    ? LOADERS[src.kind](src, client, signal)
    : client.getJson(src.feedId, src.path, { params: src.params, signal });

/** Squared distance in degrees, longitude scaled by latitude: fine for ranking. */
const dist2 = (a, b) => {
  const k = Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return (a.lat - b.lat) ** 2 + ((a.lon - b.lon) * k) ** 2;
};

/** The view centre plus the anchors inside the (padded) view, or all anchors. */
export function rankingAnchors(bbox, anchors = []) {
  if (!bbox) return anchors;
  const centre = {
    lat: (bbox.lamin + bbox.lamax) / 2,
    lon: (bbox.lomin + bbox.lomax) / 2,
  };
  const b = padBBox(bbox);
  const inside = anchors.filter(
    (a) => a.lat >= b.lamin && a.lat <= b.lamax && a.lon >= b.lomin && a.lon <= b.lomax,
  );
  return [centre, ...inside];
}

/**
 * At most `cap` cameras, nearest first to any anchor (ties keep feed order).
 * No cap, no anchors, or a list within the cap: returned as is.
 */
export function capCameras(cameras, cap, anchors) {
  if (!cap || cameras.length <= cap || !anchors?.length) return cameras;
  return cameras
    .map((c, i) => ({ c, i, d: Math.min(...anchors.map((a) => dist2(c, a))) }))
    .sort((x, y) => x.d - y.d || x.i - y.i)
    .slice(0, cap)
    .map((x) => x.c);
}

/**
 * The networks a proxy can serve: keyless ones always, keyed ones only when
 * isConfigured(feedId) says the proxy holds their key.
 */
export const offeredSources = (sources, isConfigured = () => false) =>
  sources.filter((s) => !s.keyed || isConfigured(s.feedId));

/**
 * The layer's source: fetch the catalogues in view, parse them, keep each
 * network's cameras around the view (within its cap), and resolve each still
 * to its proxy URL. One failing catalogue does not blank the rest.
 * @param {{ proxyClient: { getJson: Function, getText: Function, buildUrl: Function },
 *   sources?: CameraSource[], isConfigured?: (feedId: string) => boolean }} opts
 *   isConfigured: whether the proxy holds a keyed network's key (main.js
 *   passes feedConfigured(health, id)); keyed networks are skipped without it.
 */
export function createTrafficCamSource({
  proxyClient,
  sources = CAMERA_SOURCES,
  isConfigured = () => false,
  memoMs = 60_000,
  now = () => Date.now(),
}) {
  // The last answer, reused for the same view for a minute: a filter change
  // (layer.refresh()) re-draws from it instead of asking the proxy again.
  let last = null; // { key, at, result }
  return async (query, signal) => {
    const bbox = query?.bbox;
    const key = bbox ? `${bbox.lamin},${bbox.lomin},${bbox.lamax},${bbox.lomax}` : '';
    if (last && last.key === key && now() - last.at < memoMs) return last.result;
    const result = await load(bbox, signal);
    last = { key, at: now(), result };
    return result;
  };

  async function load(bbox, signal) {
    const view = sourcesInView(bbox, offeredSources(sources, isConfigured));
    const settled = await Promise.allSettled(
      view.sources.map(async (src) =>
        parseCameraCatalog(await loadCatalog(src, proxyClient, signal), src),
      ),
    );
    const failed = settled.filter((r) => r.status === 'rejected');
    if (failed.length && failed.length === settled.length) throw failed[0].reason;
    // Catalogues cover a whole state or country; keep the cameras around the view.
    const inside = insideView(bbox);
    const networks = new Map(); // network -> { src, cams }
    settled.forEach((r, i) => {
      if (r.status !== 'fulfilled') return;
      const src = view.sources[i];
      const key = src.network ?? src.id;
      const entry = networks.get(key) ?? { src, cams: [] };
      for (const c of r.value) if (inside(c.lat, c.lon)) entry.cams.push(c);
      networks.set(key, entry);
    });
    const cameras = [...networks.values()].flatMap(({ src, cams }) =>
      capCameras(cams, src.cap, rankingAnchors(bbox, src.anchors)),
    );
    for (const c of cameras) {
      c.imageUrl = proxyClient.buildUrl(c.image.feedId, c.image.path, c.image.params);
      c.imageFormat = c.image.format ?? null;
    }
    return {
      cameras,
      tooWide: view.tooWide,
      inView: view.sources.length,
      failed: failed.length,
    };
  }
}
