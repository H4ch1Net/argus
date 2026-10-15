// Pure helpers for the car shell: no Cesium, no DOM, so they are unit tested
// (model.test.js) and the shell keeps only wiring. Angles in degrees
// clockwise from north, distances in metres, speeds in metres per second.

const R_EARTH = 6_371_008.8;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, k) => a + (b - a) * k;

/** Normalize to [0, 360). */
export const wrap360 = (d) => ((d % 360) + 360) % 360;

/** The signed shortest turn from a to b, in (-180, 180]. */
export function angleDelta(a, b) {
  const d = wrap360(b - a);
  return d > 180 ? d - 360 : d;
}

/** Great-circle distance (haversine). */
export function distanceM(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing from point 1 to point 2. */
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const p1 = rad(lat1);
  const p2 = rad(lat2);
  const dl = rad(lon2 - lon1);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return wrap360(deg(Math.atan2(y, x)));
}

/** The point `distance` metres from (lat, lon) along `bearing`. */
export function destination(lat, lon, bearing, distance) {
  const d = distance / R_EARTH;
  const b = rad(bearing);
  const p1 = rad(lat);
  const l1 = rad(lon);
  const p2 = Math.asin(
    Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b),
  );
  const l2 =
    l1 +
    Math.atan2(
      Math.sin(b) * Math.sin(d) * Math.cos(p1),
      Math.cos(d) - Math.sin(p1) * Math.sin(p2),
    );
  return { lat: deg(p2), lon: wrap360(deg(l2) + 180) - 180 };
}

// The follow view: tilted 45 degrees, 1.8 km up at a standstill rising to
// 6.5 km at motorway speed (the automatic zoom), the vehicle in the middle of
// the free part of the screen. Close enough that streets and the cameras on
// them read at a glance; the driver's zoom (the car's +/- buttons) scales it
// until RECENTER.
export const FOLLOW_PITCH_DEG = -45;
const ALT_MIN_M = 1800;
const ALT_MAX_M = 6500;
const SPEED_SLOW = 2; // ~7 km/h: below this the view stays at its closest
const SPEED_FAST = 33; // ~120 km/h: at and above this, the widest view

/** Eye height of the follow view for a speed. */
export function followAltitude(speed) {
  const s = Number.isFinite(speed) ? speed : 0;
  const k = clamp((s - SPEED_SLOW) / (SPEED_FAST - SPEED_SLOW), 0, 1);
  return ALT_MIN_M + (ALT_MAX_M - ALT_MIN_M) * k;
}

/**
 * The follow camera for a vehicle: its heading (north in the north-up view),
 * pitch and the range that puts the eye at followAltitude() above it. `scale`
 * is the driver's zoom. The camera is aimed so the vehicle itself shows in
 * the middle of the free screen (aimFor); nothing looks ahead of it.
 */
export function followPose(
  { lat, lon, heading = 0, speed = 0 },
  { scale = 1, mode = 'auto' } = {},
) {
  const view = VIEW_MODES[viewModeOf(mode)];
  const alt = followAltitude(speed) * clamp(scale, 0.05, 20);
  return {
    lat,
    lon,
    heading: view.headingUp ? wrap360(heading ?? 0) : 0,
    pitch: view.pitch,
    range: alt / Math.sin(rad(-view.pitch)),
  };
}

/**
 * Where to aim the camera (Cesium lookAt: heading, pitch, range from the aim
 * point) so the ground point `at` shows at screen point (x, y) of a width x
 * height view with Cesium's `fov` (radians, the wider axis): the ray through
 * (x, y) is cast onto the ground round the aim point, and the aim point is
 * that far the other way from `at`. Flat ground: exact to a pixel at the few
 * kilometres the car looks from. Null when (x, y) is above the horizon.
 */
export function aimFor(
  at,
  { heading = 0, pitch = FOLLOW_PITCH_DEG, range, fov, width, height, x, y },
) {
  const W = Math.max(1, width);
  const H = Math.max(1, height);
  const aspect = W / H;
  const half = Math.tan((Number.isFinite(fov) && fov > 0 ? fov : Math.PI / 3) / 2);
  const tanX = aspect >= 1 ? half : half * aspect;
  const tanY = aspect >= 1 ? half / aspect : half;
  const h = rad(heading);
  const p = rad(pitch);
  // East, north, up: the camera's forward, right and up axes.
  const fwd = [Math.sin(h) * Math.cos(p), Math.cos(h) * Math.cos(p), Math.sin(p)];
  const right = [Math.cos(h), -Math.sin(h), 0];
  const up = [
    right[1] * fwd[2] - right[2] * fwd[1],
    right[2] * fwd[0] - right[0] * fwd[2],
    right[0] * fwd[1] - right[1] * fwd[0],
  ];
  const nx = (2 * x) / W - 1;
  const ny = 1 - (2 * y) / H;
  const dir = fwd.map((f, i) => f + right[i] * nx * tanX + up[i] * ny * tanY);
  if (!(dir[2] < -1e-9)) return null;
  // The eye sits `range` back along the forward axis from the aim point.
  const eye = fwd.map((f) => -f * range);
  const t = -eye[2] / dir[2];
  const east = eye[0] + t * dir[0];
  const north = eye[1] + t * dir[1];
  const off = Math.hypot(east, north);
  if (off < 0.01) return { lat: at.lat, lon: at.lon };
  return destination(at.lat, at.lon, deg(Math.atan2(east, north)) + 180, off);
}

/**
 * Ground metres per screen pixel across the view at `range` from the camera,
 * for Cesium's `fov` (the wider of the two axes; radians) on a width x height
 * canvas.
 */
export function metresPerPixel(range, fov, width, height) {
  const w = Math.max(1, width);
  const aspect = w / Math.max(1, height);
  const f = Number.isFinite(fov) && fov > 0 ? fov : Math.PI / 3;
  // Cesium's fov spans the wider axis: the horizontal one on a landscape screen.
  const fovx = aspect >= 1 ? f : 2 * Math.atan(Math.tan(f / 2) * aspect);
  return (2 * Math.max(0, range) * Math.tan(fovx / 2)) / w;
}

/**
 * The car's two camera modes, switched by its AUTO / NORTH button: AUTO is
 * heading up and tilted, with the zoom following speed and the next turn;
 * NORTH is flat and north up, zoomed the same way. The older '3d' and '2d'
 * (saved by earlier builds) mean AUTO.
 */
export const VIEW_MODES = {
  auto: { label: 'AUTO', pitch: FOLLOW_PITCH_DEG, headingUp: true },
  north: { label: 'NORTH', pitch: -90, headingUp: false },
};
export const VIEW_ORDER = ['auto', 'north'];
/** A saved or requested mode as one of VIEW_MODES ('auto' for anything else). */
export const viewModeOf = (mode) => (mode === 'north' ? 'north' : 'auto');
/** The mode after `mode` on the AUTO / NORTH button. */
export const nextViewMode = (mode) =>
  VIEW_ORDER[(VIEW_ORDER.indexOf(viewModeOf(mode)) + 1) % VIEW_ORDER.length];

/**
 * A place name for the map label: whole comma parts while they fit in `max`
 * ("46211 JACKSON STREET, INDIO"), else the first part cut at a word with an
 * ellipsis; never a dangling comma.
 */
export function shortPlaceName(name, max = 28) {
  const text = String(name ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  const parts = text.split(/\s*,\s*/).filter(Boolean);
  let out = '';
  for (const part of parts) {
    const next = out ? `${out}, ${part}` : part;
    if (next.length > max) break;
    out = next;
  }
  if (out) return out;
  const cut = parts[0].slice(0, max - 1);
  const word = cut.lastIndexOf(' ');
  return `${(word > max / 2 ? cut.slice(0, word) : cut).trimEnd()}\u2026`;
}

// ------------------------------------------------------------ frame budget
/**
 * The render scale for the car display: at most `budget` rendered pixels, so
 * a wide or dense car screen costs no more than a small one (the car draws on
 * the phone's GPU, beside whatever the phone draws). Between 0.75 and 1.25
 * rendered pixels per CSS pixel; returned as Cesium's resolutionScale, which
 * multiplies devicePixelRatio.
 */
export function carResolutionScale(cssWidth, cssHeight, dpr = 1, budget = 1_100_000) {
  const area = Math.max(1, cssWidth) * Math.max(1, cssHeight);
  const perCss = clamp(Math.sqrt(budget / area), 0.75, 1.25);
  return perCss / (dpr > 0 ? dpr : 1);
}

/** Free look ends on its own after this long without a touch while driving. */
export const RESUME_IDLE_MS = 10_000;
/** Above this speed (about 11 km/h) the vehicle counts as driving off. */
export const RESUME_SPEED_MPS = 3;

/**
 * Whether the map should go back to following the vehicle by itself, as a GPS
 * app does: the driver dragged it away (free look), has not touched it for
 * RESUME_IDLE_MS, and is driving. Never while routes are being previewed
 * (`busy`): that view frames the routes on purpose.
 */
export function shouldResumeFollow({ following, speed, idleMs, busy = false }) {
  if (following || busy) return false;
  return Number.isFinite(speed) && speed > RESUME_SPEED_MPS && idleMs >= RESUME_IDLE_MS;
}

/**
 * Milliseconds between follow-view updates: 20 a second on the move or in a
 * turn, 12 when creeping, where the view hardly changes.
 */
export function followFrameMs(speed, turningDeg = 0) {
  const fast = (Number.isFinite(speed) && speed > 6) || Math.abs(turningDeg) > 2;
  return 1000 / (fast ? 20 : 12);
}

/**
 * Whether a new fix is only GPS wander around a parked (or crawling) vehicle:
 * slow, and within the fix's own accuracy (8 to 25 m) of the last position.
 * The follow view then holds still instead of drifting, which keeps the map
 * from re-rendering and the layers from refetching every second.
 */
export function isParkedJitter(prev, next) {
  if (!prev || !next) return false;
  if (Number.isFinite(next.speed) && next.speed >= 1) return false;
  // A fix without a speed (the network provider's) just after driving: the
  // vehicle is still moving, so it is not held back to the last position.
  if (!Number.isFinite(next.speed) && Number.isFinite(prev.speed) && prev.speed >= 2)
    return false;
  const tolerance = clamp(Number.isFinite(next.accuracy) ? next.accuracy : 10, 8, 25);
  return distanceM(prev.lat, prev.lon, next.lat, next.lon) < tolerance;
}

/**
 * The course to steer the view by: the fix's own heading while it is moving,
 * else the course between the last two fixes when they are far enough apart,
 * else the previous heading (GPS course is noise at a standstill).
 */
export function courseFor(prev, next) {
  const moving = Number.isFinite(next.speed) && next.speed >= 1.5;
  if (moving && Number.isFinite(next.heading)) return wrap360(next.heading);
  if (prev && distanceM(prev.lat, prev.lon, next.lat, next.lon) >= 8)
    return bearingDeg(prev.lat, prev.lon, next.lat, next.lon);
  return prev?.heading ?? 0;
}

/** Speed from two fixes (m/s) when the fix itself has none; t in ms. */
export function speedBetween(prev, next) {
  if (!prev || !(next.t > prev.t)) return 0;
  return distanceM(prev.lat, prev.lon, next.lat, next.lon) / ((next.t - prev.t) / 1000);
}

// ------------------------------------------------------------------ units
const IMPERIAL_REGIONS = new Set(['US', 'GB', 'LR', 'MM']);

/** 'imperial' where road speeds are in mph, else 'metric'. */
export function unitsForLocale(locale) {
  const region = String(locale || '')
    .split(/[-_]/)
    .slice(1)
    .find((p) => /^[A-Za-z]{2}$/.test(p));
  return region && IMPERIAL_REGIONS.has(region.toUpperCase()) ? 'imperial' : 'metric';
}

/** '087 KM/H' or '054 MPH' ('--- KM/H' without a speed). */
export function formatSpeed(mps, units = 'metric') {
  const unit = units === 'imperial' ? 'MPH' : 'KM/H';
  if (!Number.isFinite(mps)) return `--- ${unit}`;
  const v = units === 'imperial' ? mps * 2.236936 : mps * 3.6;
  return `${String(Math.round(Math.max(0, v))).padStart(3, '0')} ${unit}`;
}

/** '850M', '12.4KM', '7.7MI', '400FT'. */
export function formatDistance(m, units = 'metric') {
  if (!Number.isFinite(m)) return '--';
  if (units === 'imperial') {
    const mi = m / 1609.344;
    if (mi < 0.1) return `${Math.round(m * 3.28084)}FT`;
    return mi < 10 ? `${mi.toFixed(1)}MI` : `${Math.round(mi)}MI`;
  }
  if (m < 1000) return `${Math.round(m)}M`;
  return m < 10_000 ? `${(m / 1000).toFixed(1)}KM` : `${Math.round(m / 1000)}KM`;
}

const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const cardinal = (d) => CARDINALS[Math.round(wrap360(d) / 45) % 8];

/** '245 SW' ('--- --' without a heading). */
export function formatHeading(d) {
  if (!Number.isFinite(d)) return '--- --';
  return `${String(Math.round(wrap360(d)) % 360).padStart(3, '0')} ${cardinal(d)}`;
}

// ---------------------------------------------------------------- readout
const CODES = {
  flights: 'FLT',
  military: 'MIL',
  localadsb: 'ADS',
  trafficcams: 'CAM',
  surveillance: 'SRV',
  incidents: 'INC',
  signals: 'SIG',
  chp: 'CHP',
  waze: 'WZE',
  simtraffic: 'SIM',
  borderwaits: 'BDR',
  webcams: 'WEB',
  quakes: 'EQ',
  radar: 'WX',
  ships: 'SHP',
  satellites: 'SAT',
  transit: 'TRN',
};
/** A three-letter tag for a layer key. */
export const layerCode = (key) =>
  CODES[key] ??
  String(key || '?')
    .slice(0, 3)
    .toUpperCase();

/** Half-width of "ahead" around the course, in degrees. */
export const AHEAD_DEG = 60;

/**
 * The contacts nearest to `here`, with range and bearing. Contacts without a
 * position are dropped; with no `here`, the given order is kept (the overlay's
 * own order: nearest the middle of the view). Given the vehicle's `heading`,
 * what lies ahead (within AHEAD_DEG of the course) comes first, nearest
 * first, and what is behind only fills the rows left: a driver acts on what
 * is coming, not on what has been passed.
 * @param {{ lat?: number, lon?: number }[]} contacts
 * @param {{ heading?: number|null }} [opts]
 */
export function nearestContacts(contacts, here, max = 3, { heading = null } = {}) {
  const placed = contacts.filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lon));
  if (!here)
    return placed.slice(0, max).map((c) => ({ ...c, distanceM: null, bearingDeg: null }));
  const ranged = placed.map((c) => {
    const b = bearingDeg(here.lat, here.lon, c.lat, c.lon);
    return {
      ...c,
      distanceM: distanceM(here.lat, here.lon, c.lat, c.lon),
      bearingDeg: b,
      ahead: Number.isFinite(heading)
        ? Math.abs(angleDelta(heading, b)) <= AHEAD_DEG
        : null,
    };
  });
  return ranged
    .sort(
      (a, b) =>
        Number(Boolean(b.ahead)) - Number(Boolean(a.ahead)) || a.distanceM - b.distanceM,
    )
    .slice(0, max);
}

// ----------------------------------------------------------------- layers
/**
 * The car-safe layers: what the car's LAYERS list offers, in its order
 * (android/.../car/MapScreen.kt CarLayers.ALL, kept equal by model.test.js).
 * The car shows the phone's layers within this set, and its toggles change
 * only these in the shared record (core/share/session.js).
 */
export const CAR_LAYER_KEYS = Object.freeze([
  'incidents',
  'chp',
  'waze',
  'simtraffic',
  'trafficcams',
  'surveillance',
  'signals',
  'flights',
  'military',
  'radar',
  'quakes',
]);

/**
 * Which layer rows to press so the enabled set matches `want`. A row that is
 * still loading counts as on (pressing it again would switch it off), and only
 * keys that have a row are touched.
 * @param {{ key: string, on: boolean, loading?: boolean }[]} rows
 * @param {Iterable<string>} want
 * @returns {string[]}
 */
export function planLayerClicks(rows, want) {
  const wanted = new Set(want);
  const out = [];
  for (const { key, on, loading } of rows) {
    if (wanted.has(key) !== Boolean(on || loading)) out.push(key);
  }
  return out;
}
