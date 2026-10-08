// Intel HUD, the pure half (no Cesium, no DOM): the view band, GSD and NIIRS,
// off-nadir angle, the nearest catalogued place with distance and bearing,
// ECEF to geodetic, and the readout strings. core/ui/intelHud.js reads the
// camera and calls intelReadout(); every number on the HUD is decided here,
// so it is testable under plain node and reusable by any shell.
//
// Adapted from gods-eye-view src/hud.js and src/hudLocality.js (MIT).

import { toMgrs, toDms } from '../geo/mgrs.js';
import { sunElevationDeg } from '../geo/sun.js';
import { greatCircleM, initialBearingDeg } from '../draw/geometry.js';

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const M_PER_INCH = 0.0254;
const DEFAULT_FOVY = 60 * RAD;

/** Beyond this the nearest place is a reference point (REF), not a locality (NEAR). */
export const NEAR_MAX_KM = 150;

// View bands by camera altitude (m): the first whose bound the altitude is under.
export const VIEW_BANDS = Object.freeze([
  [2000, 'STREET'],
  [25000, 'CITY'],
  [120000, 'METRO'],
  [1000000, 'REGIONAL'],
  [Infinity, 'GLOBAL'],
]);

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * View band for a camera altitude in metres.
 * @returns {'STREET'|'CITY'|'METRO'|'REGIONAL'|'GLOBAL'|null}
 */
export function viewBand(altM) {
  if (!finite(altM)) return null;
  for (const [bound, name] of VIEW_BANDS) if (altM < bound) return name;
  return 'GLOBAL';
}

/**
 * Ground sample distance (metres per pixel) at the centre of a perspective
 * view: the ground footprint of the vertical field of view over the canvas
 * height. `rangeM` is the camera's distance to the ground point (the slant
 * range; at nadir, the height above ground).
 * @param {number} rangeM
 * @param {number} [fovyRad] vertical field of view (default 60 degrees)
 * @param {number} heightPx canvas height in CSS pixels
 * @returns {number|null}
 */
export function gsdMetres(rangeM, fovyRad, heightPx) {
  const fovy =
    finite(fovyRad) && fovyRad > 0 && fovyRad < Math.PI ? fovyRad : DEFAULT_FOVY;
  if (!finite(rangeM) || rangeM <= 0 || !finite(heightPx) || heightPx <= 0) return null;
  return (2 * rangeM * Math.tan(fovy / 2)) / heightPx;
}

/**
 * NIIRS from GSD by the simplified GIQE the reference uses:
 * NIIRS = 10.25 - 3.32 log10(GSD in inches), clamped to 0..9.
 * @returns {number|null}
 */
export function niirsFromGsd(gsdM) {
  if (!finite(gsdM) || gsdM <= 0) return null;
  const v = 10.25 - 3.32 * Math.log10(gsdM / M_PER_INCH);
  return Math.max(0, Math.min(9, v));
}

/** Off-nadir angle (degrees, 0..90) from a camera pitch in radians (-90 deg = nadir). */
export function offNadirDeg(pitchRad) {
  if (!finite(pitchRad)) return null;
  return Math.max(0, Math.min(90, 90 + pitchRad * DEG));
}

/** Compass heading in degrees, 0..360, from a camera heading in radians. */
export function headingDeg(headingRad) {
  if (!finite(headingRad)) return null;
  return (((headingRad * DEG) % 360) + 360) % 360;
}

/**
 * Normalise a place list to { name, lat, lon }. Accepts objects with
 * name/lat/lon (or lng) and the CITIES row shape [name, lat, lon, ...].
 * Rows without a name or finite coordinates are dropped.
 */
export function normalizePlaces(places) {
  if (!Array.isArray(places)) return [];
  const out = [];
  for (const p of places) {
    const row = Array.isArray(p)
      ? { name: p[0], lat: p[1], lon: p[2] }
      : { name: p?.name, lat: p?.lat, lon: p?.lon ?? p?.lng };
    if (row.name && finite(row.lat) && finite(row.lon)) {
      out.push({ name: String(row.name), lat: row.lat, lon: row.lon });
    }
  }
  return out;
}

/**
 * Nearest place to a point, with the great-circle distance and the initial
 * bearing from the point to the place.
 * @param {number} lat degrees
 * @param {number} lon degrees
 * @param {{ name: string, lat: number, lon: number }[]} places normalised
 * @returns {{ name: string, lat: number, lon: number, distKm: number, bearingDeg: number }|null}
 */
export function nearestPlace(lat, lon, places) {
  if (!finite(lat) || !finite(lon) || !places?.length) return null;
  const here = { lat, lon };
  let best = null;
  let bestM = Infinity;
  for (const p of places) {
    const m = greatCircleM(here, p);
    if (m < bestM) {
      bestM = m;
      best = p;
    }
  }
  if (!best) return null;
  return { ...best, distKm: bestM / 1000, bearingDeg: initialBearingDeg(here, best) };
}

// WGS84, for ECEF to geodetic.
const WGS_A = 6378137;
const WGS_F = 1 / 298.257223563;
const WGS_B = WGS_A * (1 - WGS_F);
const WGS_E2 = WGS_F * (2 - WGS_F);
const WGS_EP2 = WGS_E2 / (1 - WGS_E2);

/**
 * Earth-centred Cartesian (metres, e.g. a Cesium Cartesian3) to WGS84
 * geodetic degrees, by Bowring's method (sub-millimetre near the surface).
 * @param {{ x: number, y: number, z: number }} p
 * @returns {{ lat: number, lon: number, height: number }|null}
 */
export function ecefToLatLon(p) {
  if (!p || !finite(p.x) || !finite(p.y) || !finite(p.z)) return null;
  const { x, y, z } = p;
  const r = Math.hypot(x, y);
  if (r === 0 && z === 0) return null;
  const theta = Math.atan2(z * WGS_A, r * WGS_B);
  const lat = Math.atan2(
    z + WGS_EP2 * WGS_B * Math.sin(theta) ** 3,
    r - WGS_E2 * WGS_A * Math.cos(theta) ** 3,
  );
  const sinLat = Math.sin(lat);
  const nRad = WGS_A / Math.sqrt(1 - WGS_E2 * sinLat * sinLat);
  const height =
    Math.abs(Math.cos(lat)) > 1e-9
      ? r / Math.cos(lat) - nRad
      : Math.abs(z) / Math.abs(sinLat) - nRad * (1 - WGS_E2);
  return { lat: lat * DEG, lon: Math.atan2(y, x) * DEG, height };
}

/** Whether a canvas point lies inside the free area left by the insets. */
export function inFreeArea(x, y, width, height, insets = {}) {
  const { top = 0, right = 0, bottom = 0, left = 0 } = insets;
  return x >= left && x <= width - right && y >= top && y <= height - bottom;
}

/** Update period for the HUD (ms): 4 Hz, halved on the MINIMAL tier. */
export function cadenceMs(tier) {
  return String(tier).toLowerCase() === 'minimal' ? 500 : 250;
}

// ------------------------------------------------------------- formatting
const DASH = '---';

/** Altitude: 850M, 12.4KM, 1204KM. */
export function fmtAlt(m) {
  if (!finite(m)) return DASH;
  const a = Math.abs(m);
  if (a >= 100000) return `${Math.round(m / 1000)}KM`;
  if (a >= 1000) return `${(m / 1000).toFixed(1)}KM`;
  return `${Math.round(m)}M`;
}

/** GSD: 0.42M, 12.3M, 640M, 1.25KM, 25.6KM. */
export function fmtGsd(m) {
  if (!finite(m)) return DASH;
  if (m >= 1000) {
    const km = m / 1000;
    return `${km < 10 ? km.toFixed(2) : km < 100 ? km.toFixed(1) : Math.round(km)}KM`;
  }
  return `${m < 10 ? m.toFixed(2) : m < 100 ? m.toFixed(1) : Math.round(m)}M`;
}

/** Distance: 640M, 4.2KM, 312KM. */
export function fmtDistKm(km) {
  if (!finite(km)) return DASH;
  if (km < 1) return `${Math.round(km * 1000)}M`;
  if (km < 10) return `${km.toFixed(1)}KM`;
  return `${Math.round(km)}KM`;
}

/** Bearing or heading as three digits: 045°. */
export function fmtBearing(deg) {
  if (!finite(deg)) return `${DASH}°`;
  return `${String(((Math.round(deg) % 360) + 360) % 360).padStart(3, '0')}°`;
}

/** Signed angle with one decimal: +32.1°, -4.0°. */
export function fmtSignedDeg(deg) {
  if (!finite(deg)) return `${DASH}°`;
  const s = Math.abs(deg).toFixed(1);
  return `${deg < 0 && s !== '0.0' ? '-' : '+'}${s}°`;
}

/** UTC stamp split for the REC line: { date: '2026-10-08', time: '09:48:12Z' }. */
export function utcStamp(date = new Date()) {
  const iso = date.toISOString(); // 2026-10-08T09:48:12.345Z
  return { date: iso.slice(0, 10), time: `${iso.slice(11, 19)}Z` };
}

/**
 * Every HUD readout from raw camera numbers.
 * @param {{
 *   center?: { lat: number, lon: number }|null, // ground point under the canvas centre
 *   camera?: { lat: number, lon: number, height: number }|null, // camera position (deg, m)
 *   groundHeight?: number|null, // terrain height under the camera (m), if known
 *   rangeM?: number|null, // camera to centre point (m), if the centre hit the globe
 *   pitch?: number, heading?: number, // radians
 *   fovy?: number|null, // vertical field of view (radians)
 *   heightPx?: number, // canvas height (CSS px)
 *   places?: { name: string, lat: number, lon: number }[], // normalised
 *   date?: Date,
 * }} input
 */
export function intelReadout(input = {}) {
  const { camera, center, places = [], date = new Date() } = input;
  const camOk = camera && finite(camera.lat) && finite(camera.lon);
  const ctrOk = center && finite(center.lat) && finite(center.lon);
  const source = ctrOk ? 'CENTER' : camOk ? 'NADIR' : null;
  const pt = ctrOk ? center : camOk ? camera : null;

  const altM = camOk && finite(camera.height) ? camera.height : null;
  const aglM =
    altM === null ? null : finite(input.groundHeight) ? altM - input.groundHeight : altM;
  const rangeM = ctrOk && finite(input.rangeM) && input.rangeM > 0 ? input.rangeM : aglM;
  const gsdM = gsdMetres(rangeM, input.fovy, input.heightPx);
  const niirs = niirsFromGsd(gsdM);
  const ona = offNadirDeg(input.pitch);
  const hdg = headingDeg(input.heading);
  const sunEl = pt ? sunElevationDeg(pt.lat, pt.lon, date) : null;
  const near = pt ? nearestPlace(pt.lat, pt.lon, places) : null;
  const band = viewBand(altM);
  const stamp = utcStamp(date);

  return {
    source,
    lat: pt ? pt.lat : null,
    lon: pt ? pt.lon : null,
    band,
    altM,
    aglM,
    gsdM,
    niirs,
    ona,
    hdg,
    sunEl,
    near,
    text: {
      date: stamp.date,
      time: stamp.time,
      band: band ?? DASH,
      alt: fmtAlt(altM),
      hdg: fmtBearing(hdg),
      ona: ona === null ? `${DASH}°` : `${ona.toFixed(1)}°`,
      mgrs: (pt && toMgrs(pt.lat, pt.lon, 5)) || DASH,
      dms: (pt && toDms(pt.lat, pt.lon)) || DASH,
      gsd: fmtGsd(gsdM),
      niirs: niirs === null ? DASH : niirs.toFixed(1),
      sun: fmtSignedDeg(sunEl),
      nearLabel: near && near.distKm > NEAR_MAX_KM ? 'REF' : 'NEAR',
      near: near
        ? `${near.name.toUpperCase()} ${fmtDistKm(near.distKm)} ${fmtBearing(near.bearingDeg)}`
        : DASH,
    },
  };
}
