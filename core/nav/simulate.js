// A simulated trip along a route: the fix a vehicle would report t seconds
// after leaving, moving at each step's own pace (the router's distance over
// its time), heading along the line. Pure: the SIM button in the panels and
// the tests drive the navigator with it on a desk with no GPS.

import { prepareRoute } from './progress.js';
import { pointAlong } from './geo.js';

/**
 * @param {object} route a navigation Route
 * @param {{ timeScale?: number }} [opts] timeScale 4: four times real speed
 * @returns {{ durationS: number, fixAt: (seconds: number, t?: number) => object }}
 */
export function createDriveSim(route, { timeScale = 1 } = {}) {
  const prep = prepareRoute(route);
  const steps = route.steps ?? [];
  // Time at each step's start, from the router's own step times (at least
  // 1 m/s and at most 40 m/s, so a zero-time step still moves).
  const t0 = new Float64Array(steps.length + 1);
  const spans = [];
  for (let k = 0; k < steps.length; k += 1) {
    const a = prep.stepStart[k];
    const b = k + 1 < steps.length ? prep.stepStart[k + 1] : prep.total;
    const len = Math.max(0, b - a);
    const speed = Math.min(40, Math.max(1, len / Math.max(1, steps[k].durationS || 0)));
    spans.push({ a, len, speed });
    t0[k + 1] = t0[k] + len / speed;
  }
  const durationS = t0[steps.length] / timeScale;
  const out = {};
  return {
    durationS,
    fixAt(seconds, t = Date.now()) {
      const s = Math.max(0, seconds) * timeScale;
      let k = 0;
      while (k < spans.length - 1 && t0[k + 1] <= s) k += 1;
      const span = spans[k] ?? { a: 0, len: 0, speed: 0 };
      const along = Math.min(prep.total, span.a + (s - t0[k]) * span.speed);
      const p = pointAlong(prep.line, prep.cum, along, out);
      return {
        lat: p.lat,
        lon: p.lon,
        heading: p.heading,
        speed: along >= prep.total ? 0 : span.speed,
        accuracy: 5,
        t,
      };
    },
  };
}
