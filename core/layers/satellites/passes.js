// Satellite pass prediction with naked-eye visibility: when a satellite next
// rises over an observer, how high it climbs, and whether it can be seen.
// Adapted from gods-eye-view src/data/satellitePass.js (MIT), whose scan pattern
// comes from skylight (MIT) shared/src/celestial.ts.
//
// Method: a 20 s coarse scan for the first sample at or above the threshold
// (10 deg), rise and set bisected to well under a second, the peak refined with
// a parabola through the fine samples around it. Visibility uses the USNO
// low-precision Sun position and a cylindrical Earth shadow: a pass is visible
// when some part of it is sunlit while the observer's Sun is at or below -6 deg
// (civil twilight or darker). 24 h search horizon by default.
//
// Pure: no satellite.js, no Cesium. The propagator is injected, so this runs in
// the terminal, in tests (with a synthetic orbit) and in the browser alike:
//   positionAt(ms) -> { longitude, latitude, altitude } | null
// in degrees, degrees and METRES (WGS84 geodetic), which is exactly what
// satellites/propagate.js satPositionAt returns:
//   findNextPass({ positionAt: (ms) => satPositionAt(satrec, new Date(ms)), observer, fromMs })
//
// Reading published orbital elements and the Sun's position: nothing here sends
// anything anywhere.

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const WGS84_A_KM = 6378.137;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);
const EARTH_RADIUS_KM = 6371.0; // mean radius for the shadow cylinder
const AU_KM = 149597870.7;

const mod = (x, m) => ((x % m) + m) % m;

/** Greenwich mean sidereal time (radians), IAU 1982, as satellite.js gstime. */
export function gmstRad(ms) {
  const tut1 = (ms / 86400000 + 2440587.5 - 2451545.0) / 36525.0;
  const sec =
    -6.2e-6 * tut1 ** 3 +
    0.093104 * tut1 ** 2 +
    (876600.0 * 3600 + 8640184.812866) * tut1 +
    67310.54841;
  return mod(((sec * D2R) / 240.0) % (2 * Math.PI), 2 * Math.PI);
}

/** WGS84 geodetic (degrees, degrees, km) -> Earth-fixed cartesian (km). */
export function geodeticToEcef(lonDeg, latDeg, altKm = 0) {
  const lat = latDeg * D2R;
  const lon = lonDeg * D2R;
  const s = Math.sin(lat);
  const c = Math.cos(lat);
  const N = WGS84_A_KM / Math.sqrt(1 - WGS84_E2 * s * s);
  return {
    x: (N + altKm) * c * Math.cos(lon),
    y: (N + altKm) * c * Math.sin(lon),
    z: (N * (1 - WGS84_E2) + altKm) * s,
  };
}

/** The observer's position and local east / north / up axes (Earth-fixed). */
function observerFrame({ latitude, longitude, altitude = 0 }) {
  const lat = latitude * D2R;
  const lon = longitude * D2R;
  const sl = Math.sin(lat);
  const cl = Math.cos(lat);
  const so = Math.sin(lon);
  const co = Math.cos(lon);
  return {
    latitude,
    longitude,
    pos: geodeticToEcef(longitude, latitude, (altitude || 0) / 1000),
    e: { x: -so, y: co, z: 0 },
    n: { x: -sl * co, y: -sl * so, z: cl },
    u: { x: cl * co, y: cl * so, z: sl },
  };
}

const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;

function lookFrom(frame, sat) {
  const r = { x: sat.x - frame.pos.x, y: sat.y - frame.pos.y, z: sat.z - frame.pos.z };
  const range = Math.hypot(r.x, r.y, r.z);
  if (!(range > 0)) return null;
  const up = dot(r, frame.u);
  return {
    elevDeg: Math.asin(Math.max(-1, Math.min(1, up / range))) * R2D,
    azDeg: mod(Math.atan2(dot(r, frame.e), dot(r, frame.n)) * R2D, 360),
    rangeKm: range,
  };
}

/**
 * Elevation and azimuth of an Earth-fixed point (km) from an observer.
 * @param {{ latitude: number, longitude: number, altitude?: number }} observer degrees, metres
 * @param {{ x: number, y: number, z: number }} satEcefKm
 */
export const lookAngles = (observer, satEcefKm) =>
  lookFrom(observerFrame(observer), satEcefKm);

/**
 * The Sun in geocentric inertial coordinates (km), USNO low-precision formulae:
 * about one arcminute within centuries of J2000.
 */
export function solarPositionEci(ms) {
  const D = ms / 86400000 + 2440587.5 - 2451545.0;
  const g = mod(357.529 + 0.98560028 * D, 360) * D2R;
  const q = mod(280.459 + 0.98564736 * D, 360);
  const L = mod(q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g), 360) * D2R;
  const e = (23.439 - 0.00000036 * D) * D2R;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  return {
    x: AU_KM * Math.cos(dec) * Math.cos(ra),
    y: AU_KM * Math.cos(dec) * Math.sin(ra),
    z: AU_KM * Math.sin(dec),
    raDeg: mod(ra * R2D, 360),
    decDeg: dec * R2D,
  };
}

/** The Sun's direction in Earth-fixed coordinates (unit vector). */
export function sunDirectionEcef(ms) {
  const s = solarPositionEci(ms);
  const th = gmstRad(ms);
  const len = Math.hypot(s.x, s.y, s.z);
  const c = Math.cos(th);
  const n = Math.sin(th);
  return { x: (s.x * c + s.y * n) / len, y: (-s.x * n + s.y * c) / len, z: s.z / len };
}

/** Whether an Earth-fixed point (km) is outside the Earth's (cylindrical) shadow. */
export function isSunlit(satEcefKm, ms, sun = sunDirectionEcef(ms)) {
  if (!satEcefKm) return false;
  const proj = dot(satEcefKm, sun);
  if (proj > 0) return true; // the sunward side of the Earth
  const dx = satEcefKm.x - proj * sun.x;
  const dy = satEcefKm.y - proj * sun.y;
  const dz = satEcefKm.z - proj * sun.z;
  return Math.hypot(dx, dy, dz) > EARTH_RADIUS_KM;
}

/** The Sun's elevation (degrees) seen from an observer. */
export function observerSolarElevation(latDeg, lonDeg, ms) {
  const sun = sunDirectionEcef(ms);
  const lat = latDeg * D2R;
  const lon = lonDeg * D2R;
  const up = {
    x: Math.cos(lat) * Math.cos(lon),
    y: Math.cos(lat) * Math.sin(lon),
    z: Math.sin(lat),
  };
  return Math.asin(Math.max(-1, Math.min(1, dot(up, sun)))) * R2D;
}

/** Whether the observer's sky is dark enough: Sun at or below maxSunElevDeg (-6 civil). */
export const isObserverDark = (latDeg, lonDeg, ms, maxSunElevDeg = -6) =>
  observerSolarElevation(latDeg, lonDeg, ms) <= maxSunElevDeg;

function satEcefAt(positionAt, ms) {
  let p;
  try {
    p = positionAt(ms);
  } catch {
    return null;
  }
  if (!p || ![p.longitude, p.latitude, p.altitude ?? 0].every(Number.isFinite))
    return null;
  return geodeticToEcef(p.longitude, p.latitude, (p.altitude ?? 0) / 1000);
}

/**
 * Look angles of the satellite at an instant, or null when propagation fails.
 * @returns {{ elevDeg: number, azDeg: number, rangeKm: number, satEcef: object } | null}
 */
export function lookAnglesAt(positionAt, ms, observer) {
  return lookAtFrame(positionAt, ms, observerFrame(observer));
}

function lookAtFrame(positionAt, ms, frame) {
  const sat = satEcefAt(positionAt, ms);
  if (!sat) return null;
  const look = lookFrom(frame, sat);
  return look && { ...look, satEcef: sat };
}

// Bisect the crossing of the threshold between tLow and tHigh (one crossing assumed).
function bisect(elevAt, tLow, tHigh, minElevDeg, rising, steps = 10) {
  let low = tLow;
  let high = tHigh;
  for (let i = 0; i < steps; i++) {
    const mid = (low + high) / 2;
    const above = elevAt(mid) >= minElevDeg;
    if (rising === above) high = mid;
    else low = mid;
  }
  return rising ? Math.ceil(high) : Math.floor(low);
}

/**
 * Whether any part of [start, end] is both sunlit and under a dark sky,
 * resolving shadow and twilight crossings to 20 ms so a short overlap between
 * samples is not lost. conditionsAt(ms) -> [sunlit, dark].
 */
export function hasVisibleInterval(start, end, conditionsAt) {
  const visible = (s) => s[0] && s[1];
  for (let left = start; left < end; left += 5000) {
    const right = Math.min(end, left + 5000);
    const a = conditionsAt(left);
    const b = conditionsAt(right);
    if (visible(a) || visible(b)) return true;
    const cuts = [left, right];
    for (let k = 0; k < 2; k++) {
      if (a[k] === b[k]) continue;
      let low = left;
      let high = right;
      while (high - low > 20) {
        const mid = (low + high) / 2;
        if (conditionsAt(mid)[k] === a[k]) low = mid;
        else high = mid;
      }
      cuts.push((low + high) / 2);
    }
    cuts.sort((x, y) => x - y);
    for (let i = 1; i < cuts.length; i++) {
      if (visible(conditionsAt((cuts[i - 1] + cuts[i]) / 2))) return true;
    }
  }
  return false;
}

/**
 * @typedef {Object} SatellitePass
 * @property {number} riseMs        first instant at or above minElevDeg (fromMs if already up)
 * @property {number} setMs         last instant at or above it (the horizon end if it never sets)
 * @property {number} maxElevDeg    culmination elevation
 * @property {number} maxElevMs     culmination time
 * @property {number} riseAzDeg     azimuth at rise (degrees from north, clockwise)
 * @property {number} maxAzDeg      azimuth at culmination
 * @property {number} setAzDeg      azimuth at set
 * @property {boolean} inProgress   the satellite was already up at fromMs
 * @property {boolean} visible      some part is sunlit under a dark sky (naked-eye candidate)
 * @property {boolean} sunlit       the satellite is sunlit at culmination
 * @property {boolean} observerDark the observer's Sun is at or below maxSunElevDeg at culmination
 */

/**
 * Find the next pass of a satellite over an observer.
 * @param {Object} o
 * @param {(ms: number) => ({ longitude: number, latitude: number, altitude: number } | null)} o.positionAt
 *   injected propagator (degrees, degrees, metres)
 * @param {{ latitude: number, longitude: number, altitude?: number }} o.observer degrees, metres
 * @param {number} o.fromMs           search start (UTC ms)
 * @param {number} [o.minElevDeg=10]  rise / set threshold
 * @param {number} [o.horizonHours=24]
 * @param {number} [o.coarseStepSec=20]
 * @param {number} [o.fineStepSec=5]
 * @param {boolean} [o.requireVisible=false] skip passes with no visible part
 * @param {number} [o.maxSunElevDeg=-6]
 * @returns {SatellitePass | null}
 */
export function findNextPass({
  positionAt,
  observer,
  fromMs,
  minElevDeg = 10,
  horizonHours = 24,
  coarseStepSec = 20,
  fineStepSec = 5,
  requireVisible = false,
  maxSunElevDeg = -6,
}) {
  const lat = observer?.latitude;
  const lon = observer?.longitude;
  if (
    typeof positionAt !== 'function' ||
    ![
      lat,
      lon,
      fromMs,
      minElevDeg,
      horizonHours,
      coarseStepSec,
      fineStepSec,
      maxSunElevDeg,
    ].every(Number.isFinite) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180 ||
    Math.abs(fromMs) > 8.64e15 ||
    minElevDeg < 0 ||
    minElevDeg > 90 ||
    horizonHours <= 0 ||
    horizonHours > 72 ||
    coarseStepSec < 1 ||
    coarseStepSec > 120 ||
    fineStepSec < 0.1 ||
    fineStepSec > 60
  ) {
    return null;
  }
  const frame = observerFrame(observer);
  const look = (ms) => lookAtFrame(positionAt, ms, frame);
  const elevAt = (ms) => look(ms)?.elevDeg ?? -90;
  const visibleAt = (l, ms) =>
    Boolean(l) && isSunlit(l.satEcef, ms) && isObserverDark(lat, lon, ms, maxSunElevDeg);

  const horizonMs = fromMs + horizonHours * 3600_000;
  const coarseMs = coarseStepSec * 1000;
  const fineMs = Math.max(1000, fineStepSec * 1000);
  let cursor = fromMs;

  while (cursor <= horizonMs) {
    // Coarse scan for the first sample at or above the threshold.
    let tPrev = cursor;
    let tHit = null;
    const startElev = elevAt(cursor);
    const inProgress = startElev >= minElevDeg;
    if (inProgress) {
      tHit = cursor;
    } else {
      for (let t = cursor + coarseMs; t <= horizonMs; t += coarseMs) {
        if (elevAt(t) >= minElevDeg) {
          tHit = t;
          break;
        }
        tPrev = t;
      }
    }
    if (tHit === null) return null;
    const riseMs = inProgress ? cursor : bisect(elevAt, tPrev, tHit, minElevDeg, true);

    // Walk the pass in fine steps: track the peak and bracket the set.
    let t = riseMs;
    let tStepPrev = riseMs;
    let maxElevDeg = -90;
    let maxElevMs = riseMs;
    let setMs = null;
    let visible = visibleAt(look(riseMs), riseMs);
    let prevSample = null;
    let peakLeft = null;
    let peakRight = null;
    let peakStep = fineMs;
    while (t <= horizonMs) {
      const l = look(t);
      const elev = l ? l.elevDeg : -90;
      if (!visible && elev >= minElevDeg && visibleAt(l, t)) visible = true;
      if (elev < minElevDeg && t > riseMs) {
        if (peakRight === null && t > maxElevMs) {
          peakRight = elev;
          peakStep = t - maxElevMs;
        }
        setMs = bisect(elevAt, tStepPrev, t, minElevDeg, false);
        break;
      }
      if (elev > maxElevDeg) {
        maxElevDeg = elev;
        maxElevMs = t;
        peakLeft = prevSample;
        peakRight = null;
      } else if (peakRight === null && t > maxElevMs) {
        peakRight = elev;
        peakStep = t - maxElevMs;
      }
      prevSample = elev;
      tStepPrev = t;
      t += fineMs;
    }
    if (setMs === null) setMs = Math.min(horizonMs, t);

    // Parabolic refinement of the culmination from the neighbouring samples.
    let peakMs = maxElevMs;
    let peakElev = maxElevDeg;
    const curv =
      peakLeft === null || peakRight === null ? 0 : peakLeft - 2 * maxElevDeg + peakRight;
    if (curv < 0) {
      const shift = ((peakLeft - peakRight) / (2 * curv)) * peakStep;
      if (Math.abs(shift) < peakStep) {
        peakMs = Math.max(riseMs, Math.min(setMs, Math.round(maxElevMs + shift)));
        peakElev = Math.min(90, maxElevDeg - (peakLeft - peakRight) ** 2 / (8 * curv));
      }
    }

    const peakLook = look(peakMs);
    const sunlit = peakLook ? isSunlit(peakLook.satEcef, peakMs) : false;
    const observerDark = isObserverDark(lat, lon, peakMs, maxSunElevDeg);
    if (!visible) visible = visibleAt(peakLook, peakMs) || visibleAt(look(setMs), setMs);
    if (!visible) {
      visible = hasVisibleInterval(riseMs, setMs, (ms) => {
        const l = look(ms);
        return [
          Boolean(l && isSunlit(l.satEcef, ms)),
          isObserverDark(lat, lon, ms, maxSunElevDeg),
        ];
      });
    }
    if (requireVisible && !visible) {
      cursor = Math.max(setMs + 1000, cursor + coarseMs);
      continue;
    }
    return {
      riseMs,
      setMs,
      maxElevDeg: peakElev,
      maxElevMs: peakMs,
      riseAzDeg: look(riseMs)?.azDeg ?? 0,
      maxAzDeg: peakLook?.azDeg ?? 0,
      setAzDeg: look(setMs)?.azDeg ?? 0,
      inProgress,
      visible,
      sunlit,
      observerDark,
    };
  }
  return null;
}

/**
 * The next few passes within one horizon (for a card list or `argus passes`).
 * @param {Parameters<typeof findNextPass>[0] & { count?: number }} o
 * @returns {SatellitePass[]}
 */
export function findPasses({ count = 3, horizonHours = 24, fromMs, ...rest }) {
  const out = [];
  const endMs = fromMs + horizonHours * 3600_000;
  let cursor = fromMs;
  while (out.length < count) {
    const hours = (endMs - cursor) / 3600_000;
    if (!(hours > 0)) break;
    const pass = findNextPass({ ...rest, fromMs: cursor, horizonHours: hours });
    if (!pass) break;
    out.push(pass);
    cursor = pass.setMs + 1000;
  }
  return out;
}

const POINTS = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
];

/** 16-point compass name for an azimuth. */
export const compassPoint = (azDeg) => POINTS[Math.round(mod(azDeg, 360) / 22.5) % 16];

const utc = (ms) => `${new Date(ms).toISOString().slice(11, 19)} UTC`;

function until(ms, now) {
  const d = Math.max(0, ms - now);
  const min = Math.round(d / 60_000);
  if (min < 1) return 'now';
  if (min < 60) return `in ${min} min`;
  return `in ${Math.floor(min / 60)} h ${min % 60} min`;
}

/**
 * Card rows for a pass (shared by the globe card and the terminal).
 * @param {SatellitePass | null} pass
 * @param {number} [now]
 * @returns {[string, string][]}
 */
export function describePass(pass, now = Date.now()) {
  if (!pass) return [['Next pass', 'none above 10° in the next 24 h']];
  const az = (a) => `${compassPoint(a)} (${Math.round(a)}°)`;
  const visibility = pass.visible
    ? 'yes: sunlit under a dark sky'
    : !pass.observerDark
      ? 'no: daylight or bright twilight'
      : !pass.sunlit
        ? "no: in the Earth's shadow"
        : 'no';
  return [
    ['Next pass', pass.inProgress ? 'overhead now' : until(pass.riseMs, now)],
    ['Rises', `${utc(pass.riseMs)}, ${az(pass.riseAzDeg)}`],
    [
      'Peak',
      `${Math.round(pass.maxElevDeg)}° at ${utc(pass.maxElevMs)}, ${az(pass.maxAzDeg)}`,
    ],
    ['Sets', `${utc(pass.setMs)}, ${az(pass.setAzDeg)}`],
    ['Duration', `${Math.max(1, Math.round((pass.setMs - pass.riseMs) / 60_000))} min`],
    ['Visible', visibility],
  ];
}
