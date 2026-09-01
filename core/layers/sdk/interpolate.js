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
