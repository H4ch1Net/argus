// Navigation helpers for the car shell: pure (no Cesium, no DOM), tested in
// nav.test.js. They turn the navigator's state (core/nav/navigator.js) into
// what the Android Auto host shows (android/.../car/CarNav.kt): maneuvers in
// the Car App Library's vocabulary with a ctOS glyph each, distances in the
// units a driver reads, the payloads of the car page bridge and when to send
// them, and the route geometry the view needs (where the vehicle is along the
// route, what lies ahead of it). Angles in degrees clockwise from north,
// distances in metres, durations in seconds, times in epoch milliseconds.

import { bearingDeg, clamp, distanceM, formatDistance } from './model.js';

// ------------------------------------------------------------- maneuvers
/**
 * androidx.car.app.navigation.model.Maneuver.TYPE_* (Car App Library 1.4.0).
 * These numbers are the host protocol, so they are stable; CarNav.kt checks
 * each one again before building a Maneuver.
 */
export const CAR_MANEUVER = Object.freeze({
  UNKNOWN: 0,
  DEPART: 1,
  NAME_CHANGE: 2,
  KEEP_LEFT: 3,
  KEEP_RIGHT: 4,
  TURN_SLIGHT_LEFT: 5,
  TURN_SLIGHT_RIGHT: 6,
  TURN_NORMAL_LEFT: 7,
  TURN_NORMAL_RIGHT: 8,
  TURN_SHARP_LEFT: 9,
  TURN_SHARP_RIGHT: 10,
  U_TURN_LEFT: 11,
  U_TURN_RIGHT: 12,
  ON_RAMP_SLIGHT_LEFT: 13,
  ON_RAMP_SLIGHT_RIGHT: 14,
  ON_RAMP_NORMAL_LEFT: 15,
  ON_RAMP_NORMAL_RIGHT: 16,
  ON_RAMP_SHARP_LEFT: 17,
  ON_RAMP_SHARP_RIGHT: 18,
  ON_RAMP_U_TURN_LEFT: 19,
  ON_RAMP_U_TURN_RIGHT: 20,
  OFF_RAMP_SLIGHT_LEFT: 21,
  OFF_RAMP_SLIGHT_RIGHT: 22,
  OFF_RAMP_NORMAL_LEFT: 23,
  OFF_RAMP_NORMAL_RIGHT: 24,
  FORK_LEFT: 25,
  FORK_RIGHT: 26,
  MERGE_LEFT: 27,
  MERGE_RIGHT: 28,
  MERGE_SIDE_UNSPECIFIED: 29,
  ROUNDABOUT_ENTER_AND_EXIT_CW: 32,
  ROUNDABOUT_ENTER_AND_EXIT_CCW: 34,
  STRAIGHT: 36,
  DESTINATION: 39,
  DESTINATION_STRAIGHT: 40,
  DESTINATION_LEFT: 41,
  DESTINATION_RIGHT: 42,
  ROUNDABOUT_ENTER_CW: 43,
  ROUNDABOUT_EXIT_CW: 44,
  ROUNDABOUT_ENTER_CCW: 45,
  ROUNDABOUT_EXIT_CCW: 46,
});

// Where traffic keeps left. A step's own driving side (OSRM sends one) wins;
// this is the fallback, by the phone's region.
const LEFT_HAND = new Set(
  'AU BD BN BS BT BW CY FJ GB GG GY HK ID IE IM IN JE JM JP KE LK LS MO MT MU MW MY MZ NA NP NZ PK SG SR SZ TH TT TZ UG ZA ZM ZW'.split(
    ' ',
  ),
);

/** 'left' where traffic keeps left (by the locale's region), else 'right'. */
export function drivingSideFor(locale) {
  const region = String(locale || '')
    .split(/[-_]/)
    .slice(1)
    .find((p) => /^[A-Za-z]{2}$/.test(p));
  return region && LEFT_HAND.has(region.toUpperCase()) ? 'left' : 'right';
}

// A modifier's side and strength: 'sharp right' -> { side: 'right', bend: 3 }.
function bend(modifier) {
  const m = String(modifier || '').toLowerCase();
  if (m === 'uturn') return { side: null, bend: 4 };
  const side = m.includes('left') ? 'left' : m.includes('right') ? 'right' : null;
  if (!side) return { side: null, bend: 0 };
  return { side, bend: m.startsWith('sharp') ? 3 : m.startsWith('slight') ? 1 : 2 };
}

const TURNS = {
  left: [null, 'TURN_SLIGHT_LEFT', 'TURN_NORMAL_LEFT', 'TURN_SHARP_LEFT'],
  right: [null, 'TURN_SLIGHT_RIGHT', 'TURN_NORMAL_RIGHT', 'TURN_SHARP_RIGHT'],
};
const TURN_ICONS = {
  left: [null, 'slight_left', 'turn_left', 'sharp_left'],
  right: [null, 'slight_right', 'turn_right', 'sharp_right'],
};

const out = (name, icon, extra) => ({ type: CAR_MANEUVER[name], icon, ...extra });

// A plain turn by its modifier (also the fallback for unknown types).
function turn(b, roadSide, straight = 'STRAIGHT') {
  if (b.bend === 4) {
    // A U-turn crosses the oncoming traffic: to the left where it keeps right.
    return roadSide === 'left'
      ? out('U_TURN_RIGHT', 'uturn_right')
      : out('U_TURN_LEFT', 'uturn_left');
  }
  if (!b.side) return out(straight, 'straight');
  return out(TURNS[b.side][b.bend], TURN_ICONS[b.side][b.bend]);
}

/**
 * A navigator maneuver (OSRM vocabulary: { type, modifier?, exit? }) as the
 * Car App Library shows it: { type: Maneuver.TYPE_*, icon, exitNumber? }.
 * `icon` names a MANEUVER_ICONS glyph (ic_nav_<icon> on Android).
 * @param {{ type?: string, modifier?: string, exit?: number }} maneuver
 * @param {{ side?: 'left'|'right' }} [opts]  the side traffic keeps to
 */
export function carManeuver(maneuver, { side = 'right' } = {}) {
  const type = String(maneuver?.type || '').toLowerCase();
  const b = bend(maneuver?.modifier);
  const exit = Number(maneuver?.exit);
  const hasExit = Number.isInteger(exit) && exit >= 1 && exit <= 99;
  const cw = side === 'left'; // roundabouts turn clockwise where traffic keeps left
  const ring = cw ? 'roundabout_cw' : 'roundabout_ccw';
  switch (type) {
    case 'depart':
      return out('DEPART', 'depart');
    case 'arrive':
      if (b.side === 'left') return out('DESTINATION_LEFT', 'arrive_left');
      if (b.side === 'right') return out('DESTINATION_RIGHT', 'arrive_right');
      if (String(maneuver?.modifier || '') === 'straight')
        return out('DESTINATION_STRAIGHT', 'arrive');
      return out('DESTINATION', 'arrive');
    case 'roundabout':
    case 'rotary':
      return hasExit
        ? out(
            cw ? 'ROUNDABOUT_ENTER_AND_EXIT_CW' : 'ROUNDABOUT_ENTER_AND_EXIT_CCW',
            ring,
            {
              exitNumber: exit,
            },
          )
        : out(cw ? 'ROUNDABOUT_ENTER_CW' : 'ROUNDABOUT_ENTER_CCW', ring);
    case 'exit roundabout':
    case 'exit rotary':
      return out(cw ? 'ROUNDABOUT_EXIT_CW' : 'ROUNDABOUT_EXIT_CCW', ring);
    case 'merge':
      if (b.side === 'left') return out('MERGE_LEFT', 'merge_left');
      if (b.side === 'right') return out('MERGE_RIGHT', 'merge_right');
      return out('MERGE_SIDE_UNSPECIFIED', 'merge');
    case 'on ramp': {
      if (b.bend === 4)
        return side === 'left'
          ? out('ON_RAMP_U_TURN_RIGHT', 'uturn_right')
          : out('ON_RAMP_U_TURN_LEFT', 'uturn_left');
      // No side given: the ramp is on the side traffic keeps to.
      const s = b.side ?? side;
      const strength = ['SLIGHT', 'SLIGHT', 'NORMAL', 'SHARP'][b.side ? b.bend : 1];
      return out(`ON_RAMP_${strength}_${s.toUpperCase()}`, `ramp_${s}`);
    }
    case 'off ramp': {
      const s = b.side ?? side;
      const strength = b.side && b.bend >= 2 ? 'NORMAL' : 'SLIGHT';
      return out(`OFF_RAMP_${strength}_${s.toUpperCase()}`, `ramp_${s}`);
    }
    case 'fork':
      if (b.side === 'left') return out('FORK_LEFT', 'fork_left');
      if (b.side === 'right') return out('FORK_RIGHT', 'fork_right');
      return out('STRAIGHT', 'straight');
    case 'use lane':
    case 'keep':
      if (b.side === 'left') return out('KEEP_LEFT', 'fork_left');
      if (b.side === 'right') return out('KEEP_RIGHT', 'fork_right');
      return out('STRAIGHT', 'straight');
    case 'new name':
      return b.side ? turn(b, side) : out('NAME_CHANGE', 'straight');
    case 'turn':
    case 'end of road':
    case 'continue':
    case 'roundabout turn':
    case 'notification':
      return turn(b, side);
    default:
      return b.side || b.bend === 4 ? turn(b, side) : out('UNKNOWN', 'straight');
  }
}

// --------------------------------------------------------------- distance
/**
 * A distance as a driver reads it, in the Car App Library's display units
 * (CarNav.kt maps `unit` to Distance.UNIT_*): metres in steps of 10 or 50,
 * then kilometres with one decimal under 10 km; feet in steps of 50 under a
 * tenth of a mile, then miles with one decimal under 10.
 * @returns {{ value: number, unit: 'm'|'km'|'km_p1'|'ft'|'mi'|'mi_p1' }}
 */
export function carDistance(m, units = 'metric') {
  const d = Number.isFinite(m) ? Math.max(0, m) : 0;
  if (units === 'imperial') {
    const mi = d / 1609.344;
    if (mi < 0.1) return { value: Math.round((d * 3.28084) / 50) * 50, unit: 'ft' };
    if (mi < 10) return { value: Math.round(mi * 10) / 10, unit: 'mi_p1' };
    return { value: Math.round(mi), unit: 'mi' };
  }
  if (d < 1000) {
    const step = d < 300 ? 10 : 50;
    const v = Math.round(d / step) * step;
    return v >= 1000 ? { value: 1, unit: 'km_p1' } : { value: v, unit: 'm' };
  }
  const km = d / 1000;
  if (km < 10) return { value: Math.round(km * 10) / 10, unit: 'km_p1' };
  return { value: Math.round(km), unit: 'km' };
}

/** '18 MIN', '1 H 05', '--' (the page's own readouts). */
export function formatDuration(s) {
  if (!Number.isFinite(s) || s < 0) return '--';
  const min = Math.max(1, Math.round(s / 60));
  if (min < 60) return `${min} MIN`;
  return `${Math.floor(min / 60)} H ${String(min % 60).padStart(2, '0')}`;
}

/** '14:32' in local time ('--:--' without one). */
export function formatClock(epochMs) {
  if (!Number.isFinite(epochMs)) return '--:--';
  const d = new Date(epochMs);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ----------------------------------------------------------------- bridge
const num = (v) => (Number.isFinite(v) ? v : null);
const text = (v, max = 160) => String(v ?? '').slice(0, max);

/**
 * Search results for the host's list (ArgusCarHost.searchResults): the
 * navigator's places in its order, each with its distance from `here`.
 */
export function searchPayload(places, here, units = 'metric', max = 8) {
  const results = [];
  for (const p of places || []) {
    if (!Number.isFinite(p?.lat) || !Number.isFinite(p?.lon)) continue;
    const d = here ? distanceM(here.lat, here.lon, p.lat, p.lon) : null;
    results.push({
      id: text(p.id ?? `${p.lat},${p.lon}`, 120),
      name: text(p.name || 'UNNAMED PLACE', 120),
      detail: text(p.detail, 160),
      kind: text(p.kind, 40),
      lat: p.lat,
      lon: p.lon,
      distanceM: num(d),
      distance: d === null ? null : carDistance(d, units),
    });
    if (results.length >= max) break;
  }
  return { results };
}

/**
 * The routes for the host's preview list (ArgusCarHost.routes), best first,
 * three at most, without their geometry (the page draws them itself).
 */
export function routesPayload(routes, units = 'metric', reqId = null) {
  return {
    reqId,
    routes: (routes || []).slice(0, 3).map((r) => ({
      id: text(r.id, 120),
      provider: text(r.provider, 20),
      summary: text(r.summary, 120),
      distanceM: num(r.distanceM),
      distance: carDistance(r.distanceM, units),
      durationS: num(r.durationS),
      trafficDelayS: num(r.trafficDelayS),
      signals: num(r.signals),
      signalDelayS: num(r.signalDelayS),
      avoidHighways: Boolean(r.avoidHighways),
      warnings: (r.warnings || []).slice(0, 3).map((w) => text(w, 120)),
    })),
  };
}

function stepPayload(step, side) {
  if (!step) return null;
  return {
    maneuver: {
      ...pick(step.maneuver),
      ...carManeuver(step.maneuver, { side: step.drivingSide || side }),
    },
    instruction: text(step.instruction),
    roadName: text(step.name, 120),
  };
}
// The navigator's own words for the maneuver ride along: `kind` (its OSRM
// type), modifier and exit; `type` is the Car App Library's number.
const pick = (m) => ({
  kind: text(m?.type, 30),
  modifier: m?.modifier ? text(m.modifier, 30) : null,
  exit: Number.isInteger(m?.exit) ? m.exit : null,
});

/**
 * The navigation state for the host (ArgusCarHost.nav): the bridge contract's
 * { status, maneuver, instruction, roadName, distanceToStepM, then?,
 * distanceRemainingM, durationRemainingS, eta } plus what the routing card
 * needs ready to show (display distances, the car maneuver type and glyph,
 * the time to the next step, the destination).
 * @param {object} state  NavState
 */
export function navPayload(state, { units = 'metric', side = 'right' } = {}) {
  const status = state?.status || 'idle';
  const dest = state?.destination
    ? {
        name: text(state.destination.name || 'DESTINATION', 120),
        detail: text(state.destination.detail),
      }
    : null;
  const p = state?.progress;
  const route = state?.route;
  if (!p || !route || !['navigating', 'rerouting', 'arrived'].includes(status)) {
    return { status, routeId: route?.id ?? null, destination: dest };
  }
  const step = stepPayload(p.step, side);
  const then = stepPayload(p.then, side);
  const stepM = num(p.distanceToStepM);
  const stepFull = p.step?.distanceM > 0 ? p.step.distanceM : null;
  // Time to the next step: the step's own duration scaled by what is left of
  // it, or the route's pace when the step has no duration.
  let stepS = null;
  if (stepM !== null && stepFull && Number.isFinite(p.step?.durationS))
    stepS = p.step.durationS * clamp(stepM / stepFull, 0, 1);
  else if (
    stepM !== null &&
    p.distanceRemainingM > 0 &&
    Number.isFinite(p.durationRemainingS)
  )
    stepS = (p.durationRemainingS * stepM) / p.distanceRemainingM;
  return {
    status,
    routeId: text(route.id, 120),
    stepIndex: Number.isInteger(p.stepIndex) ? p.stepIndex : 0,
    maneuver: step?.maneuver ?? null,
    instruction: step?.instruction ?? '',
    roadName: step?.roadName ?? '',
    // The road the vehicle is on: the one the previous step turned onto.
    currentRoad: p.stepIndex > 0 ? text(route.steps?.[p.stepIndex - 1]?.name, 120) : '',
    distanceToStepM: stepM,
    stepDistance: carDistance(stepM, units),
    timeToStepS: stepS === null ? null : Math.round(stepS),
    then,
    distanceRemainingM: num(p.distanceRemainingM),
    remaining: carDistance(p.distanceRemainingM, units),
    durationRemainingS: num(p.durationRemainingS),
    eta: num(p.eta),
    trafficDelayS: num(route.trafficDelayS),
    signalsAhead: num(p.signalsAhead),
    offRoute: Boolean(p.offRoute),
    destination: dest,
  };
}

// What makes a nav update worth sending: anything the routing card shows.
function navKey(p) {
  if (!p) return '';
  const d = (x) => (x ? `${x.value}${x.unit}` : '');
  return [
    p.status,
    p.routeId,
    p.stepIndex,
    p.maneuver?.type,
    p.maneuver?.exitNumber,
    p.instruction,
    p.roadName,
    d(p.stepDistance),
    d(p.remaining),
    Number.isFinite(p.durationRemainingS) ? Math.round(p.durationRemainingS / 60) : '',
    Number.isFinite(p.eta) ? Math.round(p.eta / 60_000) : '',
    p.then?.maneuver?.type ?? '',
    p.offRoute ? 1 : 0,
  ].join('|');
}
const stepKey = (p) => (p ? `${p.status}|${p.routeId}|${p.stepIndex}` : '');

/**
 * Pacing for nav updates to the host: at most one a second, except that a new
 * status, route or step goes at once, and nothing goes when nothing the card
 * shows has changed. decide() says 'send', 'later' (send it when the second
 * is up) or 'skip'; sent() records what went.
 */
export function createNavGate({ minMs = 1000 } = {}) {
  let last = null;
  let lastAt = -Infinity;
  return {
    decide(payload, now) {
      if (!last || stepKey(payload) !== stepKey(last)) return 'send';
      if (navKey(payload) === navKey(last)) return 'skip';
      return now - lastAt >= minMs ? 'send' : 'later';
    },
    sent(payload, now) {
      last = payload;
      lastAt = now;
    },
    /** Milliseconds until a 'later' update may go. */
    wait(now) {
      return Math.max(0, minMs - (now - lastAt));
    },
    reset() {
      last = null;
      lastAt = -Infinity;
    },
  };
}

// ----------------------------------------------------------- route shape
/**
 * A route's geometry ([lon, lat][]) indexed for distance lookups: cumulative
 * metres at every vertex.
 */
export function indexRoute(geometry) {
  const n = Array.isArray(geometry) ? geometry.length : 0;
  const lon = new Float64Array(n);
  const lat = new Float64Array(n);
  const cum = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    lon[i] = geometry[i][0];
    lat[i] = geometry[i][1];
    if (i) cum[i] = cum[i - 1] + distanceM(lat[i - 1], lon[i - 1], lat[i], lon[i]);
  }
  return { n, lon, lat, cum, total: n ? cum[n - 1] : 0 };
}

const M_PER_DEG = 111_320;

// The point of segment i nearest to (lat, lon), in a local flat frame.
function onSegment(ix, i, lat, lon) {
  const k = Math.cos((lat * Math.PI) / 180) * M_PER_DEG;
  const ax = (ix.lon[i] - lon) * k;
  const ay = (ix.lat[i] - lat) * M_PER_DEG;
  const bx = (ix.lon[i + 1] - lon) * k;
  const by = (ix.lat[i + 1] - lat) * M_PER_DEG;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? clamp(-(ax * dx + ay * dy) / len2, 0, 1) : 0;
  const px = ax + dx * t;
  const py = ay + dy * t;
  return { t, off: Math.hypot(px, py) };
}

/**
 * Where (lat, lon) lies along an indexed route: the nearest segment `index`,
 * the fraction `t` along it, metres `along` from the start, the snapped point
 * and the distance `off` the route. Searches from `hint` (the last index)
 * forward first, as a vehicle on a route mostly moves forward, then the
 * whole route when that finds nothing close.
 */
export function locateOnRoute(ix, lat, lon, hint = 0) {
  if (!ix || ix.n < 2) return null;
  const scan = (from, to) => {
    let best = null;
    for (let i = Math.max(0, from); i < Math.min(ix.n - 1, to); i++) {
      const s = onSegment(ix, i, lat, lon);
      if (!best || s.off < best.off) best = { index: i, t: s.t, off: s.off };
    }
    return best;
  };
  const h = clamp(Math.trunc(hint) || 0, 0, ix.n - 2);
  let best = scan(h - 3, h + 400);
  if (!best || best.off > 60) {
    const all = scan(0, ix.n - 1);
    if (all && (!best || all.off < best.off)) best = all;
  }
  const i = best.index;
  const segM = ix.cum[i + 1] - ix.cum[i];
  return {
    index: i,
    t: best.t,
    off: best.off,
    along: ix.cum[i] + segM * best.t,
    lat: ix.lat[i] + (ix.lat[i + 1] - ix.lat[i]) * best.t,
    lon: ix.lon[i] + (ix.lon[i + 1] - ix.lon[i]) * best.t,
  };
}

/** The point `along` metres from the route's start (clamped to its ends). */
export function pointAlong(ix, along) {
  if (!ix || ix.n === 0) return null;
  if (ix.n === 1 || along <= 0) return { lat: ix.lat[0], lon: ix.lon[0], index: 0 };
  if (along >= ix.total)
    return { lat: ix.lat[ix.n - 1], lon: ix.lon[ix.n - 1], index: ix.n - 2 };
  let lo = 0;
  let hi = ix.n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ix.cum[mid] <= along) lo = mid;
    else hi = mid;
  }
  const seg = ix.cum[hi] - ix.cum[lo];
  const t = seg > 0 ? (along - ix.cum[lo]) / seg : 0;
  return {
    lat: ix.lat[lo] + (ix.lat[hi] - ix.lat[lo]) * t,
    lon: ix.lon[lo] + (ix.lon[hi] - ix.lon[lo]) * t,
    index: lo,
  };
}

/** The route's direction `along` metres in, over the next `span` metres. */
export function bearingAlong(ix, along, span = 40) {
  const a = pointAlong(ix, along);
  const b = pointAlong(ix, along + span);
  if (!a || !b || (a.lat === b.lat && a.lon === b.lon)) return null;
  return bearingDeg(a.lat, a.lon, b.lat, b.lon);
}

/**
 * The follow view's zoom while navigating, as a factor on the usual range:
 * closer than when roaming, and closer still on the approach to a maneuver
 * (under 300 m, below motorway speed), so the turn reads at a glance.
 */
export function navZoom(distanceToStepM, speed) {
  const fast = Number.isFinite(speed) && speed > 22;
  if (!fast && Number.isFinite(distanceToStepM) && distanceToStepM < 300) return 0.38;
  return 0.55;
}

/** The page's own text for a display distance ('350 M', '1.2 KM', '0.4 MI'). */
export const formatStepDistance = (m, units) =>
  formatDistance(m, units).replace(/([0-9.])([A-Z])/, '$1 $2');
