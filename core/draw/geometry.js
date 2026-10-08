// Draw and measure: the pure half (no Cesium, no DOM). A draw session holds a
// shape (area, line or pin) and its vertices; this module decides which taps
// count as vertices, when a shape can finish, and measures it: great-circle
// length for a line, local planar (shoelace) area for an area, a dateline-safe
// centroid. The shell owns input (Pointer Events: tap to add, Done to finish)
// and rendering; it calls these and shows formatMeasure() in the hint.
//
// Adapted from gods-eye-view src/annotations/drawMode.js (MIT).

export const DRAW_SHAPES = Object.freeze(['area', 'line', 'pin']);
export const MIN_VERTICES = Object.freeze({ area: 3, line: 2, pin: 1 });
/** Hard ceiling on vertices in one shape, so a stuck button or a script cannot grow one forever. */
export const MAX_VERTICES = 512;
/** Two taps closer than this are one vertex (the second half of a double tap). */
export const MIN_VERTEX_SEPARATION_M = 0.5;
/** A line shorter than this, or an area smaller than this, is a mis-tap rather than a shape. */
export const MIN_PATH_LENGTH_M = 1;
export const MIN_AREA_M2 = 1;

const EARTH_R_M = 6371008.8;
const M_PER_DEG = 111_320;
const RAD = Math.PI / 180;

/** 'path' | 'route' -> 'line'; 'point' | 'marker' -> 'pin'; anything else -> 'area'. */
export function normalizeShape(shape) {
  const s = String(shape || '').toLowerCase();
  if (s === 'line' || s === 'path' || s === 'route' || s === 'measure') return 'line';
  if (s === 'pin' || s === 'point' || s === 'marker') return 'pin';
  return 'area';
}

/** @returns {{ shape: 'area'|'line'|'pin', vertices: Array<{lon:number, lat:number}> }} */
export function createDrawSession(shape = 'area') {
  return { shape: normalizeShape(shape), vertices: [] };
}

/** A usable tap position: finite and on the globe. */
export function isValidVertex(v) {
  return (
    !!v &&
    Number.isFinite(v.lon) &&
    Number.isFinite(v.lat) &&
    Math.abs(v.lon) <= 180 &&
    Math.abs(v.lat) <= 90
  );
}

/** Great-circle distance in metres between two {lon, lat} points. */
export function greatCircleM(a, b) {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial great-circle bearing from a to b, degrees clockwise from north in [0, 360). */
export function initialBearingDeg(a, b) {
  const y = Math.sin((b.lon - a.lon) * RAD) * Math.cos(b.lat * RAD);
  const x =
    Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) -
    Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos((b.lon - a.lon) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

/**
 * Add a vertex. Off-globe input is refused ('invalid'); a tap within
 * MIN_VERTEX_SEPARATION_M of the last vertex is the same tap ('duplicate');
 * past MAX_VERTICES the shape is 'full'. A pin holds one vertex: a later tap moves it.
 * @returns {{ added: boolean, reason?: 'invalid'|'duplicate'|'full' }}
 */
export function addVertex(
  session,
  vertex,
  { minSeparationM = MIN_VERTEX_SEPARATION_M } = {},
) {
  if (!session || !isValidVertex(vertex)) return { added: false, reason: 'invalid' };
  const v = { lon: vertex.lon, lat: vertex.lat };
  if (session.shape === 'pin') {
    session.vertices = [v];
    return { added: true };
  }
  if (session.vertices.length >= MAX_VERTICES) return { added: false, reason: 'full' };
  const last = session.vertices[session.vertices.length - 1];
  if (last && greatCircleM(last, v) < minSeparationM)
    return { added: false, reason: 'duplicate' };
  session.vertices.push(v);
  return { added: true };
}

/** Undo the last vertex. @returns {boolean} whether one was removed */
export function removeLastVertex(session) {
  if (!session?.vertices?.length) return false;
  session.vertices.pop();
  return true;
}

/** Length of an open path in metres (summed great-circle legs). */
export function pathLengthM(vertices) {
  let m = 0;
  for (let i = 1; i < (vertices?.length || 0); i += 1)
    m += greatCircleM(vertices[i - 1], vertices[i]);
  return m;
}

/**
 * The same vertices with longitudes made continuous relative to the first,
 * so planar maths does not tear at the antimeridian ([179.99, -179.99] is
 * 0.02 degrees wide, not 359.98). Values may leave [-180, 180] on purpose;
 * wrapLongitude brings one back.
 */
export function unwrapLongitudes(vertices) {
  if (!vertices?.length) return [];
  const ref = vertices[0].lon;
  return vertices.map((v) => {
    let lon = v.lon;
    while (lon - ref > 180) lon -= 360;
    while (lon - ref < -180) lon += 360;
    return { ...v, lon };
  });
}

/** A continuous longitude brought back into [-180, 180). In-range values pass unchanged. */
export function wrapLongitude(lon) {
  if (!Number.isFinite(lon)) return lon;
  if (lon >= -180 && lon < 180) return lon;
  const w = ((((lon + 180) % 360) + 360) % 360) - 180;
  return Object.is(w, -0) ? 0 : w;
}

/** Planar shoelace area of a ring in m2, on a local metre grid (fine at drawing scale). */
export function ringAreaM2(vertices) {
  if (!vertices || vertices.length < 3) return 0;
  const ring = unwrapLongitudes(vertices);
  const lat0 = ring.reduce((s, v) => s + v.lat, 0) / ring.length;
  const kx = M_PER_DEG * Math.cos(lat0 * RAD);
  const ky = M_PER_DEG;
  let twice = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    twice += a.lon * kx * (b.lat * ky) - b.lon * kx * (a.lat * ky);
  }
  return Math.abs(twice) / 2;
}

/** Vertex-average centroid {lon, lat}, safe across the antimeridian. Null for no vertices. */
export function ringCentroid(vertices) {
  if (!vertices?.length) return null;
  const ring = unwrapLongitudes(vertices);
  return {
    lon: wrapLongitude(ring.reduce((s, v) => s + v.lon, 0) / ring.length),
    lat: ring.reduce((s, v) => s + v.lat, 0) / ring.length,
  };
}

/**
 * Why a session can or cannot finish.
 * 'too-few': keep tapping. 'degenerate': enough vertices that describe nothing
 * (collinear area, zero-length line). 'invalid': a vertex is off the globe.
 * @returns {'ok'|'too-few'|'degenerate'|'invalid'}
 */
export function finishReason(session) {
  if (!session || !Array.isArray(session.vertices)) return 'invalid';
  if (session.vertices.some((v) => !isValidVertex(v))) return 'invalid';
  if (session.vertices.length < (MIN_VERTICES[session.shape] || 1)) return 'too-few';
  if (session.shape === 'line' && pathLengthM(session.vertices) < MIN_PATH_LENGTH_M)
    return 'degenerate';
  if (session.shape === 'area' && ringAreaM2(session.vertices) < MIN_AREA_M2)
    return 'degenerate';
  return 'ok';
}

export const canFinish = (session) => finishReason(session) === 'ok';

/** A ring whose last position repeats its first, so an outline has no gap. */
export function closeRing(pairs) {
  if (!Array.isArray(pairs) || pairs.length < 3) return pairs;
  const [fLon, fLat] = pairs[0];
  const [lLon, lLat] = pairs[pairs.length - 1];
  if (fLon === lLon && fLat === lLat) return pairs;
  return [...pairs, [fLon, fLat]];
}

const trimNum = (n, digits) => String(Number(n.toFixed(digits)));

/** 'LEN 850 M', 'LEN 12.4 KM', 'LEN 431 KM'. */
export function formatLength(m) {
  if (!Number.isFinite(m) || m < 0) return '';
  if (m < 1000) return `LEN ${Math.round(m)} M`;
  const km = m / 1000;
  return `LEN ${km < 100 ? km.toFixed(1) : Math.round(km)} KM`;
}

/** 'AREA 4500 M2', 'AREA 3.20 KM2', 'AREA 1250 KM2'. */
export function formatArea(m2) {
  if (!Number.isFinite(m2) || m2 < 0) return '';
  if (m2 < 1e6) return `AREA ${Math.round(m2)} M2`;
  const km2 = m2 / 1e6;
  return `AREA ${km2 < 100 ? km2.toFixed(2) : Math.round(km2)} KM2`;
}

/** 'PIN 48.8566N 2.3522E'. */
export function formatPin(v) {
  if (!isValidVertex(v)) return '';
  const lat = `${trimNum(Math.abs(v.lat), 4)}${v.lat < 0 ? 'S' : 'N'}`;
  const lon = `${trimNum(Math.abs(v.lon), 4)}${v.lon < 0 ? 'W' : 'E'}`;
  return `PIN ${lat} ${lon}`;
}

/** Terse uppercase measure for the hint or a label suffix: length, area, or the pin's position. */
export function formatMeasure(session) {
  if (!session?.vertices?.length) return '';
  if (session.shape === 'line') return formatLength(pathLengthM(session.vertices));
  if (session.shape === 'area')
    return session.vertices.length < 3 ? '' : formatArea(ringAreaM2(session.vertices));
  return formatPin(session.vertices[0]);
}

/**
 * A finished shape as plain data for the renderer: [lon, lat] pairs (an area's
 * ring closed explicitly, so its outline has no missing side), the centroid
 * for a label anchor, and the measure. Null when the session cannot finish.
 * @returns {null | { shape: 'area'|'line'|'pin', coordinates: Array<[number, number]>,
 *   centroid: {lon:number, lat:number}, measure: string, lengthM?: number, areaM2?: number,
 *   label: string|null, color: string }}
 */
export function finishShape(session, { label = '', color = 'primary' } = {}) {
  if (!canFinish(session)) return null;
  const pts = session.vertices.map((v) => [v.lon, v.lat]);
  const text =
    String(label || '')
      .trim()
      .slice(0, 80) || null;
  const out = {
    shape: session.shape,
    coordinates: session.shape === 'area' ? closeRing(pts) : pts,
    centroid: ringCentroid(session.vertices),
    measure: formatMeasure(session),
    label: text,
    color,
  };
  if (session.shape === 'line') out.lengthM = pathLengthM(session.vertices);
  if (session.shape === 'area') out.areaM2 = ringAreaM2(session.vertices);
  return out;
}
