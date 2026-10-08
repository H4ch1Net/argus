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

// The follow view: tilted 45 degrees, 3 km up at a standstill rising to 8 km
// at motorway speed, so the look-ahead grows with speed.
export const FOLLOW_PITCH_DEG = -45;
const ALT_MIN_M = 3000;
const ALT_MAX_M = 8000;
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
 */
export function followPose({ lat, lon, heading = 0, speed = 0 }, { scale = 1 } = {}) {
  const alt = followAltitude(speed) * clamp(scale, 0.05, 20);
  const range = alt / Math.sin(rad(-FOLLOW_PITCH_DEG));
  const look = destination(lat, lon, heading, alt * 0.25);
  return { lat: look.lat, lon: look.lon, heading: wrap360(heading), pitch: FOLLOW_PITCH_DEG, range };
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
  trafficcams: 'CAM',
  quakes: 'EQ',
  radar: 'WX',
  ships: 'SHP',
  satellites: 'SAT',
  transit: 'TRN',
};
/** A three-letter tag for a layer key. */
export const layerCode = (key) => CODES[key] ?? String(key || '?').slice(0, 3).toUpperCase();

/**
 * The contacts nearest to `here`, with range and bearing. Contacts without a
 * position are dropped; with no `here`, the given order is kept (the overlay's
 * own order: nearest the middle of the view).
 * @param {{ lat?: number, lon?: number }[]} contacts
 */
export function nearestContacts(contacts, here, max = 3) {
  const placed = contacts.filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lon));
  if (!here) return placed.slice(0, max).map((c) => ({ ...c, distanceM: null, bearingDeg: null }));
  return placed
    .map((c) => ({
      ...c,
      distanceM: distanceM(here.lat, here.lon, c.lat, c.lon),
      bearingDeg: bearingDeg(here.lat, here.lon, c.lat, c.lon),
    }))
    .sort((a, b) => a.distanceM - b.distanceM)
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
