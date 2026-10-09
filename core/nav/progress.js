// The progress engine: where a GPS fix is on the route being driven, which
// maneuver comes next and how far it is, what remains (distance, time, ETA,
// signals), and when the vehicle has left the route or arrived. Pure (no
// Cesium, no DOM, no clock of its own): every shell shares it.
//
//   Snapping: the fix goes to the closest point of the route line, searched
//   first in a window from 200 m behind the last position to 3 km ahead (so a
//   route that doubles back on itself does not jump), then over the whole
//   line when the window finds nothing within 60 m.
//   Off route: more than 40 m from the line for 3 fixes in a row (fixes worse
//   than 100 m accuracy count for neither side).
//   Arrived: within 25 m of the end, along the route or in a straight line.
//   Time left: the provider's time for the rest of the current step, pro rata,
//   plus every later step's time, plus the expected wait at each signal ahead.

import { cumulative, haversineM, snapToLine, pointAlong } from './geo.js';
import { perSignalDelayS } from './signals.js';

export const OFF_ROUTE_M = 40;
export const OFF_ROUTE_FIXES = 3;
export const ARRIVE_M = 25;
export const POOR_ACCURACY_M = 100;
const WINDOW_BACK_M = 200;
const WINDOW_AHEAD_M = 3000;
const WINDOW_MISS_M = 60;

/** Per-route lookups, built once per route: { line, cum, total, stepStart }. */
export function prepareRoute(route) {
  const line = route.geometry;
  const cum = cumulative(line);
  const total = cum[cum.length - 1] || 0;
  const steps = route.steps ?? [];
  const stepStart = new Float64Array(steps.length);
  for (let k = 0; k < steps.length; k += 1) {
    const i = Math.max(0, Math.min(line.length - 1, steps[k].geometryIndex | 0));
    stepStart[k] = cum[i];
  }
  // The arrival is at the end of the line, whatever its index says.
  if (steps.length && steps[steps.length - 1].maneuver?.type === 'arrive')
    stepStart[steps.length - 1] = total;
  return { line, cum, total, stepStart };
}

/** Vertex index range covering [from, to] metres along the route. */
function windowFor(cum, lastIndex, fromM, toM) {
  const n = cum.length;
  let a = Math.max(0, Math.min(n - 2, lastIndex));
  while (a > 0 && cum[a] > fromM) a -= 1;
  let b = Math.max(a + 1, lastIndex + 1);
  while (b < n - 1 && cum[b] < toM) b += 1;
  return [a, b];
}

/**
 * One engine per route being driven.
 * @param {object} route  a navigation Route
 * @param {{ now?: () => number }} [opts]
 */
export function createProgress(route, { now = () => Date.now() } = {}) {
  const prep = prepareRoute(route);
  const { line, cum, total, stepStart } = prep;
  const steps = route.steps ?? [];
  const end = line[line.length - 1];
  const snap = {};
  const wide = {};
  const ahead = {};
  let lastIndex = 0;
  let lastAlong = 0;
  let offCount = 0;
  let started = false;

  /** The first step whose maneuver lies ahead of `along` (the arrival at the end). */
  function upcoming(along) {
    for (let k = 1; k < steps.length; k += 1) if (stepStart[k] > along) return k;
    return Math.max(0, steps.length - 1);
  }

  function remainingTime(along, k) {
    let t = 0;
    if (k > 0) {
      const span = stepStart[k] - stepStart[k - 1];
      const frac = span > 0 ? Math.max(0, Math.min(1, (stepStart[k] - along) / span)) : 0;
      t += (steps[k - 1].durationS || 0) * frac;
    }
    for (let j = k; j < steps.length; j += 1) t += steps[j].durationS || 0;
    return t;
  }

  // Read from the route each time: the signal count may land after the route
  // started (Overpass is slower than the router).
  function signalsAheadOf(along) {
    const signals = Array.isArray(route.signalsAlongM) ? route.signalsAlongM : [];
    let n = 0;
    for (let i = signals.length - 1; i >= 0 && signals[i] > along; i -= 1) n += 1;
    return n;
  }

  function build(along, offRoute, snapped) {
    const k = upcoming(along);
    const sa = signalsAheadOf(along);
    const wait = sa * perSignalDelayS(route);
    const durationRemainingS = Math.max(0, Math.round(remainingTime(along, k) + wait));
    const progress = {
      alongM: Math.round(along),
      distanceRemainingM: Math.max(0, Math.round(total - along)),
      durationRemainingS,
      eta: now() + durationRemainingS * 1000,
      stepIndex: k,
      distanceToStepM: Math.max(0, Math.round(stepStart[k] - along)),
      step: steps[k],
      offRoute,
      snapped,
    };
    if (Array.isArray(route.signalsAlongM)) progress.signalsAhead = sa;
    if (steps[k + 1]) progress.then = steps[k + 1];
    return progress;
  }

  return {
    route,
    prep,
    /** Progress before any fix: at the start of the route. */
    initial() {
      return build(0, false, { lat: line[0][1], lon: line[0][0] });
    },
    /**
     * Feed one fix. Returns { progress, arrived, offRoute }.
     * @param {{ lat: number, lon: number, accuracy?: number }} fix
     */
    update(fix) {
      const [a, b] = windowFor(
        cum,
        lastIndex,
        lastAlong - WINDOW_BACK_M,
        lastAlong + WINDOW_AHEAD_M,
      );
      let s = snapToLine(line, cum, fix.lat, fix.lon, { from: a, to: b }, snap);
      if (s.offM > WINDOW_MISS_M || !started) {
        const w = snapToLine(line, cum, fix.lat, fix.lon, {}, wide);
        if (w.offM + 5 < s.offM) s = w;
      }
      started = true;
      const poor = Number.isFinite(fix.accuracy) && fix.accuracy > POOR_ACCURACY_M;
      if (!poor) offCount = s.offM > OFF_ROUTE_M ? offCount + 1 : 0;
      const offRoute = offCount >= OFF_ROUTE_FIXES;
      if (!offRoute) {
        lastIndex = s.index;
        lastAlong = s.along;
      }
      const along = offRoute ? lastAlong : s.along;
      const toEnd = haversineM(fix.lat, fix.lon, end[1], end[0]);
      const arrived =
        !offRoute &&
        (total - along < ARRIVE_M || toEnd < ARRIVE_M) &&
        s.offM < OFF_ROUTE_M;
      return {
        progress: build(along, offRoute, { lat: s.lat, lon: s.lon }),
        arrived,
        offRoute,
      };
    },
    /** Where the vehicle would be `m` metres along the route: { lat, lon, heading }. */
    pointAt(m, out = ahead) {
      return pointAlong(line, cum, m, out, lastIndex);
    },
    get along() {
      return lastAlong;
    },
  };
}
