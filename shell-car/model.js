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
// 6.5 km at motorway speed, so the look-ahead grows with speed. Close enough
// that streets and the cameras on them read at a glance; the driver's zoom
// (the car's +/- buttons) scales it.
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
 * Where the follow camera looks: a point ahead of the vehicle (so the vehicle
 * sits in the lower part of the view, as in a navigation app), with the range
 * that puts the eye at followAltitude() above it. `scale` is the driver's zoom.
 * While navigating, `ahead(metres)` gives the point that far along the route,
 * so the view looks round the next bend instead of straight on.
 */
export function followPose(
  { lat, lon, heading = 0, speed = 0 },
  { scale = 1, mode = '3d', ahead = null } = {},
) {
  const view = VIEW_MODES[mode] ?? VIEW_MODES['3d'];
  const alt = followAltitude(speed) * clamp(scale, 0.05, 20);
  const range = alt / Math.sin(rad(-view.pitch));
  // Look ahead of the vehicle along its course, so it sits low in the view.
  const look = ahead?.(alt * 0.25) ?? destination(lat, lon, heading, alt * 0.25);
  return {
    lat: look.lat,
    lon: look.lon,
    heading: view.headingUp ? wrap360(heading) : 0,
    pitch: view.pitch,
    range,
  };
}

/**
 * Ground metres per screen pixel across the view at `range` from the camera,
 * for Cesium's `fov` (the wider of the two axes; radians) on a width x height
 * canvas. Used to slide the follow view's centre into the part of the screen
 * the host's cards leave free.
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
 * The car's views, cycled by its VIEW button: the tilted 3D view, heading up;
 * a flat 2D view, heading up; and 2D north up. The flat views are also the
 * lightest to draw: no tiles toward a horizon.
 */
export const VIEW_MODES = {
  '3d': { label: '3D', pitch: FOLLOW_PITCH_DEG, headingUp: true },
  '2d': { label: '2D', pitch: -90, headingUp: true },
  north: { label: 'NORTH', pitch: -90, headingUp: false },
};
export const VIEW_ORDER = ['3d', '2d', 'north'];
/** The view after `mode` in the VIEW button's cycle. */
export const nextViewMode = (mode) =>
  VIEW_ORDER[(VIEW_ORDER.indexOf(mode) + 1) % VIEW_ORDER.length];

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
