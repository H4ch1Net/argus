// Launch replay maths: a RECONSTRUCTED ESTIMATE of a launch's ascent and orbit
// from its Launch Library 2 record (pad, orbit name, mission timeline). Nothing
// here is tracking data: LL2 publishes no trajectory, so the climb, the
// insertion point and the orbit are modelled, and every result says so
// (`estimate: true`, `label`). Adapted from gods-eye-view
// src/layers/launches/paths.js, replay.js and policy.js (MIT).
//
// Pure: no Cesium. Paths are arrays of { longitude, latitude, altitude }
// (degrees, degrees, metres) on a spherical Earth, the same convention as the
// SDK's great-circle arcs; a renderer turns them into Cartesians.

import { parseIsoDuration } from './parse.js';

export const REPLAY_LABEL = 'RECONSTRUCTED ESTIMATE';

export const REPLAY = Object.freeze({
  ascentFallbackSec: 12, // replay seconds for a typical 10-minute ascent
  ascentMinSec: 8,
  ascentMaxSec: 36,
  orbitSec: 28, // one estimated orbit, compressed
  settleSec: 5, // let imagery and terrain tiles load at the pad
  countdownSec: 10, // "T minus N" before liftoff
  speedMin: 0.25,
  speedMax: 4,
  speedStep: 0.25,
});

const R_EARTH_M = 6_371_000; // spherical surface (as core/layers/sdk/greatCircle.js)
const R_ORBIT_BASE_M = 6_378_137; // orbit radius = equatorial radius + altitude
const MU = 3.986004418e14; // m^3 / s^2
const EARTH_ROTATION_RAD_PER_SEC = (2 * Math.PI) / 86164.0905;
const ASCENT_ROTATION_SEC = 600; // eastward lead accumulated over a ~10 min ascent
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export const ORBIT_ALTITUDE_M = Object.freeze({
  LEO: 550_000,
  MEO: 20_200_000,
  GEO: 35_786_000,
});

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// --- vectors on the unit sphere ----------------------------------------------

const unit = (lon, lat) => {
  const la = lat * D2R;
  const lo = lon * D2R;
  return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
};
const toLonLat = ([x, y, z]) => ({
  longitude: Math.atan2(y, x) * R2D,
  latitude: Math.asin(clamp(z / Math.hypot(x, y, z), -1, 1)) * R2D,
});
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a) => scale(a, 1 / Math.hypot(a[0], a[1], a[2]));
const wrapLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

// --- timeline -------------------------------------------------------------------

const DEPLOY = /deploy|payload sep|spacecraft sep|orbit(al)? insertion|injection/i;
const SECO = /\bseco\b|seco-|second engine cut/i;

/**
 * Seconds from liftoff to orbit insertion, from the mission timeline: the latest
 * deploy / separation / insertion event, else the latest second-stage cutoff,
 * else the latest event. Null when the timeline has no usable event.
 * @param {{ name: string, description?: string, offsetSeconds?: number, relative_time?: string }[]} timeline
 */
export function insertionOffsetSeconds(timeline) {
  const events = (Array.isArray(timeline) ? timeline : [])
    .map((e) => ({
      label: `${e?.name ?? ''} ${e?.description ?? ''}`,
      t: Number.isFinite(e?.offsetSeconds)
        ? e.offsetSeconds
        : parseIsoDuration(e?.relative_time),
    }))
    .filter((e) => Number.isFinite(e.t) && e.t >= 0);
  if (!events.length) return null;
  const latest = (list) => Math.max(...list.map((e) => e.t));
  const deploy = events.filter((e) => DEPLOY.test(e.label));
  if (deploy.length) return latest(deploy);
  const cutoff = events.filter((e) => SECO.test(e.label));
  if (cutoff.length) return latest(cutoff);
  return latest(events);
}

// --- the estimated orbit ----------------------------------------------------------

/** Orbit altitude (m) by LL2 orbit name; null for a suborbital flight or no name. */
export function orbitAltitudeM(orbitName) {
  const o = String(orbitName ?? '').toLowerCase();
  if (!o || /sub-?orbital/.test(o)) return null;
  if (
    o.includes('geostationary') ||
    o.includes('geosynchronous') ||
    o.includes('transfer')
  )
    return ORBIT_ALTITUDE_M.GEO;
  if (o.includes('medium')) return ORBIT_ALTITUDE_M.MEO;
  return ORBIT_ALTITUDE_M.LEO; // low orbits, and the parking orbit for anything beyond
}

/** Circular-orbit period (seconds) at an altitude. */
export const orbitPeriodSeconds = (altitudeM) =>
  2 * Math.PI * Math.sqrt((R_ORBIT_BASE_M + altitudeM) ** 3 / MU);

/**
 * Launch azimuth (degrees from north): due east, except polar and
 * sun-synchronous launches (south from the northern hemisphere, north from the
 * southern) and western North America (Vandenberg flies south-southwest).
 */
export function launchAzimuthDeg({ latitude, longitude, orbitName }) {
  const o = String(orbitName ?? '').toLowerCase();
  if (o.includes('polar') || o.includes('sun')) return latitude >= 0 ? 180 : 0;
  if (latitude > 20 && latitude < 60 && longitude > -140 && longitude < -105) return 190;
  return 90;
}

/**
 * A circular orbit through a point a little downrange of the pad (8 deg for
 * polar, 12 deg otherwise), so a top-down view does not draw the ring over the
 * pad. Index 0 is that insertion point; the ring is closed (last == first).
 * @param {{ latitude: number, longitude: number, orbitName: string }} launch
 * @returns {{ points: object[], altitudeM: number, azimuthDeg: number, periodSec: number } | null}
 */
export function estimatedOrbitPath(
  { latitude, longitude, orbitName },
  { samples = 96 } = {},
) {
  const altitudeM = orbitAltitudeM(orbitName);
  if (altitudeM === null || !Number.isFinite(latitude) || !Number.isFinite(longitude))
    return null;
  const lat = latitude * D2R;
  const lon = longitude * D2R;
  const up = unit(longitude, latitude);
  const east = [-Math.sin(lon), Math.cos(lon), 0];
  const north = [
    -Math.sin(lat) * Math.cos(lon),
    -Math.sin(lat) * Math.sin(lon),
    Math.cos(lat),
  ];
  const azimuthDeg = launchAzimuthDeg({ latitude, longitude, orbitName });
  const az = azimuthDeg * D2R;
  const forward = norm(add(scale(north, Math.cos(az)), east, Math.sin(az)));
  const polar = /polar|sun/i.test(orbitName);
  const arc = (polar ? 8 : 12) * D2R;
  const anchor = norm(add(scale(up, Math.cos(arc)), forward, Math.sin(arc)));
  const normal = norm(cross(anchor, forward));
  const along = norm(cross(normal, anchor));
  const points = [];
  for (let i = 0; i <= samples; i++) {
    const th = ((i % samples) / samples) * 2 * Math.PI;
    const p = add(scale(anchor, Math.cos(th)), along, Math.sin(th));
    points.push({ ...toLonLat(p), altitude: altitudeM });
  }
  return { points, altitudeM, azimuthDeg, periodSec: orbitPeriodSeconds(altitudeM) };
}

// --- the reconstructed ascent ----------------------------------------------------

/**
 * One continuous climb from the pad to the insertion point. Horizontal progress
 * follows p^4 (a near-vertical liftoff that pitches over late), altitude follows
 * sin(p * pi / 2), and the track leads eastward by the Earth's rotation during
 * the climb (an envelope that peaks in the upper ascent and returns to zero, so
 * it still ends exactly at the insertion point).
 * @param {{ longitude: number, latitude: number, altitude?: number }} pad
 * @param {{ longitude: number, latitude: number, altitude: number }} insertion
 */
export function reconstructedAscentPath(pad, insertion, samples = 256) {
  const a = unit(pad.longitude, pad.latitude);
  const b = unit(insertion.longitude, insertion.latitude);
  const omega = Math.acos(clamp(dot3(a, b), -1, 1));
  const h0 = Math.max(0, pad.altitude ?? 0);
  const h1 = Math.max(0, insertion.altitude ?? 0);
  const out = [];
  for (let i = 0; i <= samples; i++) {
    const p = i / samples;
    if (i === 0) {
      out.push({ longitude: pad.longitude, latitude: pad.latitude, altitude: h0 });
      continue;
    }
    if (i === samples) {
      out.push({
        longitude: insertion.longitude,
        latitude: insertion.latitude,
        altitude: h1,
      });
      continue;
    }
    const f = p ** 4;
    let v;
    if (omega < 1e-9) v = a;
    else {
      const s = Math.sin(omega);
      v = add(scale(a, Math.sin((1 - f) * omega) / s), b, Math.sin(f * omega) / s);
    }
    const ll = toLonLat(v);
    const lead =
      EARTH_ROTATION_RAD_PER_SEC * ASCENT_ROTATION_SEC * Math.sin(Math.PI * p ** 3);
    out.push({
      longitude: wrapLon(ll.longitude + lead * R2D),
      latitude: ll.latitude,
      altitude: h0 + (h1 - h0) * Math.sin((p * Math.PI) / 2),
    });
  }
  return out;
}

// --- paths ------------------------------------------------------------------------

const toVec = (p) => scale(unit(p.longitude, p.latitude), R_EARTH_M + (p.altitude ?? 0));
const dist = (a, b) => {
  const u = toVec(a);
  const v = toVec(b);
  return Math.hypot(u[0] - v[0], u[1] - v[1], u[2] - v[2]);
};

/** Path length in metres (chord sum). */
export function pathLengthM(path) {
  let total = 0;
  for (let i = 1; i < (path?.length ?? 0); i++) total += dist(path[i - 1], path[i]);
  return total;
}

/** Index of the path point closest in direction to `point`. */
export function nearestIndex(path, point) {
  if (!path?.length || !point) return 0;
  const r = unit(point.longitude, point.latitude);
  let best = 0;
  let bestDot = -Infinity;
  path.forEach((p, i) => {
    const d = dot3(r, unit(p.longitude, p.latitude));
    if (d > bestDot) {
      bestDot = d;
      best = i;
    }
  });
  return best;
}

/** A closed ring re-started at `index` (and closed again). */
export function rotateRing(path, index) {
  if (!path?.length) return [];
  const closed = path.length > 2 && dist(path[0], path.at(-1)) < 1000;
  const core = closed ? path.slice(0, -1) : path.slice();
  const k = ((index % core.length) + core.length) % core.length;
  const out = [...core.slice(k), ...core.slice(0, k)];
  out.push(out[0]);
  return out;
}

const lengthCache = new WeakMap();

/** The point at fraction `progress` (0..1) of a path's length. */
export function samplePath(path, progress) {
  if (!path?.length) return null;
  if (path.length === 1) return { ...path[0] };
  let cum = lengthCache.get(path);
  if (!cum) {
    cum = new Float64Array(path.length);
    for (let i = 1; i < path.length; i++)
      cum[i] = cum[i - 1] + dist(path[i - 1], path[i]);
    lengthCache.set(path, cum);
  }
  const total = cum[cum.length - 1];
  if (!(total > 0)) return { ...path[0] };
  const target = clamp(progress, 0, 1) * total;
  let lo = 1;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  const i = Math.max(0, lo - 1);
  const seg = cum[i + 1] - cum[i];
  const k = seg > 0 ? (target - cum[i]) / seg : 0;
  const a = path[i];
  const b = path[i + 1];
  let dLon = b.longitude - a.longitude;
  if (dLon > 180) dLon -= 360;
  else if (dLon < -180) dLon += 360;
  return {
    longitude: wrapLon(a.longitude + dLon * k),
    latitude: a.latitude + (b.latitude - a.latitude) * k,
    altitude: (a.altitude ?? 0) + ((b.altitude ?? 0) - (a.altitude ?? 0)) * k,
  };
}

// --- replay timing ------------------------------------------------------------------

/**
 * Replay seconds for the ascent: 12 s per 10 real minutes, clamped to 8-36 s.
 * The real ascent is the timeline's insertion offset when LL2 discloses one,
 * else estimated from the path length (about 9 km/s, at least 3 minutes).
 */
export function ascentReplaySeconds(insertionOffsetSec, ascentLengthM = 0) {
  let real = insertionOffsetSec > 0 ? insertionOffsetSec : null;
  if (!real && ascentLengthM > 0) real = Math.max(180, ascentLengthM / 9000);
  if (!real) real = REPLAY.ascentFallbackSec * 50;
  return clamp(
    REPLAY.ascentFallbackSec * (real / 600),
    REPLAY.ascentMinSec,
    REPLAY.ascentMaxSec,
  );
}

/** Clamp and snap a playback speed to 0.25x..4x in 0.25 steps. */
export function normalizeReplaySpeed(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return 1;
  const c = clamp(v, REPLAY.speedMin, REPLAY.speedMax);
  return Math.round(c / REPLAY.speedStep) * REPLAY.speedStep;
}

/** When a replay begins at beginMs: tiles settle, the countdown runs, then liftoff. */
export const replaySchedule = (beginMs) => ({
  countdownAt: beginMs + REPLAY.settleSec * 1000,
  liftoffAt: beginMs + (REPLAY.settleSec + REPLAY.countdownSec) * 1000,
});

/** Shift the liftoff anchor by the time spent paused, so elapsed time is kept. */
export function replayStartAfterPause(liftoffAt, pausedAt, resumedAt) {
  if (![liftoffAt, pausedAt, resumedAt].every(Number.isFinite)) return liftoffAt;
  return liftoffAt + Math.max(0, resumedAt - pausedAt);
}

/** Re-anchor liftoff when the speed changes mid-replay, so the marker does not jump. */
export function rebaseForSpeed(liftoffAt, nowMs, oldSpeed, newSpeed) {
  const a = normalizeReplaySpeed(oldSpeed);
  const b = normalizeReplaySpeed(newSpeed);
  if (nowMs <= liftoffAt) return liftoffAt;
  return nowMs - ((nowMs - liftoffAt) * a) / b;
}

/**
 * Where the replay is at nowMs.
 * @param {Object} o
 * @param {number} o.liftoffAt         replay liftoff (wall clock ms), from replaySchedule
 * @param {number} o.ascentSec         from ascentReplaySeconds
 * @param {number} [o.orbitSec]        REPLAY.orbitSec
 * @param {number} [o.orbitPeriodSec]  real period, for the mission clock in orbit
 * @param {number|null} [o.insertionOffsetSec] real seconds to insertion (mission clock)
 * @param {number|null} [o.launchEpochMs]      the real liftoff (LL2 net), for event times
 * @param {number} [o.speed=1]
 * @param {number} o.nowMs
 * @param {boolean} [o.loop=true]
 * @returns {{ phase: 'settle'|'countdown'|'ascent'|'orbit', countdownSeconds: number,
 *   progress: number, missionOffsetSec: number|null, eventTimeMs: number|null, elapsedSec: number }}
 *   progress is 0..1 within the current phase (sample the ascent or orbit path with it)
 */
export function replayState({
  liftoffAt,
  ascentSec,
  orbitSec = REPLAY.orbitSec,
  orbitPeriodSec = null,
  insertionOffsetSec = null,
  launchEpochMs = null,
  speed = 1,
  nowMs,
  loop = true,
}) {
  const s = (nowMs - liftoffAt) / 1000;
  if (s < 0) {
    const counting = s >= -REPLAY.countdownSec;
    return {
      phase: counting ? 'countdown' : 'settle',
      countdownSeconds: counting ? Math.ceil(-s) : 0,
      progress: 0,
      missionOffsetSec: s,
      eventTimeMs: Number.isFinite(launchEpochMs) ? launchEpochMs + s * 1000 : null,
      elapsedSec: 0,
    };
  }
  const total = ascentSec + orbitSec;
  const run = s * normalizeReplaySpeed(speed);
  const elapsed = loop ? run % total : Math.min(run, Math.max(0, total - 1e-6));
  const ascending = elapsed < ascentSec;
  const progress = ascending ? elapsed / ascentSec : (elapsed - ascentSec) / orbitSec;
  let missionOffsetSec = null;
  if (insertionOffsetSec !== null && Number.isFinite(insertionOffsetSec)) {
    missionOffsetSec = ascending
      ? progress * insertionOffsetSec
      : insertionOffsetSec + progress * (orbitPeriodSec ?? 0);
  }
  return {
    phase: ascending ? 'ascent' : 'orbit',
    countdownSeconds: 0,
    progress,
    missionOffsetSec,
    eventTimeMs:
      Number.isFinite(launchEpochMs) && missionOffsetSec !== null
        ? launchEpochMs + missionOffsetSec * 1000
        : null,
    elapsedSec: run,
  };
}

/** Mission clock: "T+08:42", "T-00:05", "T+1:02:10". */
export function formatMissionClock(offsetSec) {
  if (!Number.isFinite(offsetSec)) return 'T+--:--';
  const sign = offsetSec < 0 ? '-' : '+';
  const t = Math.floor(Math.abs(offsetSec));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  const pad = (v) => String(v).padStart(2, '0');
  return h ? `T${sign}${h}:${pad(m)}:${pad(sec)}` : `T${sign}${pad(m)}:${pad(sec)}`;
}

// --- everything at once -----------------------------------------------------------

/**
 * Build the replay for one launch (from parseLaunchDetail). Failed and
 * suborbital launches get no orbit, so no replay.
 * @param {ReturnType<import('./parse.js').parseLaunchDetail>} launch
 * @param {{ orbitPath?: object[], samples?: number }} [opts] orbitPath: a real
 *   orbit ring (e.g. a matched payload's propagated track) to use instead of the
 *   estimate; the ascent then joins it at the point nearest the estimated insertion.
 * @returns {{ ok: true, estimate: true, label: string, ascent: object[], orbit: object[],
 *   orbitAltitudeM: number, orbitPeriodSec: number, azimuthDeg: number,
 *   insertionOffsetSec: number|null, ascentSec: number, orbitSec: number }
 *   | { ok: false, reason: string }}
 */
export function buildReplay(launch, { orbitPath = null, samples = 256 } = {}) {
  if (!launch) return { ok: false, reason: 'no launch record' };
  if (launch.failed)
    return { ok: false, reason: 'launch failed: no orbit to reconstruct' };
  const { latitude, longitude } = launch.pad ?? {};
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { ok: false, reason: 'pad has no coordinates' };
  }
  const est = estimatedOrbitPath({ latitude, longitude, orbitName: launch.orbit });
  if (!est) return { ok: false, reason: 'no orbit (suborbital or unknown)' };
  let orbit = est.points;
  if (Array.isArray(orbitPath) && orbitPath.length > 2) {
    orbit = rotateRing(orbitPath, nearestIndex(orbitPath, est.points[0]));
  }
  const insertion = orbit[0];
  const ascent = reconstructedAscentPath(
    { latitude, longitude, altitude: 0 },
    insertion,
    samples,
  );
  const insertionOffsetSec = insertionOffsetSeconds(launch.timeline);
  const altitudeM = insertion.altitude ?? est.altitudeM;
  return {
    ok: true,
    estimate: true,
    label: REPLAY_LABEL,
    ascent,
    orbit,
    orbitAltitudeM: altitudeM,
    orbitPeriodSec: orbitPeriodSeconds(altitudeM),
    azimuthDeg: est.azimuthDeg,
    insertionOffsetSec,
    ascentSec: ascentReplaySeconds(insertionOffsetSec, pathLengthM(ascent)),
    orbitSec: REPLAY.orbitSec,
  };
}
