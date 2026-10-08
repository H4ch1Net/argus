// Closest point of approach (CPA) between two movers, the radar and AIS
// staple: where and when two tracks will pass nearest each other if both hold
// course and speed. Pure (no Cesium): positions in degrees, velocities as
// { speed (m/s), heading (degrees from north) }. A local flat-earth frame
// around the first point is exact enough over the tens of kilometres and few
// minutes this is used for.

const R = 6_371_008.8;
const RAD = Math.PI / 180;

/** East/north metres of b relative to a (equirectangular, around a). */
export function enuOffset(a, b) {
  const e = (b.lon - a.lon) * RAD * R * Math.cos(a.lat * RAD);
  const n = (b.lat - a.lat) * RAD * R;
  return { e, n };
}

/** A velocity as east/north metres per second. */
export function velocityEn(v) {
  if (!v || !Number.isFinite(v.speed) || !Number.isFinite(v.heading))
    return { e: 0, n: 0 };
  return {
    e: v.speed * Math.sin(v.heading * RAD),
    n: v.speed * Math.cos(v.heading * RAD),
  };
}

/**
 * CPA of `other` relative to `own`.
 * @param {{ lat: number, lon: number, alt?: number, velocity?: object }} own
 * @param {{ lat: number, lon: number, alt?: number, velocity?: object }} other
 * @returns {{ rangeM: number, cpaM: number, tcpaS: number, closing: boolean,
 *   altDiffM: number|null }}
 *   tcpaS is 0 when the two are already as close as they will get (opening).
 */
export function closestApproach(own, other) {
  const r = enuOffset(own, other);
  const vo = velocityEn(own.velocity);
  const vt = velocityEn(other.velocity);
  const v = { e: vt.e - vo.e, n: vt.n - vo.n };
  const rangeM = Math.hypot(r.e, r.n);
  const vv = v.e * v.e + v.n * v.n;
  const altDiffM =
    Number.isFinite(own.alt) && Number.isFinite(other.alt) ? other.alt - own.alt : null;
  if (vv < 1e-6) return { rangeM, cpaM: rangeM, tcpaS: 0, closing: false, altDiffM };
  const t = -(r.e * v.e + r.n * v.n) / vv;
  if (t <= 0) return { rangeM, cpaM: rangeM, tcpaS: 0, closing: false, altDiffM };
  const cpaM = Math.hypot(r.e + v.e * t, r.n + v.n * t);
  return { rangeM, cpaM, tcpaS: t, closing: true, altDiffM };
}

/**
 * Whether a closing pass deserves attention: it passes within `cpaLimitM`
 * inside `withinS` seconds (and, with altitudes, within `altLimitM`).
 */
export function isConflict(c, { cpaLimitM = 2000, withinS = 300, altLimitM = 600 } = {}) {
  if (!c?.closing || c.tcpaS > withinS || c.cpaM > cpaLimitM) return false;
  return c.altDiffM === null || Math.abs(c.altDiffM) <= altLimitM;
}

/** "04:12" for a time to CPA. */
export function formatTcpa(s) {
  if (!Number.isFinite(s) || s <= 0) return '--:--';
  const m = Math.floor(s / 60);
  return m >= 100
    ? '99:59'
    : `${String(m).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}
