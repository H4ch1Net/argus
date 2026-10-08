// Ring helpers for the area and line layers (storm cones and tracks, fire
// perimeters): GeoJSON polygons into the polygon renderType's shape, a
// representative point that survives the antimeridian, a vertex cap for the
// phone, and ring identity kept across polls. Pure: no Cesium.
//
// The polygon renderType reads meta.polygon = [[lon, lat], ...] (the outer
// ring, open: no repeated closing vertex) and meta.holes = [ring, ...]. The
// polyline renderType reads meta.path = [[lon, lat], ...].

const finite = (n) => typeof n === 'number' && Number.isFinite(n);

/** A [lon, lat] pair inside the WGS84 range, or null. */
export function lonLat(p) {
  if (!Array.isArray(p) || p.length < 2) return null;
  const [lon, lat] = p;
  if (!finite(lon) || !finite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90)
    return null;
  return [lon, lat];
}

/**
 * A GeoJSON ring (closed or not) as an open ring of [lon, lat], or null when it
 * is malformed or has fewer than three distinct corners.
 */
export function openRing(ring) {
  if (!Array.isArray(ring)) return null;
  const out = [];
  for (const p of ring) {
    const q = lonLat(p);
    if (!q) return null;
    const last = out[out.length - 1];
    if (!last || last[0] !== q[0] || last[1] !== q[1]) out.push(q);
  }
  if (out.length > 1) {
    const [a, b] = [out[0], out[out.length - 1]];
    if (a[0] === b[0] && a[1] === b[1]) out.pop();
  }
  return out.length >= 3 ? out : null;
}

/**
 * At most `max` vertices, keeping every k-th one (and always the first). A
 * perimeter generalized to ~100 m rarely needs more; the phone draws less.
 */
export function capVertices(points, max) {
  if (!Array.isArray(points) || points.length <= max) return points;
  const step = Math.ceil(points.length / max);
  const out = [];
  for (let i = 0; i < points.length; i += step) out.push(points[i]);
  return out;
}

/**
 * Polygon or MultiPolygon geometry as [{ outer, holes }] with open rings, or
 * null when the geometry is not an area or any ring is malformed.
 */
export function polygonParts(geometry) {
  let polys;
  if (geometry?.type === 'Polygon') polys = [geometry.coordinates];
  else if (geometry?.type === 'MultiPolygon') polys = geometry.coordinates;
  else return null;
  if (!Array.isArray(polys)) return null;
  const parts = [];
  for (const rings of polys) {
    if (!Array.isArray(rings) || !rings.length) continue;
    const opened = rings.map(openRing);
    if (opened.some((r) => r === null)) return null;
    parts.push({ outer: opened[0], holes: opened.slice(1) });
  }
  return parts;
}

/** LineString or MultiLineString geometry as paths of [lon, lat], or null. */
export function lineParts(geometry) {
  let lines;
  if (geometry?.type === 'LineString') lines = [geometry.coordinates];
  else if (geometry?.type === 'MultiLineString') lines = geometry.coordinates;
  else return null;
  if (!Array.isArray(lines)) return null;
  const parts = [];
  for (const line of lines) {
    if (!Array.isArray(line)) return null;
    const path = line.map(lonLat);
    if (path.some((p) => p === null)) return null;
    if (path.length >= 2) parts.push(path);
  }
  return parts;
}

// Longitudes unwrapped against the first vertex, so a ring that crosses the
// antimeridian (179 then -179) is measured as one shape, not one spanning
// the whole globe.
function unwrapped(ring) {
  const base = ring[0][0];
  return ring.map(([lon, lat]) => {
    let x = lon;
    while (x - base > 180) x -= 360;
    while (x - base < -180) x += 360;
    return [x, lat];
  });
}

const wrapLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

/** Planar area of a ring in square degrees (relative sizes only). */
export function ringArea(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return 0;
  const r = unwrapped(ring);
  let sum = 0;
  for (let i = 0; i < r.length; i++) {
    const [x1, y1] = r[i];
    const [x2, y2] = r[(i + 1) % r.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum / 2);
}

/**
 * A representative point of a ring: the vertex mean, which for compact shapes
 * (perimeters, cones) stays inside or near the area. Antimeridian-safe.
 * @returns {{ longitude: number, latitude: number, altitude: number }}
 */
export function ringCentroid(ring) {
  const r = unwrapped(ring);
  let lon = 0;
  let lat = 0;
  for (const [x, y] of r) {
    lon += x;
    lat += y;
  }
  return { longitude: wrapLon(lon / r.length), latitude: lat / r.length, altitude: 0 };
}

const sameRing = (a, b) =>
  a === b ||
  (Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every((p, i) => p[0] === b[i][0] && p[1] === b[i][1]));

/**
 * Keep ring arrays identical (===) across polls while their coordinates are
 * unchanged. The polygon renderer rebuilds an entity's geometry when its ring
 * array changes, and rebuilding hundreds of ground polygons every few minutes
 * would make them blink. Returns normalize-side middleware: (list) => list.
 */
export function createRingMemo() {
  let prev = new Map(); // id -> { polygon, holes, path }
  return (list) => {
    const next = new Map();
    for (const n of list) {
      const old = prev.get(n.id);
      const m = n.meta;
      if (old) {
        if (m.polygon && sameRing(old.polygon, m.polygon)) m.polygon = old.polygon;
        if (m.path && sameRing(old.path, m.path)) m.path = old.path;
        if (
          m.holes &&
          old.holes &&
          m.holes.length === old.holes.length &&
          m.holes.every((h, i) => sameRing(h, old.holes[i]))
        )
          m.holes = old.holes;
      }
      next.set(n.id, { polygon: m.polygon, holes: m.holes, path: m.path });
    }
    prev = next;
    return list;
  };
}
