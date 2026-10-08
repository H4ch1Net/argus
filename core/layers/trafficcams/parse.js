// Pure catalogue parsers for the public traffic-camera networks. Each turns one
// catalogue payload into camera records:
//   { id, name, lat, lon, direction, image: { feedId, path, params?, format? },
//     headingDeg?, confidence?, curated?, groundM?, mountM?, overrides?,
//     region?, credit? }
// and parseCameraCatalog() adds the network's provider, licence and a pose
// prior (./pose.js). Shared by every shell (the terminal lists cameras too).
//
// Every still is pinned: a parser accepts only its network's official image
// host and path shape, the same shape that network's image-only proxy feed
// allows (proxy/feeds.js, proxy/feeds/cameras.js), so no catalogue field can
// steer the proxy anywhere else.
//
// The Ontario 511, DriveBC, Calgary, Fintraffic, TxDOT, Austin, Tarktee,
// Tallinn and Warendorf parsers are adapted from gods-eye-view
// server/providers/cctv/sources.js and normalize.js (MIT).
//
// GUARDRAIL: stills are shown as published, on request (a card). Nothing in
// this project analyses them: no plate reading, no tracking, no detection.

import { directionToHeading, posePrior } from './pose.js';

const num = (v) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const text = (v, max = 120) =>
  typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ').slice(0, max) : null;
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
/** Inside [west, south, east, north] (and never null island). */
const within = (lat, lon, [w, s, e, n]) =>
  located(lat, lon) && lat >= s && lat <= n && lon >= w && lon <= e;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const list = (v) => (Array.isArray(v) ? v : []);

/** Caltrans: data[].cctv { inService, location {...}, imageData.static.currentImageURL }. */
function parseCaltrans(payload, src) {
  const out = [];
  for (const row of list(payload?.data)) {
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
    // loc.elevation is in feet (the Sierra passes reach ~7,400).
    const ft = num(loc.elevation);
    out.push({
      id: `${src.id}-${code}`,
      name: near ? `${label} (${near})` : label,
      lat,
      lon,
      direction: text(loc.direction, 20),
      // A dedicated direction field ("West"), so bare cardinals count.
      headingDeg: directionToHeading(loc.direction, true),
      groundM: ft === null ? 150 : clamp(ft * 0.3048, -100, 4000),
      image: { feedId: 'caltrans-img', path: m[1] },
    });
  }
  return out;
}

/** TfL: [{ id, commonName, lat, lon, additionalProperties: [{ key, value }] }]. */
function parseTfl(payload) {
  const out = [];
  for (const place of list(payload)) {
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
      groundM: 15,
      image: { feedId: 'tfl-img', path: m[1] },
    });
  }
  return out;
}

/** Vegvesen: GeoJSON features with { cameraId, description, stillImageUrl, ... }. */
function parseVegvesen(geojson) {
  const out = [];
  for (const f of list(geojson?.features)) {
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
    // orientationDescription names the place the camera looks towards, not a
    // bearing: it goes into the label, and the heading stays unknown.
    const towards = text(p.orientationDescription);
    const road = text(p.roadNumber, 20);
    const name = towards && towards !== place ? `${place} → ${towards}` : place;
    out.push({
      id: `vegvesen-${id.toLowerCase()}`,
      name: road ? `${road} ${name}` : name,
      lat,
      lon,
      direction: towards,
      groundM: 150,
      image: { feedId: 'vegvesen-img', path: `/${id}` },
    });
  }
  return out;
}

// --- Ontario 511 -----------------------------------------------------------

const ONTARIO_BOX = [-95.6, 41.0, -74.0, 57.5];

/** A view URL on the official still host -> its view id, or null. */
function ontarioViewId(raw) {
  const u = url(typeof raw === 'string' ? raw.trim() : '');
  if (!u) return null;
  const host = u.hostname.toLowerCase();
  if (host !== '511on.ca' && !host.endsWith('.traveliq.co')) return null;
  const m = /^\/map\/Cctv\/([^/]+)$/.exec(u.pathname);
  if (!m) return null;
  let id;
  try {
    id = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  return /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}$/.test(id) ? id : null;
}

/** The first enabled view whose description does not say it is down. */
function pickOntarioView(views) {
  const enabled = list(views)
    .filter((v) => String(v?.Status ?? v?.status ?? '').toLowerCase() === 'enabled')
    .map((v) => ({
      id: ontarioViewId(v?.Url ?? v?.url),
      description: text(v?.Description ?? v?.description) || '',
    }))
    .filter((v) => v.id);
  return enabled.find((v) => !/\bdown\b/i.test(v.description)) || enabled[0] || null;
}

/** Ontario 511: [{ Id, Latitude, Longitude, Location, Roadway, Direction, Views }]. */
function parseOntario(rows) {
  const out = [];
  const seen = new Set();
  for (const row of list(rows)) {
    const rawId = String(row?.Id ?? row?.id ?? '').trim();
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(rawId) || seen.has(rawId)) continue;
    const lat = num(row?.Latitude ?? row?.latitude);
    const lon = num(row?.Longitude ?? row?.longitude);
    if (!within(lat, lon, ONTARIO_BOX)) continue;
    const view = pickOntarioView(row?.Views ?? row?.views);
    if (!view) continue;
    seen.add(rawId);
    const location = text(row?.Location ?? row?.location, 160);
    const roadway = text(row?.Roadway ?? row?.roadway, 80);
    const viewLabel = /\bdown\b/i.test(view.description) ? '' : view.description;
    const direction = text(row?.Direction ?? row?.direction, 30);
    out.push({
      id: `on511-${rawId.toLowerCase()}`,
      name: [location || roadway || `Ontario 511 camera ${rawId}`, viewLabel]
        .filter(Boolean)
        .join(' - '),
      lat,
      lon,
      direction,
      headingDeg:
        directionToHeading(direction, true) ?? directionToHeading(view.description, true),
      groundM: 200,
      image: { feedId: 'on511-img', path: `/${encodeURIComponent(view.id)}` },
    });
  }
  return out;
}

// --- DriveBC ---------------------------------------------------------------

const BC_BOX = [-139.5, 48.0, -114.0, 60.5];
const DRIVEBC_ORIENTATION = {
  N: 0,
  NE: 45,
  E: 90,
  SE: 135,
  S: 180,
  SW: 225,
  W: 270,
  NW: 315,
};

const decodeEntities = (s) =>
  s.replace(/&(lt|gt|quot|apos|amp|#\d{1,7}|#x[0-9a-f]{1,6});/gi, (_all, e) => {
    const named = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }[e.toLowerCase()];
    if (named) return named;
    const code =
      e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    return code > 31 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });

/**
 * DriveBC's `credit` field mixes partner image credits ("Images courtesy of
 * TransLink") with operational notes ("relies on solar power"). Only the credit
 * kind is kept, as plain text.
 */
export function driveBcImageCredit(raw) {
  const t = text(decodeEntities(String(raw ?? '').replace(/<[^>]*>/g, ' ')), 160);
  return t &&
    /courtesy|provided by|presented in cooperation|city of|parks canada/i.test(t)
    ? t
    : null;
}

/** DriveBC: [{ id, name, is_on, should_appear, location.coordinates, orientation, ... }]. */
function parseDriveBc(rows) {
  const out = [];
  for (const row of list(rows)) {
    if (row?.is_on !== true || row?.should_appear !== true) continue;
    if (!Number.isSafeInteger(row.id) || row.id <= 0 || row.id > 9_999_999) continue;
    const [lon, lat] = list(row.location?.coordinates).map(num);
    if (!within(lat ?? null, lon ?? null, BC_BOX)) continue;
    const heading =
      DRIVEBC_ORIENTATION[
        String(row.orientation ?? '')
          .trim()
          .toUpperCase()
      ];
    const region = text(row.region_name, 60);
    const elevation = num(row.elevation);
    out.push({
      id: `drivebc-${row.id}`,
      name: text(row.name) || `DriveBC camera ${row.id}`,
      lat,
      lon,
      direction: null,
      headingDeg: heading ?? null,
      groundM: elevation === null ? 0 : clamp(elevation, -100, 4000),
      region: region === 'Border Cams' ? 'BC border crossings' : region,
      credit: driveBcImageCredit(row.credit),
      image: { feedId: 'drivebc-img', path: `/${row.id}.jpg` },
    });
  }
  return out;
}

// --- Calgary ---------------------------------------------------------------

const CALGARY_BOX = [-114.4, 50.8, -113.8, 51.25];

/**
 * A frame URL -> its path on the official host. The catalogue publishes most
 * frames as http://; the host serves HTTPS, so the URL is upgraded, then
 * pinned to trafficcam.calgary.ca and a one-segment .jpg path.
 */
function calgaryImagePath(raw) {
  let u;
  try {
    u = new URL(String(raw ?? '').trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.hostname !== 'trafficcam.calgary.ca' || u.port || u.username || u.password)
    return null;
  return /^\/[A-Za-z0-9_-]{1,64}\.jpg$/.test(u.pathname) ? u.pathname : null;
}

/**
 * Open Calgary (Socrata k7p9-kppz): [{ point.coordinates, camera_url.url,
 * camera_location, quadrant }]. NO heading: `quadrant` ("NE") and the quadrant
 * suffix on every name are Calgary's address grid, not a facing; reading
 * either as a bearing would be confidently wrong for every camera.
 */
function parseCalgary(rows) {
  const out = [];
  const seen = new Set();
  for (const r of list(rows)) {
    const [lon, lat] = list(r?.point?.coordinates).map(num);
    if (!within(lat ?? null, lon ?? null, CALGARY_BOX)) continue;
    const path = calgaryImagePath(r?.camera_url?.url);
    if (!path) continue;
    const loc = /^\/loc(\d+)\.jpg$/i.exec(path);
    const key = loc ? loc[1] : path.slice(1, -4).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: `calgary-${key}`,
      name:
        text(r?.camera_location, 160) ||
        text(r?.camera_url?.description) ||
        `Calgary camera ${key}`,
      lat,
      lon,
      direction: null,
      groundM: 1045,
      image: { feedId: 'calgary-img', path },
    });
  }
  return out;
}

// --- Fintraffic (Digitraffic weather cameras) ------------------------------

const FINLAND_BOX = [19.0, 59.5, 32.0, 70.5];

/** "vt3_Hyvinkää_Noppo" + preset C0150301 of station C01503 -> "vt3 Hyvinkää Noppo (view 01)". */
export function fintrafficCameraName(stationName, stationId, presetId) {
  const base =
    text(String(stationName ?? '').replace(/_/g, ' ')) || `Fintraffic ${stationId}`;
  const view = String(presetId).slice(String(stationId).length);
  return view ? `${base} (view ${view})` : base;
}

/**
 * Fintraffic: GeoJSON stations, each with presets (fixed views sharing the
 * station position); one preset is one camera. Only GATHERING stations and
 * presets in collection. No compass heading exists in this data (the
 * per-preset direction is relative to road addresses), so headings stay unknown.
 */
function parseFintraffic(geojson) {
  const out = [];
  for (const f of list(geojson?.features)) {
    const p = f?.properties || {};
    const stationId = String(p.id ?? '').trim();
    if (!/^C\d{5}$/.test(stationId)) continue;
    if (String(p.collectionStatus ?? '').toUpperCase() !== 'GATHERING') continue;
    const [lon, lat, elev] = list(f?.geometry?.coordinates).map(num);
    if (!within(lat ?? null, lon ?? null, FINLAND_BOX)) continue;
    // 0 means "not reported", not sea level; 90 m is the observed median.
    const groundM = elev > 0 ? Math.min(1400, elev) : 90;
    for (const preset of list(p.presets)) {
      if (preset?.inCollection !== true) continue;
      const presetId = String(preset?.id ?? '').trim();
      // Strict shape (station id + two-digit view): also what keeps the
      // synthesized still path on the official host.
      if (!/^C\d{7}$/.test(presetId) || !presetId.startsWith(stationId)) continue;
      out.push({
        id: `fi-${presetId.toLowerCase()}`,
        name: fintrafficCameraName(p.name, stationId, presetId),
        lat,
        lon,
        direction: null,
        groundM,
        image: { feedId: 'fintraffic-img', path: `/${presetId}.jpg` },
      });
    }
  }
  return out;
}

// --- TxDOT -----------------------------------------------------------------

const TEXAS_BOX = [-107.0, 25.5, -93.4, 36.7];

/** The 25 TxDOT district codes the ITS catalogue accepts. */
export const TXDOT_DISTRICTS = Object.freeze(
  (
    'ABL AMA ATL AUS BMT BWD BRY CHS CRP DAL ELP FTW HOU ' +
    'LRD LBB LFK ODA PAR PHR SJT SAT TYL WAC WFS YKM'
  ).split(' '),
);

/** Ground priors (m) for the districts the registry fetches; TxDOT reports none. */
const TXDOT_GROUND_M = { AUS: 149, SAT: 198, HOU: 15, DAL: 131, FTW: 199 };

const base64url = (s) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

/**
 * TxDOT ITS, one district: { roadwayCctvStatuses: { <roadway>: [{ icd_Id, name,
 * latitude, longitude, statusDescription, hasSnapshot }] } }. Only "Device
 * Online": an offline device keeps serving a frame that can be years old.
 * The snapshot endpoint answers JSON wrapping a base64 JPEG, so the still is
 * marked format 'json-base64-jpeg' (decoded by format.js, shown via a Blob URL).
 */
function parseTxdot(payload, src) {
  const byRoadway = payload?.roadwayCctvStatuses;
  if (!byRoadway || typeof byRoadway !== 'object') return [];
  const code = String(src.params?.districtCode ?? '').toUpperCase();
  if (!TXDOT_DISTRICTS.includes(code)) return [];
  const out = [];
  const seen = new Set();
  for (const rows of Object.values(byRoadway)) {
    for (const row of list(rows)) {
      if (row?.statusDescription !== 'Device Online' || row?.hasSnapshot === false)
        continue;
      // Numbers only: Number(null) and Number('') are 0 (null island).
      const lat = typeof row.latitude === 'number' ? num(row.latitude) : null;
      const lon = typeof row.longitude === 'number' ? num(row.longitude) : null;
      if (!within(lat, lon, TEXAS_BOX)) continue;
      // The device key the snapshot endpoint takes; an interchange camera is
      // listed under both of its roadways.
      const icdId = String(row.icd_Id ?? '').trim();
      if (!/^[\x20-\x7e]{1,100}$/.test(icdId) || seen.has(icdId)) continue;
      seen.add(icdId);
      const name = text(row.name) || icdId;
      out.push({
        // The key itself, base64url-encoded: distinct keys never collide.
        id: `txdot-${code.toLowerCase()}-${base64url(icdId)}`,
        name,
        lat,
        lon,
        direction: null,
        // Only explicit travel tokens in the name ("US-290 EB"): Texas route
        // names are full of bare cardinals ("N Lamar"), and dirDescription is
        // the roadway's direction, not the camera's.
        headingDeg: directionToHeading(name, false),
        groundM: TXDOT_GROUND_M[code] ?? 150,
        // Highway poles and mast arms run tall.
        mountM: { known: 12, unknown: 10 },
        image: {
          feedId: 'txdot-img',
          path: '/GetCctvSnapshotByIcdId',
          params: { icdId, districtCode: code },
          format: 'json-base64-jpeg',
        },
      });
    }
  }
  return out;
}

// --- City of Austin (Socrata rows.json) ------------------------------------

const AUSTIN_BOX = [-98.12, 30.02, -97.4, 30.58];

const normalizeKey = (s) =>
  String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

/** A Socrata row array -> a record keyed by snake_case column names. */
function rowToRecord(row, columns) {
  const rec = {};
  columns.forEach((col, i) => {
    const key = normalizeKey(col?.fieldName || col?.name || `col_${i}`);
    if (key) rec[key] = row[i];
  });
  return rec;
}

/** WKT "POINT (lon lat)", GeoJSON-like { coordinates }, or { latitude, longitude }. */
function coerceLatLon(v) {
  if (typeof v === 'string') {
    const m = /POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)/i.exec(v);
    return m ? { lat: num(m[2]), lon: num(m[1]) } : { lat: null, lon: null };
  }
  if (!v || typeof v !== 'object') return { lat: null, lon: null };
  if (Array.isArray(v.coordinates))
    return { lat: num(v.coordinates[1]), lon: num(v.coordinates[0]) };
  return {
    lat: num(v.latitude ?? v.lat ?? v.y),
    lon: num(v.longitude ?? v.lon ?? v.lng ?? v.x),
  };
}

function austinCoords(r) {
  for (const c of [r.location, r.coordinates, r.the_geom, r.point, r.geocoded_column]) {
    const p = coerceLatLon(c);
    if (p.lat !== null && p.lon !== null) return p;
  }
  return {
    lat: num(r.latitude ?? r.lat ?? r.camera_latitude ?? r.location_latitude),
    lon: num(r.longitude ?? r.lon ?? r.lng ?? r.camera_longitude ?? r.location_longitude),
  };
}

function austinCameraId(r) {
  const preferred = [
    'camera_id',
    'cameraid',
    'cam_id',
    'device_id',
    'intersection_id',
    'id',
  ];
  const keys = [
    ...preferred,
    ...Object.keys(r).filter((k) => /camera|cam|device/.test(k) && /id/.test(k)),
  ];
  for (const k of keys) {
    const t = String(r[k] ?? '').trim();
    if (/^\d{1,7}$/.test(t)) return t;
  }
  return null;
}

const AUSTIN_NAME_KEYS = [
  'camera_name',
  'location_name',
  'intersection_name',
  'location',
  'cross_street',
  'description',
  'name',
];

function austinHeading(r) {
  const direct = num(r.heading_deg ?? r.heading ?? r.bearing);
  if (direct !== null) return direct; // posePrior() wraps it into [0, 360)
  // Dedicated direction fields: a bare "West" is a real facing.
  for (const k of ['direction', 'travel_direction', 'facing', 'facing_direction']) {
    const h = directionToHeading(r[k], true);
    if (h !== null) return h;
  }
  // Free-form names: only explicit travel forms ("WB"); "WEST AVE" is a street.
  return directionToHeading(
    AUSTIN_NAME_KEYS.map((k) => (typeof r[k] === 'string' ? r[k] : ''))
      .filter(Boolean)
      .join(' '),
  );
}

/** Austin: Socrata rows.json { meta.view.columns, data: [[...]] }, TURNED_ON only. */
function parseAustin(payload) {
  const columns = list(payload?.meta?.view?.columns);
  if (!columns.length) return [];
  const out = [];
  const seen = new Set();
  for (const row of list(payload?.data)) {
    if (!Array.isArray(row)) continue;
    const r = rowToRecord(row, columns);
    const id = austinCameraId(r);
    if (!id || seen.has(id)) continue;
    // DESIRED, REMOVED and VOID rows never serve a frame. A missing column
    // keeps the row, so a schema change fails open.
    const status = String(r.camera_status ?? '')
      .trim()
      .toUpperCase();
    if (status && status !== 'TURNED_ON') continue;
    const { lat, lon } = austinCoords(r);
    if (!within(lat, lon, AUSTIN_BOX)) continue;
    seen.add(id);
    const name = AUSTIN_NAME_KEYS.map((k) => text(r[k], 160)).find(Boolean);
    out.push({
      id: `austin-${id}`,
      name: name || `Austin camera ${id}`,
      lat,
      lon,
      direction: null,
      headingDeg: austinHeading(r),
      groundM: 150,
      image: { feedId: 'austin-img', path: `/${id}.jpg` },
    });
  }
  return out;
}

// --- Tarktee (Estonia, DATEX II XML) ---------------------------------------

const ESTONIA_BOX = [21.5, 57.4, 28.4, 59.9];
const MAX_XML_CHARS = 16 * 1024 * 1024;

/**
 * Plain regex reading, so no XML parser ever expands anything: a document that
 * declares a DOCTYPE or an ENTITY (the only routes to entity expansion and
 * external fetches) is refused outright, as is anything oversized.
 */
const safeXml = (xml) =>
  typeof xml === 'string' &&
  xml.length <= MAX_XML_CHARS &&
  !/<!(DOCTYPE|ENTITY)/i.test(xml)
    ? xml
    : null;

/** DATEX II roadCameraLocations -> Map(location id -> { name, lat, lon }). */
export function parseTarkteeLocations(xml) {
  const out = new Map();
  const doc = safeXml(xml);
  if (!doc) return out;
  const block =
    /<predefinedLocation\s+id="([^"]{1,80})"[^>]*>([\s\S]*?)<\/predefinedLocation>/g;
  for (const [, id, body] of doc.matchAll(block)) {
    // The container element has no coordinates of its own and is skipped here.
    const lat = num(/<latitude>\s*(-?\d+(?:\.\d+)?)\s*<\/latitude>/.exec(body)?.[1]);
    const lon = num(/<longitude>\s*(-?\d+(?:\.\d+)?)\s*<\/longitude>/.exec(body)?.[1]);
    if (lat === null || lon === null) continue;
    const name = /<value\b[^>]*>\s*([^<]+?)\s*<\/value>/.exec(body)?.[1];
    out.set(id, { name: text(name ? decodeEntities(name) : '', 120) || id, lat, lon });
  }
  return out;
}

/**
 * DATEX II roadCameraImages -> Map(location id -> still path on the official
 * host, e.g. "/42/42_202608251542.jpg"). Only https://tarktee.transpordiamet.ee/images/ URLs.
 */
export function parseTarkteeImages(xml) {
  const out = new Map();
  const doc = safeXml(xml);
  if (!doc) return out;
  for (const [, body] of doc.matchAll(/<trafficView\b[^>]*>([\s\S]*?)<\/trafficView>/g)) {
    const ref = /<\w*PredefinedLocationReference\b[^>]*\bid="([^"]{1,80})"/i.exec(
      body,
    )?.[1];
    const link = /<urlLinkAddress>\s*([^<\s]+)\s*<\/urlLinkAddress>/.exec(body)?.[1];
    if (!ref || !link) continue;
    const u = url(decodeEntities(link));
    if (!u || u.origin !== 'https://tarktee.transpordiamet.ee') continue;
    const m = /^\/images(\/\d{1,6}\/[A-Za-z0-9_-]{1,64}\.jpe?g)$/.exec(u.pathname);
    if (m) out.set(ref, m[1]);
  }
  return out;
}

/** Tarktee: the two DATEX II documents joined on the location id. */
function parseTarktee(payload) {
  const locations = parseTarkteeLocations(payload?.locations);
  const images = parseTarkteeImages(payload?.images);
  const out = [];
  const seen = new Set();
  for (const [locId, loc] of locations) {
    const path = images.get(locId);
    if (!path || !within(loc.lat, loc.lon, ESTONIA_BOX)) continue;
    const n = /^\/(\d+)\//.exec(path)[1];
    if (seen.has(n)) continue;
    seen.add(n);
    out.push({
      id: `ee-tarktee-${n}`,
      name: loc.name,
      lat: loc.lat,
      lon: loc.lon,
      direction: null,
      groundM: 40,
      // The file name rotates with every capture; the 15-minute catalogue
      // refresh keeps it current.
      image: { feedId: 'tarktee-img', path },
    });
  }
  return out;
}

// --- Curated catalogues (Tallinn, Warendorf) -------------------------------

const TALLINN_BOX = [24.3, 59.2, 25.4, 59.7];

/** Tallinn: rows of data/tallinn.js, [id, name, lat, lon, headingDeg|null, confidence]. */
function parseTallinn(rows) {
  const out = [];
  for (const row of list(rows)) {
    const [id, name, lat, lon, heading, confidence] = Array.isArray(row) ? row : [];
    const m = /^tln-(\d{3})$/.exec(String(id));
    if (!m || !within(num(lat), num(lon), TALLINN_BOX)) continue;
    out.push({
      id: `tallinn-${m[1]}`,
      name: text(name) || `Tallinn camera ${m[1]}`,
      lat: num(lat),
      lon: num(lon),
      direction: null,
      headingDeg: num(heading),
      confidence: confidence === 'low' ? 'low' : 'high',
      curated: true,
      groundM: 15,
      image: { feedId: 'tallinn-img', path: `/cam${m[1]}.jpg` },
    });
  }
  return out;
}

/** Warendorf: data/warendorf.js, one camera with a measured pose. */
function parseWarendorf(rows) {
  const out = [];
  for (const c of list(rows)) {
    if (!/^warendorf-[a-z-]{1,40}$/.test(String(c?.id))) continue;
    if (c.path !== '/jpeg.cgi' || !located(num(c.lat), num(c.lon))) continue;
    out.push({
      id: c.id,
      name: text(c.name) || c.id,
      lat: num(c.lat),
      lon: num(c.lon),
      direction: null,
      headingDeg: num(c.headingDeg),
      confidence: c.headingConfidence === 'low' ? 'low' : 'high',
      curated: true,
      groundM: num(c.groundM),
      overrides: {
        pitch: c.pitch,
        fovDeg: c.fovDeg,
        rangeM: c.rangeM,
        heightM: c.heightM,
      },
      image: { feedId: 'warendorf-img', path: c.path },
    });
  }
  return out;
}

const PARSERS = {
  caltrans: parseCaltrans,
  tfl: parseTfl,
  vegvesen: parseVegvesen,
  ontario511: parseOntario,
  drivebc: parseDriveBc,
  calgary: parseCalgary,
  fintraffic: parseFintraffic,
  txdot: parseTxdot,
  austin: parseAustin,
  tarktee: parseTarktee,
  tallinn: parseTallinn,
  warendorf: parseWarendorf,
};

/** One catalogue payload -> camera records, each tagged with its network and pose prior. */
export function parseCameraCatalog(payload, src) {
  const parse = PARSERS[src.kind];
  if (!parse) return [];
  return parse(payload, src).map(
    ({ headingDeg = null, confidence, curated, groundM, mountM, overrides, ...c }) => ({
      ...c,
      provider: src.provider,
      region: c.region || src.region,
      license: src.license,
      licenseUrl: src.licenseUrl ?? null,
      credit: c.credit ?? null,
      curated: Boolean(curated),
      pose: posePrior({
        id: c.id,
        headingDeg,
        confidence,
        curated,
        groundM,
        mountM,
        overrides,
      }),
    }),
  );
}
