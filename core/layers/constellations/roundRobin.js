// Round-robin propagation for big satellite sets. Instead of re-running SGP4 for
// every satellite in the same frame (a spike of thousands of propagations once
// a second), each satellite is refreshed once per period at its own phase, so
// the work is spread evenly: with 10,000 Starlink satellites on a 5 s period at
// 30 fps that is about 67 propagations a frame. Between refreshes the position
// is extrapolated linearly from the last two samples, so motion stays smooth.
// Adapted from gods-eye-view src/layers/satellites/policy.js (MIT), whose dense
// mode spreads one full pass over ~300 frames; here the spread is by time, so
// it holds at any frame rate. Pure: the propagator is injected.

const GOLDEN = 0.6180339887498949; // low-discrepancy phase spread

/**
 * @param {(n: object, timeMs: number) => ({ longitude: number, latitude: number, altitude?: number } | null)} positionAt
 *   the real propagator (e.g. SGP4 via satPositionAt)
 * @param {{ periodMs?: number, periodFor?: (n: object) => number, extrapolate?: boolean }} [opts]
 *   periodFor picks a per-satellite period (e.g. 5 s for the dense shell, 1 s for the rest)
 * @returns {(n: object, timeMs: number) => ({ longitude: number, latitude: number, altitude: number } | null)}
 *   a drop-in def.positionAt. The returned object is reused: copy it before the next call.
 */
export function createRoundRobinPositioner(
  positionAt,
  { periodMs = 1000, periodFor = null, extrapolate = true } = {},
) {
  const state = new WeakMap(); // normalized entity -> { phase, slot, cur, prev }
  let seq = 0;
  const out = { longitude: 0, latitude: 0, altitude: 0 };

  return function roundRobinPositionAt(n, t) {
    const period = Math.max(1, periodFor ? periodFor(n) : periodMs);
    let s = state.get(n);
    if (!s) {
      seq += 1;
      s = { phase: ((seq * GOLDEN) % 1) * period, slot: NaN, cur: null, prev: null };
      state.set(n, s);
    }
    const slot = Math.floor((t + s.phase) / period);
    // A clock jump (time scrubber, a long pause) invalidates both samples.
    const jumped = s.cur !== null && Math.abs(t - s.cur.t) > 2 * period;
    if (slot !== s.slot || s.cur === null || jumped) {
      s.slot = slot;
      const p = positionAt(n, t);
      if (!p) {
        s.cur = null;
        s.prev = null;
        return null;
      }
      s.prev = jumped ? null : s.cur;
      s.cur = {
        t,
        longitude: p.longitude,
        latitude: p.latitude,
        altitude: p.altitude ?? 0,
      };
      out.longitude = s.cur.longitude;
      out.latitude = s.cur.latitude;
      out.altitude = s.cur.altitude;
      return out;
    }
    const { cur, prev } = s;
    const dt = prev ? cur.t - prev.t : 0;
    if (!extrapolate || !prev || dt <= 0) {
      out.longitude = cur.longitude;
      out.latitude = cur.latitude;
      out.altitude = cur.altitude;
      return out;
    }
    const k = (t - cur.t) / dt;
    let dLon = cur.longitude - prev.longitude;
    if (dLon > 180) dLon -= 360;
    else if (dLon < -180) dLon += 360;
    let lon = cur.longitude + dLon * k;
    if (lon > 180) lon -= 360;
    else if (lon < -180) lon += 360;
    out.longitude = lon;
    out.latitude = Math.max(
      -90,
      Math.min(90, cur.latitude + (cur.latitude - prev.latitude) * k),
    );
    out.altitude = cur.altitude + (cur.altitude - prev.altitude) * k;
    return out;
  };
}
