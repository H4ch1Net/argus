// View cones for mapped cameras and ALPR readers, pure: no Cesium, no DOM, so
// the terminal can read the same directions. GUARDRAIL: a cone is the area a
// camera is MAPPED as facing (OSM tags), drawn so you can see which side of a
// road it watches. Nothing here reads, or could read, what a camera sees.
//
// OSM tags read, first present wins: `camera:direction`, `direction`,
// `surveillance:direction`. A value is degrees clockwise from north ("90",
// "-45"), a 16-point compass letter ("NE", "SSW"), a clockwise range
// ("45-90", "NE-SE": the cone spans it), or several of those separated by ";"
// (one cone each). `camera:angle` in OSM is the camera's TILT from the
// horizontal, not its field of view, so it is shown on the card and never used
// for the cone width; the width comes from a range when one is tagged, else a
// default (ALPR readers cover a few lanes: narrower and shorter).

export const COMPASS16 = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
];

export const CONE_DEFAULTS = Object.freeze({
  alpr: { fovDeg: 60, rangeM: 60 },
  camera: { fovDeg: 70, rangeM: 80 },
});

/** Cones are hidden above this camera height (metres). */
export const CONE_MAX_HEIGHT_M = 25_000;

/** At most this many cones (and rings) are drawn per layer. */
export const CONE_CAP = 3000;

const DIRECTION_KEYS = ['camera:direction', 'direction', 'surveillance:direction'];
const MAX_VALUES = 8; // "90;180;270;..." beyond this is noise
const R_EARTH = 6378137;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

const norm360 = (d) => ((d % 360) + 360) % 360;

/** One bearing token: degrees or a 16-point compass letter; null otherwise. */
export function parseBearing(token) {
  const t = String(token ?? '')
    .trim()
    .toUpperCase();
  if (!t || t.length > 12) return null;
  if (/^[-+]?\d{1,3}(?:\.\d+)?$/.test(t)) {
    const n = Number(t);
    return Number.isFinite(n) && Math.abs(n) <= 720 ? norm360(n) : null;
  }
  const i = COMPASS16.indexOf(t);
  return i >= 0 ? i * 22.5 : null;
}

/**
 * A direction tag value -> [{ headingDeg, fovDeg|null }]. A range gives its
 * own width (clockwise from the first bearing to the second); a single bearing
 * leaves the width to the default. Unreadable parts are skipped.
 */
export function parseDirections(value) {
  if (value == null) return [];
  const out = [];
  for (const raw of String(value).split(';').slice(0, MAX_VALUES)) {
    const part = raw.trim();
    if (!part) continue;
    const single = parseBearing(part);
    if (single !== null) {
      out.push({ headingDeg: single, fovDeg: null });
      continue;
    }
    // A range "a-b" (a may itself be negative: "-30-30").
    const m = /^([-+]?\d{1,3}(?:\.\d+)?|[A-Za-z]{1,3})\s*-\s*(\d{1,3}(?:\.\d+)?|[A-Za-z]{1,3})$/.exec(
      part,
    );
    if (!m) continue;
    const a = parseBearing(m[1]);
    const b = parseBearing(m[2]);
    if (a === null || b === null) continue;
    const span = norm360(b - a);
    if (span === 0) continue; // a zero-width "range" says nothing
    out.push({ headingDeg: norm360(a + span / 2), fovDeg: Math.min(span, 359) });
  }
  return out;
}

/** True for ALPR / ANPR readers (same test as the layer's styling). */
export function isAlprTags(tags) {
  const t = String(tags?.['surveillance:type'] || '').toLowerCase();
  return t.includes('alpr') || t.includes('anpr');
}

/** The raw direction value a camera is mapped with, or null. */
export function directionTag(tags) {
  for (const k of DIRECTION_KEYS) {
    const v = tags?.[k];
    if (v != null && String(v).trim() !== '') return String(v).slice(0, 80);
  }
  return null;
}

/**
 * The cones a normalized surveillance entity gets:
 * { alpr, lon, lat, rangeM, cones: [{ headingDeg, fovDeg }], ring }.
 * `ring` is true when no direction is mapped (drawn as a faint full circle).
 * Returns null without a usable position.
 */
export function cameraCones(n) {
  const lon = n?.position?.longitude;
  const lat = n?.position?.latitude;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const tags = n.meta?.tags || {};
  const alpr = isAlprTags(tags);
  const d = alpr ? CONE_DEFAULTS.alpr : CONE_DEFAULTS.camera;
  const cones = parseDirections(directionTag(tags)).map((c) => ({
    headingDeg: c.headingDeg,
    fovDeg: c.fovDeg ?? d.fovDeg,
  }));
  return { alpr, lon, lat, rangeM: d.rangeM, cones, ring: cones.length === 0 };
}

/**
 * A view cone as a flat [lon, lat, lon, lat, ...] ring (open: the last point
 * is not repeated): the camera, then the far arc from left to right edge.
 * Local flat-earth offsets, exact enough at a few hundred metres.
 */
export function sectorDegrees(lon, lat, headingDeg, fovDeg, rangeM, segments) {
  const cosLat = Math.max(0.01, Math.cos(lat * D2R));
  const fov = Math.max(1, Math.min(359, fovDeg));
  const n = segments ?? Math.max(3, Math.ceil(fov / 8));
  const out = [lon, lat];
  const start = headingDeg - fov / 2;
  for (let i = 0; i <= n; i += 1) {
    const b = (start + (fov * i) / n) * D2R;
    out.push(
      lon + ((Math.sin(b) * rangeM) / (R_EARTH * cosLat)) * R2D,
      lat + ((Math.cos(b) * rangeM) / R_EARTH) * R2D,
    );
  }
  return out;
}

/** A full circle of radius rangeM as a flat, open [lon, lat, ...] ring. */
export function circleDegrees(lon, lat, rangeM, segments = 24) {
  const cosLat = Math.max(0.01, Math.cos(lat * D2R));
  const out = [];
  for (let i = 0; i < segments; i += 1) {
    const b = ((360 * i) / segments) * D2R;
    out.push(
      lon + ((Math.sin(b) * rangeM) / (R_EARTH * cosLat)) * R2D,
      lat + ((Math.cos(b) * rangeM) / R_EARTH) * R2D,
    );
  }
  return out;
}

/**
 * How much to enlarge cones at a camera height, in coarse bands so the batch
 * is rebuilt only when a band changes (never per frame). 0 means hidden.
 */
export function coneScale(heightM) {
  if (!Number.isFinite(heightM)) return 1;
  if (heightM > CONE_MAX_HEIGHT_M) return 0;
  if (heightM <= 3000) return 1;
  if (heightM <= 6000) return 1.5;
  if (heightM <= 12_000) return 2.5;
  return 4;
}

/** "090 E" for a bearing. */
export function bearingLabel(deg) {
  const d = Math.round(norm360(deg)) % 360;
  return `${String(d).padStart(3, '0')} ${COMPASS16[Math.round(d / 22.5) % 16]}`;
}

/**
 * The card line for a camera's mapped facing: "Faces 090 E, 60 deg view";
 * several cones of one width share it ("Faces 090 E, 270 W, 60 deg view").
 */
export function describeFacing(spec) {
  if (!spec || spec.ring || !spec.cones.length) return 'Not mapped (drawn as a ring)';
  const widths = new Set(spec.cones.map((c) => Math.round(c.fovDeg)));
  if (widths.size === 1) {
    const list = spec.cones.map((c) => bearingLabel(c.headingDeg)).join(', ');
    return `Faces ${list}, ${[...widths][0]} deg view`;
  }
  return `Faces ${spec.cones
    .map((c) => `${bearingLabel(c.headingDeg)} (${Math.round(c.fovDeg)} deg)`)
    .join(', ')}`;
}
