// Public traffic-camera catalogues (keyless), as the reference project reads
// them: Caltrans (one JSON per district), Transport for London JamCams, and
// Statens vegvesen (Norway, OGC API Features). Each catalogue is a proxy feed;
// each camera's still image is a second, image-only proxy feed, so the browser
// never talks to a camera host directly. Pure: parsing and selection only.
//
// GUARDRAIL: stills are shown as published, on request (a card), and nothing in
// this project analyses them: no plate reading, no tracking, no detection.

/**
 * @typedef {{ id: string, provider: string, region: string,
 *   bbox: [number, number, number, number], feedId: string, path: string,
 *   params?: Record<string, string|number>, kind: 'caltrans'|'tfl'|'vegvesen',
 *   license: string }} CameraSource
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
    feedId: 'vegvesen',
    path: '/datex_3_1:CctvSimple/items',
    params: { f: 'application/geo+json', limit: 5000 },
    kind: 'vegvesen',
    license: 'NLOD (Statens vegvesen)',
  },
];

/** Views wider than this (degrees of latitude) skip cameras. */
export const CAMERA_MAX_SPAN_DEG = 12;

export function sourcesInView(bbox, sources = CAMERA_SOURCES) {
  if (!bbox) return { sources: [], tooWide: false };
  if (bbox.lamax - bbox.lamin > CAMERA_MAX_SPAN_DEG)
    return { sources: [], tooWide: true };
  return {
    sources: sources.filter(
      (src) =>
        src.bbox[0] <= bbox.lomax &&
        src.bbox[2] >= bbox.lomin &&
        src.bbox[1] <= bbox.lamax &&
        src.bbox[3] >= bbox.lamin,
    ),
    tooWide: false,
  };
}

const num = (v) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const text = (v, max = 120) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
const url = (v) => {
  try {
    const u = new URL(String(v));
    return u.protocol === 'https:' && !u.username && !u.password ? u : null;
  } catch {
    return null;
  }
};
const located = (lat, lon) =>
  lat !== null &&
  lon !== null &&
  Math.abs(lat) <= 90 &&
  Math.abs(lon) <= 180 &&
  (lat || lon);

/** Caltrans: data[].cctv { inService, location {...}, imageData.static.currentImageURL }. */
function parseCaltrans(payload, src) {
  const out = [];
  for (const row of Array.isArray(payload?.data) ? payload.data : []) {
    const c = row?.cctv;
    if (!c || String(c.inService).toLowerCase() !== 'true') continue;
    const loc = c.location || {};
    const lat = num(loc.latitude);
    const lon = num(loc.longitude);
    if (!located(lat, lon)) continue;
    const img = url(c.imageData?.static?.currentImageURL);
    // Pinned to the official host and its image path (the proxy allowlist agrees).
    if (!img || img.hostname !== 'cwwp2.dot.ca.gov') continue;
    const m = /^\/data(\/d\d{1,2}\/cctv\/image\/[\w.-]+\/[\w.-]+\.jpg)$/.exec(
      img.pathname,
    );
    if (!m) continue;
    const full = text(loc.locationName, 160) || '';
    const code = (/^([A-Za-z0-9_-]+)\s*--/.exec(full)?.[1] || m[1]).toLowerCase();
    const label = full.replace(/^[A-Za-z0-9_-]+\s*--\s*/, '') || `Caltrans ${code}`;
    const near = text(loc.nearbyPlace, 60);
    out.push({
      id: `${src.id}-${code}`,
      name: near ? `${label} (${near})` : label,
      lat,
      lon,
      direction: text(loc.direction, 20),
      image: { feedId: 'caltrans-img', path: m[1] },
    });
  }
  return out;
}

/** TfL: [{ id, commonName, lat, lon, additionalProperties: [{ key, value }] }]. */
function parseTfl(list) {
  const out = [];
  for (const place of Array.isArray(list) ? list : []) {
    const props = {};
    for (const p of place?.additionalProperties || []) if (p?.key) props[p.key] = p.value;
    if (String(props.available).toLowerCase() !== 'true') continue;
    const lat = num(place?.lat);
    const lon = num(place?.lon);
    if (!located(lat, lon)) continue;
    const img = url(props.imageUrl);
    if (!img || img.hostname !== 's3-eu-west-1.amazonaws.com') continue;
    const m = /^\/jamcams\.tfl\.gov\.uk(\/[\d.]+\.jpg)$/.exec(img.pathname);
    const rawId = String(place?.id || '').replace(/^JamCams_/, '');
    if (!m || !rawId) continue;
    out.push({
      id: `tfl-${rawId}`,
      name: text(place.commonName) || `JamCam ${rawId}`,
      lat,
      lon,
      direction: null,
      image: { feedId: 'tfl-img', path: m[1] },
    });
  }
  return out;
}

/** Vegvesen: GeoJSON features with { cameraId, description, stillImageUrl, ... }. */
function parseVegvesen(geojson) {
  const out = [];
  for (const f of Array.isArray(geojson?.features) ? geojson.features : []) {
    const p = f?.properties || {};
    const availability = String(p['status.stillImageAvailability'] ?? '').trim();
    if (availability && availability !== 'videoOrImagesAvailable') continue;
    const [lon, lat] = (f?.geometry?.coordinates || []).map(num);
    if (!located(lat ?? null, lon ?? null)) continue;
    const id = String(p.cameraId ?? '').trim();
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) continue;
    const img = url(p.stillImageUrl);
    if (!img || img.href !== `https://kamera.atlas.vegvesen.no/api/images/${id}`)
      continue;
    const place = text(p.description) || `Kamera ${id}`;
    const towards = text(p.orientationDescription);
    const road = text(p.roadNumber, 20);
    const name = towards && towards !== place ? `${place} → ${towards}` : place;
    out.push({
      id: `vegvesen-${id.toLowerCase()}`,
      name: road ? `${road} ${name}` : name,
      lat,
      lon,
      direction: towards,
      image: { feedId: 'vegvesen-img', path: `/${id}` },
    });
  }
  return out;
}

const PARSERS = { caltrans: parseCaltrans, tfl: parseTfl, vegvesen: parseVegvesen };

/** One catalogue payload -> camera records (each tagged with its source). */
export function parseCameraCatalog(payload, src) {
  const parse = PARSERS[src.kind];
  if (!parse) return [];
  return parse(payload, src).map((c) => ({
    ...c,
    provider: src.provider,
    region: src.region,
    license: src.license,
  }));
}

/**
 * The layer's source: fetch the catalogues in view, parse them, and resolve
 * each still to its proxy URL. One failing catalogue does not blank the rest.
 * @param {{ proxyClient: { getJson: Function, buildUrl: Function }, sources?: CameraSource[] }} opts
 */
export function createTrafficCamSource({ proxyClient, sources = CAMERA_SOURCES }) {
  return async (query, signal) => {
    const view = sourcesInView(query?.bbox, sources);
    const settled = await Promise.allSettled(
      view.sources.map(async (src) =>
        parseCameraCatalog(
          await proxyClient.getJson(src.feedId, src.path, { params: src.params, signal }),
          src,
        ),
      ),
    );
    const failed = settled.filter((r) => r.status === 'rejected');
    const ok = settled.filter((r) => r.status === 'fulfilled');
    if (failed.length && !ok.length) throw failed[0].reason;
    const cameras = ok.flatMap((r) => r.value);
    for (const c of cameras)
      c.imageUrl = proxyClient.buildUrl(c.image.feedId, c.image.path);
    return {
      cameras,
      tooWide: view.tooWide,
      inView: view.sources.length,
      failed: failed.length,
    };
  };
}
