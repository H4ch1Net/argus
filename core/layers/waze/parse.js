// Waze alerts and jams, pure: the query builders (shared with the proxy's pins
// in proxy/feeds/traffic.js) and the normalizer. No Cesium, no DOM: the
// terminal uses it too.
//
// Two ways in, both through the proxy:
// - 'waze': the endpoint Waze's public live map (waze.com/live-map) draws from,
//   GET /live-map/api/georss?top&bottom&left&right&env&types. Unofficial: not a
//   documented API and outside Waze's terms for automated use; added for the
//   owner's personal, educational use, off by default. Argus names itself (it
//   never poses as a browser), and Waze may refuse that: it answered 403 from a
//   cloud host in Oct 2026. Not live-tested here.
// - 'waze-local': the companion waze-server that Waze scripts such as
//   JMoore335/waze_traffic_api run on your own machine (Nimrod007/waze-api),
//   GET /waze/traffic-notifications?latBottom&latTop&lonLeft&lonRight, set with
//   LOCAL_WAZE_URL (this machine or the LAN only).
//
// Guardrails: only alerts and jams are ever asked for, never "users" (the live
// map can also return nearby Wazers' positions); police reports are dropped
// (locating officers is tracking people, the one thing that script logs);
// reporter names, free-text descriptions and comments are never read; nothing
// is archived (the layer shows road conditions now, no history).

export const WAZE_FEED = 'waze';
export const WAZE_PATH = '/live-map/api/georss';
export const WAZE_LOCAL_FEED = 'waze-local';
export const WAZE_LOCAL_PATH = '/waze/traffic-notifications';
export const WAZE_TYPES = 'alerts,traffic';

const SNAP = 0.01; // degrees: nearby views share one cached answer
const MAX_SPAN = 1.0; // degrees: larger views ask for the square around the centre
const MAX_PATH = 200; // vertices kept per jam

const round = (v, d = 5) => Math.round(v * 10 ** d) / 10 ** d;
const clampLon = (v) => Math.max(-180, Math.min(180, v));
const clampLat = (v) => Math.max(-85, Math.min(85, v));

/** Waze's server region for a point: Israel, North America (the Americas), or the rest. */
export function wazeEnv(lat, lon) {
  if (lat > 29 && lat < 33.6 && lon > 34 && lon < 36) return 'il';
  return lon < -25 ? 'na' : 'row';
}

/**
 * The box to ask for: the view snapped outward to a 0.01 degree grid, or the
 * 1 degree square around its centre when the view is larger (`clipped`). Null
 * without a usable view.
 */
export function wazeBox(bbox) {
  if (!bbox) return null;
  let { lomin, lamin, lomax, lamax } = bbox;
  if (![lomin, lamin, lomax, lamax].every(Number.isFinite)) return null;
  if (lomax < lomin) lomax += 360; // across the antimeridian
  let clipped = false;
  if (lomax - lomin > MAX_SPAN || lamax - lamin > MAX_SPAN) {
    const cLat = (lamin + lamax) / 2;
    let cLon = (lomin + lomax) / 2;
    if (cLon > 180) cLon -= 360;
    ({ lomin, lomax, lamin, lamax } = {
      lomin: cLon - MAX_SPAN / 2,
      lomax: cLon + MAX_SPAN / 2,
      lamin: cLat - MAX_SPAN / 2,
      lamax: cLat + MAX_SPAN / 2,
    });
    clipped = true;
  }
  // The epsilon keeps an edge already on the grid there (2.3 / 0.01 is 229.99...).
  const down = (v) => round(Math.floor(v / SNAP + 1e-6) * SNAP, 2);
  const up = (v) => round(Math.ceil(v / SNAP - 1e-6) * SNAP, 2);
  const b = {
    lomin: clampLon(down(lomin)),
    lamin: clampLat(down(lamin)),
    lomax: clampLon(up(lomax)),
    lamax: clampLat(up(lamax)),
  };
  if (b.lomax <= b.lomin || b.lamax <= b.lamin) return null;
  return { ...b, clipped };
}

const fixed = (v) => v.toFixed(2);

/** Query params for the proxy's 'waze' feed (the live map's georss endpoint). */
export function wazeQuery(bbox) {
  const b = wazeBox(bbox);
  if (!b) return null;
  return {
    top: fixed(b.lamax),
    bottom: fixed(b.lamin),
    left: fixed(b.lomin),
    right: fixed(b.lomax),
    env: wazeEnv((b.lamin + b.lamax) / 2, (b.lomin + b.lomax) / 2),
    types: WAZE_TYPES,
  };
}

/** Query params for the proxy's 'waze-local' feed (your own waze-server). */
export function wazeLocalQuery(bbox) {
  const b = wazeBox(bbox);
  if (!b) return null;
  return {
    latBottom: fixed(b.lamin),
    latTop: fixed(b.lamax),
    lonLeft: fixed(b.lomin),
    lonRight: fixed(b.lomax),
  };
}

// Alert subtypes worth their own wording; the rest are derived from the code.
const SUBTYPE_LABELS = {
  ACCIDENT_MINOR: 'Minor accident',
  ACCIDENT_MAJOR: 'Major accident',
  JAM_LIGHT_TRAFFIC: 'Light traffic',
  JAM_MODERATE_TRAFFIC: 'Moderate traffic',
  JAM_HEAVY_TRAFFIC: 'Heavy traffic',
  JAM_STAND_STILL_TRAFFIC: 'Standstill traffic',
  HAZARD_ON_ROAD_POT_HOLE: 'Pothole',
  HAZARD_ON_ROAD_OBJECT: 'Object on road',
  HAZARD_ON_ROAD_CAR_STOPPED: 'Stopped vehicle',
  HAZARD_ON_SHOULDER_CAR_STOPPED: 'Stopped vehicle on shoulder',
  HAZARD_ON_ROAD_CONSTRUCTION: 'Construction',
  HAZARD_ON_ROAD_ROAD_KILL: 'Roadkill',
  HAZARD_ON_ROAD_TRAFFIC_LIGHT_FAULT: 'Traffic light out',
  HAZARD_ON_ROAD_LANE_CLOSED: 'Lane closed',
  HAZARD_ON_ROAD_ICE: 'Ice on road',
  HAZARD_ON_ROAD_EMERGENCY_VEHICLE: 'Emergency vehicle',
  HAZARD_ON_SHOULDER_ANIMALS: 'Animals on shoulder',
  HAZARD_ON_SHOULDER_MISSING_SIGN: 'Missing sign',
  ROAD_CLOSED_HAZARD: 'Road closed (hazard)',
  ROAD_CLOSED_CONSTRUCTION: 'Road closed (construction)',
  ROAD_CLOSED_EVENT: 'Road closed (event)',
};
const TYPE_LABELS = {
  ACCIDENT: 'Accident',
  JAM: 'Traffic jam',
  HAZARD: 'Hazard',
  WEATHERHAZARD: 'Hazard',
  ROAD_CLOSED: 'Road closed',
  CONSTRUCTION: 'Construction',
};
const WEATHER =
  /FOG|HAIL|FLOOD|SNOW|HEAVY_RAIN|FREEZING_RAIN|MONSOON|TORNADO|HEAT_WAVE|HURRICANE|WEATHER/;

/** Readable label for an alert type and subtype. */
export function wazeLabel(type, subtype) {
  if (subtype && SUBTYPE_LABELS[subtype]) return SUBTYPE_LABELS[subtype];
  if (subtype) {
    const words = subtype
      .replace(/^(HAZARD_ON_ROAD_|HAZARD_ON_SHOULDER_|HAZARD_WEATHER_|HAZARD_)/, '')
      .toLowerCase()
      .replace(/_/g, ' ')
      .trim();
    if (words) return words[0].toUpperCase() + words.slice(1);
  }
  return TYPE_LABELS[type] ?? 'Report';
}

/**
 * Kind (one of the road incident kinds) for an alert. Null for what the layer
 * never shows: police reports and chatter.
 */
export function wazeKind(type, subtype = '') {
  if (type === 'POLICE' || /^POLICE/.test(subtype)) return null;
  if (type === 'CHIT_CHAT' || type === 'MISC') return null;
  if (type === 'ACCIDENT') return 'accident';
  if (type === 'JAM') return 'jam';
  if (type === 'ROAD_CLOSED') return 'closure';
  if (type === 'CONSTRUCTION' || /CONSTRUCTION/.test(subtype)) return 'roadworks';
  if (/LANE_CLOSED/.test(subtype)) return 'closure';
  if (WEATHER.test(subtype)) return 'weather';
  return 'hazard';
}

function alertSeverity(kind, subtype) {
  if (kind === 'closure' || subtype === 'ACCIDENT_MAJOR') return 'critical';
  if (subtype === 'JAM_STAND_STILL_TRAFFIC') return 'critical';
  if (kind === 'accident' || subtype === 'JAM_HEAVY_TRAFFIC') return 'notable';
  return 'minor';
}

export const JAM_LEVELS = [
  'Free flow',
  'Light',
  'Moderate',
  'Heavy',
  'Very heavy',
  'Standstill',
];

function jamSeverity(level, blocked) {
  if (blocked || level >= 5) return 'critical';
  if (level >= 3) return 'notable';
  return 'minor';
}

const num = (v) =>
  Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null;
// A short display string: control characters become spaces.
const text = (v, max = 80) =>
  typeof v === 'string'
    ? Array.from(v, (c) => (c.charCodeAt(0) < 32 || c === '\x7f' ? ' ' : c))
        .join('')
        .trim()
        .slice(0, max)
    : '';

/** A point as { lat, lon } from either shape ({ x, y } or latitude / longitude). */
function pointOf(p) {
  if (!p || typeof p !== 'object') return null;
  const lon = num(p.x ?? p.longitude ?? p.lon ?? p.lng);
  const lat = num(p.y ?? p.latitude ?? p.lat);
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180)
    return null;
  return { lat, lon };
}

/**
 * Normalize a Waze answer (the live map's georss JSON, a waze-server answer, or
 * a Waze for Cities feed: the same alerts / jams shapes) into Layer SDK
 * records. Reads only what the cards show; `users` and reporter fields are
 * ignored.
 */
export function parseWaze(json) {
  const out = [];
  const seen = new Set();
  for (const a of Array.isArray(json?.alerts) ? json.alerts : []) {
    const at = pointOf(a?.location) ?? pointOf(a);
    if (!at) continue;
    const type = String(a.type ?? '').toUpperCase();
    const subtype = String(a.subtype ?? a.subType ?? '').toUpperCase();
    const kind = wazeKind(type, subtype);
    if (!kind) continue;
    const key = String(a.uuid ?? a.id ?? `${type}:${round(at.lat)},${round(at.lon)}`);
    const id = `waze/a/${key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      type: 'waze-alert',
      position: { longitude: at.lon, latitude: at.lat, altitude: 0 },
      meta: {
        source: 'waze',
        kind,
        severity: alertSeverity(kind, subtype),
        type,
        subtype,
        label: wazeLabel(type, subtype),
        street: text(a.street),
        city: text(a.city),
        reliability: num(a.reliability),
        confidence: num(a.confidence),
        thumbs: num(a.nThumbsUp ?? a.numOfThumbsUp),
        pubMs: num(a.pubMillis),
      },
    });
  }
  for (const j of Array.isArray(json?.jams) ? json.jams : []) {
    const line = Array.isArray(j?.line) ? j.line.map(pointOf).filter(Boolean) : [];
    if (!line.length) continue;
    const step = Math.max(1, Math.ceil(line.length / MAX_PATH));
    const path = line.filter((_, i) => i % step === 0 || i === line.length - 1);
    const mid = line[Math.floor(line.length / 2)];
    const level = Math.max(0, Math.min(5, num(j.level) ?? 0));
    const delay = num(j.delay);
    const blocked = delay === -1 || String(j.blockingAlertType ?? '') === 'ROAD_CLOSED';
    const key = String(j.uuid ?? j.id ?? `${round(mid.lat)},${round(mid.lon)}`);
    const id = `waze/j/${key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const kmh = num(j.speedKMH) ?? (num(j.speed) !== null ? num(j.speed) * 3.6 : null);
    out.push({
      id,
      type: 'waze-jam',
      position: { longitude: mid.lon, latitude: mid.lat, altitude: 0 },
      meta: {
        source: 'waze',
        kind: blocked ? 'closure' : 'jam',
        severity: jamSeverity(level, blocked),
        level,
        label: blocked ? 'Road blocked' : `${JAM_LEVELS[level]} traffic`,
        street: text(j.street),
        city: text(j.city),
        speedKmh: kmh !== null ? Math.round(kmh) : null,
        delayS: delay !== null && delay >= 0 ? delay : null,
        lengthM: num(j.length),
        blocked,
        path: path.map((p) => [p.lon, p.lat]),
        pubMs: num(j.pubMillis),
      },
    });
  }
  return out;
}
