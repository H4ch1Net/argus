// Route geometry for navigation: distances, bearings, encoded polylines, and
// snapping a position onto a route line. Pure (no Cesium, no DOM): every shell
// shares it, the terminal included.
//
// Lines are [lon, lat] pairs (GeoJSON order). Snapping works in a local
// equirectangular frame centred on the point being snapped: at road scale
// (segments of metres to a few kilometres) its error is far below GPS noise.

export const EARTH_R_M = 6371008.8;
const RAD = Math.PI / 180;
const M_PER_DEG = EARTH_R_M * RAD;

/** Great-circle distance in metres. */
export function haversineM(aLat, aLon, bLat, bLon) {
  const dLat = (bLat - aLat) * RAD;
  const dLon = (bLon - aLon) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * RAD) * Math.cos(bLat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b, degrees clockwise from north in [0, 360). */
export function bearingDeg(aLat, aLon, bLat, bLon) {
  const y = Math.sin((bLon - aLon) * RAD) * Math.cos(bLat * RAD);
  const x =
    Math.cos(aLat * RAD) * Math.sin(bLat * RAD) -
    Math.sin(aLat * RAD) * Math.cos(bLat * RAD) * Math.cos((bLon - aLon) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

/** The point `distM` metres from (lat, lon) along `brgDeg`. */
export function destination(lat, lon, brgDeg, distM) {
  const a = distM / EARTH_R_M;
  const b = brgDeg * RAD;
  const p1 = lat * RAD;
  const l1 = lon * RAD;
  const p2 = Math.asin(
    Math.sin(p1) * Math.cos(a) + Math.cos(p1) * Math.sin(a) * Math.cos(b),
  );
  const l2 =
    l1 +
    Math.atan2(
      Math.sin(b) * Math.sin(a) * Math.cos(p1),
      Math.cos(a) - Math.sin(p1) * Math.sin(p2),
    );
  return { lat: p2 / RAD, lon: ((((l2 / RAD + 540) % 360) + 360) % 360) - 180 };
}

/** Signed smallest difference b - a in degrees, in (-180, 180]. */
export function angleDiff(a, b) {
  let d = (((b - a) % 360) + 360) % 360;
  if (d > 180) d -= 360;
  return d;
}

/**
 * Decode an encoded polyline (Google's format; Valhalla uses precision 6)
 * into [lon, lat] pairs. Malformed input decodes to what was readable.
 */
export function decodePolyline(str, precision = 6) {
  const s = typeof str === 'string' ? str : '';
  const factor = 10 ** precision;
  const out = [];
  let i = 0;
  let lat = 0;
  let lon = 0;
  const next = () => {
    let result = 0;
    let shift = 0;
    let b;
    do {
      if (i >= s.length) return null;
      b = s.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && shift < 35);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < s.length) {
    const dLat = next();
    const dLon = next();
    if (dLat === null || dLon === null) break;
    lat += dLat;
    lon += dLon;
    out.push([lon / factor, lat / factor]);
  }
  return out;
}

/** Keep the [lon, lat] pairs that are numbers on the globe; drop repeats. */
export function cleanLine(coords) {
  const out = [];
  for (const c of Array.isArray(coords) ? coords : []) {
    const lon = Number(c?.[0]);
    const lat = Number(c?.[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const prev = out[out.length - 1];
    if (prev && prev[0] === lon && prev[1] === lat) continue;
    out.push([lon, lat]);
  }
  return out;
}

/** Cumulative distance (m) at each vertex of a [lon, lat] line. */
export function cumulative(line) {
  const cum = new Float64Array(line.length);
  for (let i = 1; i < line.length; i += 1) {
    cum[i] =
      cum[i - 1] + haversineM(line[i - 1][1], line[i - 1][0], line[i][1], line[i][0]);
  }
  return cum;
}

/** The vertex index closest to (lat, lon) at or after `from` (a linear scan). */
export function nearestVertex(line, lat, lon, from = 0) {
  let best = -1;
  let bestD = Infinity;
  const k = Math.cos(lat * RAD);
  for (let i = Math.max(0, from); i < line.length; i += 1) {
    const dx = (line[i][0] - lon) * k;
    const dy = line[i][1] - lat;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Snap a point onto a line: the closest point on segments [from, to) (vertex
 * indices; the whole line by default). Writes into `out` (reused, so a 1 Hz
 * GPS stream allocates nothing) and returns it:
 *   { index: segment start vertex, t: 0..1 along it, along: metres from the
 *     line start, offM: metres from the point to the line, lat, lon }
 * `cum` is cumulative(line). A line of one vertex snaps to that vertex.
 */
export function snapToLine(line, cum, lat, lon, opts = {}, out = {}) {
  const n = line.length;
  const from = Math.max(0, Math.min(n - 2, opts.from ?? 0));
  const to = Math.min(n - 1, opts.to ?? n - 1);
  const k = Math.cos(lat * RAD) * M_PER_DEG;
  out.index = 0;
  out.t = 0;
  out.offM = Infinity;
  out.along = 0;
  out.lat = n ? line[0][1] : lat;
  out.lon = n ? line[0][0] : lon;
  if (n === 1) {
    out.offM = haversineM(lat, lon, line[0][1], line[0][0]);
    return out;
  }
  for (let i = from; i < to; i += 1) {
    const ax = wrapDeg(line[i][0] - lon) * k;
    const ay = (line[i][1] - lat) * M_PER_DEG;
    const bx = wrapDeg(line[i + 1][0] - lon) * k;
    const by = (line[i + 1][1] - lat) * M_PER_DEG;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const px = ax + dx * t;
    const py = ay + dy * t;
    const d = Math.sqrt(px * px + py * py);
    if (d < out.offM) {
      out.offM = d;
      out.index = i;
      out.t = t;
    }
  }
  const i = out.index;
  const t = out.t;
  out.along = cum[i] + (cum[i + 1] - cum[i]) * t;
  out.lat = line[i][1] + (line[i + 1][1] - line[i][1]) * t;
  out.lon = line[i][0] + wrapDeg(line[i + 1][0] - line[i][0]) * t;
  return out;
}

function wrapDeg(d) {
  if (d > 180) return d - 360;
  if (d < -180) return d + 360;
  return d;
}

/**
 * The point `along` metres from the line start, with the bearing of the
 * segment it lies on. Writes into `out` and returns it: { lat, lon, heading,
 * index }. Clamped to the line's ends. `hint` (a vertex index) speeds up a
 * monotonic walk.
 */
export function pointAlong(line, cum, along, out = {}, hint = 0) {
  const n = line.length;
  if (!n) return null;
  if (n === 1) {
    out.lat = line[0][1];
    out.lon = line[0][0];
    out.heading = 0;
    out.index = 0;
    return out;
  }
  const s = Math.max(0, Math.min(cum[n - 1], along));
  let i = Math.max(0, Math.min(n - 2, hint));
  if (cum[i] > s) i = 0;
  while (i < n - 2 && cum[i + 1] < s) i += 1;
  const seg = cum[i + 1] - cum[i];
  const t = seg > 1e-9 ? (s - cum[i]) / seg : 0;
  const a = line[i];
  const b = line[i + 1];
  out.lat = a[1] + (b[1] - a[1]) * t;
  out.lon = a[0] + wrapDeg(b[0] - a[0]) * t;
  out.heading = bearingDeg(a[1], a[0], b[1], b[0]);
  out.index = i;
  return out;
}

/** [west, south, east, north] of a [lon, lat] line, or null when empty. */
export function lineBBox(line) {
  if (!line?.length) return null;
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const [lon, lat] of line) {
    if (lon < w) w = lon;
    if (lon > e) e = lon;
    if (lat < s) s = lat;
    if (lat > n) n = lat;
  }
  return [w, s, e, n];
}
