// Public traffic-camera networks (keyless), as the reference project reads
// them, and the layer's source: which catalogues the view needs, how each is
// loaded, and how many of its cameras are kept. Each catalogue is a proxy feed;
// each camera's still is a second, image-only proxy feed, so the browser never
// talks to a camera host directly. Two networks are curated catalogues bundled
// here (data/), so only their stills are fetched. Parsing lives in ./parse.js.
//
// The networks after Statens vegvesen, their coverage, caps and anchors, are
// adapted from gods-eye-view server/providers/cctv/constants.js and
// sources.js (MIT). Their endpoints are per the reference implementation, not
// live-tested here.
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
 *     'txdot'|'austin'|'tarktee'|'tallinn'|'warendorf',
 *   license: string, licenseUrl?: string, network?: string, cap?: number,
 *   anchors?: Anchor[], curated?: boolean,
 *   boxes?: Array<[number, number, number, number]> }} CameraSource
 * bbox: the network's whole coverage; boxes, when given, a finer cover inside
 * it for a network one rectangle fits badly (Norway's would take in Sweden,
 * Finland and Estonia). A catalogue is fetched only when a box overlaps the view.
 * feedId null: a curated catalogue bundled in data/, nothing to fetch.
 * network: sources sharing it (TxDOT's districts) share one cap.
 * cap: at most this many of the network's cameras in view are kept, nearest
 * first to the view centre and the network's anchors in view.
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

/** @type {CameraSource[]} bbox is [west, south, east, north]. */
export const CAMERA_SOURCES = [
  caltrans(4, 'San Francisco Bay Area', [-123.6, 36.9, -121.2, 38.9]),
  caltrans(7, 'Los Angeles and Ventura', [-119.5, 33.6, -117.6, 34.9]),
  caltrans(11, 'San Diego and Imperial', [-117.7, 32.5, -114.4, 33.6]),
  caltrans(3, 'Sacramento Valley and Sierra', [-123.1, 38.0, -119.9, 40.8]),
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
];

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
 * The layer's source: fetch the catalogues in view, parse them, keep each
 * network's cameras around the view (within its cap), and resolve each still
 * to its proxy URL. One failing catalogue does not blank the rest.
 * @param {{ proxyClient: { getJson: Function, getText: Function, buildUrl: Function },
 *   sources?: CameraSource[] }} opts
 */
export function createTrafficCamSource({ proxyClient, sources = CAMERA_SOURCES }) {
  return async (query, signal) => {
    const bbox = query?.bbox;
    const view = sourcesInView(bbox, sources);
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
  };
}
