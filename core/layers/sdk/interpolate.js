// Position interpolation for movers.
//
// The layer renders about one polling interval behind real time and tweens
// between the two most recent fixes (CLAUDE.md): that is what makes 15-30s feed
// updates look smooth. Rendering behind real time means the render clock sits
// between two known fixes, so we interpolate and never extrapolate into the
// unknown future. Pure math, unit-testable.

export const lerp = (a, b, f) => a + (b - a) * f;

/** Shortest signed longitude delta from a to b, handling the 180 meridian. */
export function shortestLonDelta(a, b) {
  let d = b - a;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

/** Wrap a longitude into [-180, 180). */
export function normalizeLon(lon) {
  let x = ((lon + 180) % 360) - 180;
  if (x < -180) x += 360;
  return x;
}

/**
 * Interpolate between two fixes at a render time (ms). Fixes are
 * { t, longitude, latitude, altitude }, t in ms. Before the first fix returns
 * prev; at/after curr holds curr (no extrapolation).
 * @returns {{ longitude: number, latitude: number, altitude: number }}
 */
export function interpolateFix(prev, curr, renderTimeMs) {
  const at = (fix) => ({
    longitude: fix.longitude,
    latitude: fix.latitude,
    altitude: fix.altitude ?? 0,
  });
  if (!prev) return at(curr);

  const span = curr.t - prev.t;
  if (span <= 0) return at(curr);

  const f = (renderTimeMs - prev.t) / span;
  if (f <= 0) return at(prev);
  if (f >= 1) return at(curr);

  return {
    longitude: normalizeLon(
      prev.longitude + shortestLonDelta(prev.longitude, curr.longitude) * f,
    ),
    latitude: lerp(prev.latitude, curr.latitude, f),
    altitude: lerp(prev.altitude ?? 0, curr.altitude ?? 0, f),
  };
}

/**
 * interpolateFix without allocating: writes { longitude, latitude, altitude }
 * into `out` and returns it. The per-frame mover update uses this, so a layer
 * of thousands of aircraft produces no garbage each frame.
 */
export function interpolateInto(prev, curr, renderTimeMs, out) {
  const take = (fix) => {
    out.longitude = fix.longitude;
    out.latitude = fix.latitude;
    out.altitude = fix.altitude ?? 0;
    return out;
  };
  if (!prev) return take(curr);
  const span = curr.t - prev.t;
  if (span <= 0) return take(curr);
  const f = (renderTimeMs - prev.t) / span;
  if (f <= 0) return take(prev);
  if (f >= 1) return take(curr);
  out.longitude = normalizeLon(
    prev.longitude + shortestLonDelta(prev.longitude, curr.longitude) * f,
  );
  out.latitude = lerp(prev.latitude, curr.latitude, f);
  out.altitude = lerp(prev.altitude ?? 0, curr.altitude ?? 0, f);
  return out;
}

// --- smooth motion from choppy data -------------------------------------------
//
// Feeds report late, irregularly, or twice with the same position; a moveEnd
// refetch adds a fix mid-interval. The layer therefore (1) stamps fixes with
// the source's own time when it has one, aligned to the local clock by the
// batch's median age, so the spacing between fixes is the real one and a
// repeated report adds nothing; (2) places a mover by bracketing the render
// time across all its retained fixes, not just the last two; (3) past the
// newest fix (a late poll) or before the first, dead-reckons along the
// reported speed and heading for a bounded time instead of stopping; and (4)
// glides the drawn position toward that target, so a correction when the next
// fix lands is a short ease, never a jump. All allocation-free.

const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON = 111_320;

/**
 * Move a fix by speed (m/s) along a heading (degrees clockwise from north) for
 * dtMs (negative goes back), into out. Flat-earth step: fine for the few
 * kilometres a contact covers between fixes.
 */
export function deadReckonInto(fix, mps, headingDeg, dtMs, out) {
  const d = (mps * dtMs) / 1000;
  const h = (headingDeg * Math.PI) / 180;
  const lat = fix.latitude + (d * Math.cos(h)) / M_PER_DEG_LAT;
  const k = Math.max(0.01, Math.cos((((fix.latitude + lat) / 2) * Math.PI) / 180));
  out.longitude = normalizeLon(fix.longitude + (d * Math.sin(h)) / (M_PER_DEG_LON * k));
  out.latitude = Math.max(-89.9, Math.min(89.9, lat));
  out.altitude = fix.altitude ?? 0;
  return out;
}

/**
 * A mover's position at render time t from its fix history (a ring buffer),
 * into out: bracketed interpolation inside the retained window; outside it,
 * dead reckoning from the nearest end for at most maxAheadMs when a velocity
 * ({ mps, headingDeg }) is known, else the end fix. Returns out, or undefined
 * with no fixes.
 */
export function moverPositionInto(history, t, velocity, maxAheadMs, out) {
  const last = history.last();
  if (!last) return undefined;
  const reckon =
    velocity &&
    Number.isFinite(velocity.mps) &&
    velocity.mps > 0.2 &&
    Number.isFinite(velocity.headingDeg) &&
    maxAheadMs > 0;
  if (reckon && t > last.t) {
    return deadReckonInto(
      last,
      velocity.mps,
      velocity.headingDeg,
      Math.min(t - last.t, maxAheadMs),
      out,
    );
  }
  // Before the first fix (a contact just seen): run it back along its
  // velocity, so it moves from the first frame instead of waiting a whole
  // interval for the render time to reach its first fix.
  const first = history.first();
  if (reckon && t < first.t) {
    const back = Math.min(first.t - t, maxAheadMs);
    return deadReckonInto(first, velocity.mps, velocity.headingDeg, -back, out);
  }
  return history.sampleInto(t, interpolateInto, out);
}

/**
 * Ease a drawn position (state: { longitude, latitude, altitude, init }) toward
 * a target over about tauMs; snap on the first call or when the target is
 * more than snapM away (a different track, not a correction). Mutates state.
 */
export function smoothInto(state, target, dtMs, tauMs = 700, snapM = 3000) {
  const dLon = shortestLonDelta(state.longitude, target.longitude);
  const dLat = target.latitude - state.latitude;
  const far =
    !state.init ||
    Math.hypot(
      dLat * M_PER_DEG_LAT,
      dLon * M_PER_DEG_LON * Math.cos((target.latitude * Math.PI) / 180),
    ) > snapM;
  if (far || !(tauMs > 0)) {
    state.longitude = target.longitude;
    state.latitude = target.latitude;
    state.altitude = target.altitude ?? 0;
    state.init = true;
    return state;
  }
  const a = 1 - Math.exp(-Math.max(0, dtMs) / tauMs);
  state.longitude = normalizeLon(state.longitude + dLon * a);
  state.latitude += dLat * a;
  state.altitude += ((target.altitude ?? 0) - state.altitude) * a;
  return state;
}

/** The median of a list of numbers (NaN for none). */
export function median(list) {
  if (!list.length) return NaN;
  const s = [...list].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
