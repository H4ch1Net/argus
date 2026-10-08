// Map view math for the terminal shell. Pure.
//
// The map is drawn on a braille canvas: every terminal cell holds 2x4 dots, and a
// cell is about twice as tall as it is wide, so a dot is roughly square. A view
// is a centre (lon, lat) plus `degPerDot`, the latitude degrees one dot spans.
// Longitude degrees per dot are scaled by 1/cos(centre latitude), which keeps
// local shapes true when zoomed in (and is plain equirectangular at the equator).

import { shortestLonDelta, normalizeLon } from '../core/layers/sdk/interpolate.js';

export const DOTS_X = 2; // braille dots per cell, horizontally
export const DOTS_Y = 4; // and vertically
export const MIN_DEG_PER_DOT = 0.0004; // ~45 m per dot: street-block scale
const MAX_LAT = 85;
const COS_CLAMP_LAT = 70; // stop the longitude stretch growing without bound near the poles

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** degPerDot that fits the whole world into a cols x rows map. */
export function worldDegPerDot(cols, rows) {
  return Math.max(360 / (cols * DOTS_X), 180 / (rows * DOTS_Y));
}

/**
 * @param {{ lon?: number, lat?: number, degPerDot: number }} v
 */
export function makeView({ lon = 0, lat = 0, degPerDot }) {
  return { lon: normalizeLon(lon), lat: clamp(lat, -MAX_LAT, MAX_LAT), degPerDot };
}

/** Dot geometry of a view rendered into cols x rows cells. */
export function metrics(view, cols, rows) {
  const dotsW = cols * DOTS_X;
  const dotsH = rows * DOTS_Y;
  const cosLat = Math.cos(
    (clamp(view.lat, -COS_CLAMP_LAT, COS_CLAMP_LAT) * Math.PI) / 180,
  );
  const dLat = view.degPerDot;
  const dLon = view.degPerDot / cosLat;
  return { cols, rows, dotsW, dotsH, dLat, dLon };
}

/**
 * Geographic position -> dot coordinates (floats; may fall outside the canvas).
 * Longitudes are taken relative to the centre the short way round, so the view
 * wraps cleanly across the antimeridian.
 */
export function project(view, m, lon, lat) {
  const dx = shortestLonDelta(view.lon, lon) / m.dLon;
  const dy = (view.lat - lat) / m.dLat;
  return { x: m.dotsW / 2 + dx, y: m.dotsH / 2 + dy };
}

/** Dot coordinates -> geographic position. */
export function unproject(view, m, x, y) {
  return {
    lon: normalizeLon(view.lon + (x - m.dotsW / 2) * m.dLon),
    lat: clamp(view.lat - (y - m.dotsH / 2) * m.dLat, -90, 90),
  };
}

/** Terminal cell (col, row) within the map -> the geographic centre of that cell. */
export function cellToLonLat(view, m, col, row) {
  return unproject(view, m, (col + 0.5) * DOTS_X, (row + 0.5) * DOTS_Y);
}

/**
 * The visible region as the SDK's bbox shape ({ lamin, lomin, lamax, lomax }), the
 * same query viewport-bounded feeds take in the browser. A view wider than the
 * world, or one straddling the antimeridian, widens longitude to the full range
 * (as core/layers/sdk/viewport.js does).
 */
export function viewBBox(view, m) {
  const halfLat = (m.dotsH / 2) * m.dLat;
  const halfLon = (m.dotsW / 2) * m.dLon;
  const lamin = clamp(view.lat - halfLat, -90, 90);
  const lamax = clamp(view.lat + halfLat, -90, 90);
  if (halfLon >= 180) return { lamin, lamax, lomin: -180, lomax: 180 };
  const west = view.lon - halfLon;
  const east = view.lon + halfLon;
  if (west < -180 || east > 180) return { lamin, lamax, lomin: -180, lomax: 180 };
  return { lamin, lamax, lomin: west, lomax: east };
}

/** Rectangle in radians (Cesium's computeViewRectangle shape), for the dev mocks. */
export function viewRectangleRadians(view, m) {
  const b = viewBBox(view, m);
  const r = Math.PI / 180;
  return { west: b.lomin * r, south: b.lamin * r, east: b.lomax * r, north: b.lamax * r };
}

/** Vertical span of the view in degrees of latitude. */
export function latSpan(view, m) {
  return m.dotsH * m.dLat;
}

/** Zoom by a factor (>1 zooms in), clamped between street scale and the world. */
export function zoomView(view, factor, cols, rows) {
  const maxDeg = worldDegPerDot(cols, rows);
  return { ...view, degPerDot: clamp(view.degPerDot / factor, MIN_DEG_PER_DOT, maxDeg) };
}

/** Pan by a fraction of the visible span (dx, dy in screen widths/heights). */
export function panView(view, m, fx, fy) {
  return makeView({
    lon: view.lon + fx * m.dotsW * m.dLon,
    lat: view.lat - fy * m.dotsH * m.dLat,
    degPerDot: view.degPerDot,
  });
}

/**
 * A camera altitude (metres, as the shared `goto` command and the globe use) ->
 * degPerDot for this map, so `goto` frames about what the globe would show.
 */
export function degPerDotForAltitude(altitude, rows) {
  const spanDeg = clamp((altitude || 1_000_000) / 50_000, 0.02, 180);
  return Math.max(MIN_DEG_PER_DOT, spanDeg / (rows * DOTS_Y));
}

/** Human-readable scale for the status bar: approx km across the map width. */
export function widthKm(view, m) {
  const km = m.dotsW * m.dLon * 111.32 * Math.cos((view.lat * Math.PI) / 180);
  return Math.max(0, km);
}
