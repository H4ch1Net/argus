// Great-circle arc geometry for renderType:'arc' (threat-map arcs and any future
// source->target layer). Pure math, no Cesium, so it is unit-tested like the rest
// of the SDK core; the renderer turns these lon/lat/alt samples into Cartesians.
//
// Points are interpolated by spherical linear interpolation (slerp) of the two
// endpoint unit vectors, so the path is a true great circle and crosses the
// antimeridian without special-casing. The arc is bowed up with a sine profile
// (0 at both ends, peak at the midpoint) so it reads as an arc over the globe.

const EARTH_RADIUS_M = 6_371_000;
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

function unitVector(lon, lat) {
  const la = toRad(lat);
  const lo = toRad(lon);
  const cl = Math.cos(la);
  return [cl * Math.cos(lo), cl * Math.sin(lo), Math.sin(la)];
}

/** Angular separation (radians) between two {longitude,latitude} points. */
export function angularDistance(from, to) {
  const a = unitVector(from.longitude, from.latitude);
  const b = unitVector(to.longitude, to.latitude);
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return Math.acos(Math.min(1, Math.max(-1, dot)));
}

/** Peak arc height (metres): a fraction of the surface distance, clamped. */
export function arcPeakHeight(
  from,
  to,
  { min = 150_000, max = 1_400_000, ratio = 0.3 } = {},
) {
  const surface = angularDistance(from, to) * EARTH_RADIUS_M;
  return Math.min(max, Math.max(min, surface * ratio));
}

/**
 * Point at fraction t in [0,1] along the great-circle arc from -> to.
 * @returns {{ longitude: number, latitude: number, altitude: number }} degrees + metres
 */
export function arcPointAt(from, to, t, peak = arcPeakHeight(from, to)) {
  const a = unitVector(from.longitude, from.latitude);
  const b = unitVector(to.longitude, to.latitude);
  const omega = angularDistance(from, to);
  let x;
  let y;
  let z;
  if (omega < 1e-9) {
    [x, y, z] = a;
  } else {
    const s = Math.sin(omega);
    const s1 = Math.sin((1 - t) * omega) / s;
    const s2 = Math.sin(t * omega) / s;
    x = s1 * a[0] + s2 * b[0];
    y = s1 * a[1] + s2 * b[1];
    z = s1 * a[2] + s2 * b[2];
  }
  return {
    longitude: toDeg(Math.atan2(y, x)),
    latitude: toDeg(Math.atan2(z, Math.hypot(x, y))),
    altitude: peak * Math.sin(Math.PI * t),
  };
}

/** Sample the arc into `samples`+1 points, sharing one peak height. */
export function arcSamples(from, to, samples = 64) {
  const peak = arcPeakHeight(from, to);
  const points = [];
  for (let i = 0; i <= samples; i += 1) {
    points.push(arcPointAt(from, to, i / samples, peak));
  }
  return { points, peak };
}
