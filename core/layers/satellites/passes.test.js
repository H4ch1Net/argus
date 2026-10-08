import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  gmstRad,
  geodeticToEcef,
  lookAngles,
  lookAnglesAt,
  solarPositionEci,
  sunDirectionEcef,
  isSunlit,
  observerSolarElevation,
  isObserverDark,
  findNextPass,
  findPasses,
  hasVisibleInterval,
  compassPoint,
  describePass,
} from './passes.js';

// --- a synthetic propagator: a circular Keplerian orbit, no satellite.js -------

const MU = 398600.4418; // km^3 / s^2
const A = 6378.137;
const E2 = (1 / 298.257223563) * (2 - 1 / 298.257223563);
const D2R = Math.PI / 180;

// Earth-fixed km -> WGS84 geodetic (degrees, degrees, metres), iterated.
function ecefToGeodetic({ x, y, z }) {
  const lon = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - E2));
  let h = 0;
  for (let i = 0; i < 8; i++) {
    const N = A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
    h = p / Math.cos(lat) - N;
    lat = Math.atan2(z, p * (1 - (E2 * N) / (N + h)));
  }
  return { longitude: lon / D2R, latitude: lat / D2R, altitude: h * 1000 };
}

/**
 * A circular orbit that puts the satellite straight over (latDeg, lonDeg)
 * (geocentric) at atMs, ascending.
 */
function orbitOver({ latDeg, lonDeg, atMs, altKm, incDeg }) {
  const r = A + altKm;
  const n = Math.sqrt(MU / r ** 3); // rad/s
  const inc = incDeg * D2R;
  const ra = lonDeg * D2R + gmstRad(atMs); // inertial right ascension of the target
  const u0 = inc === 0 ? 0 : Math.asin(Math.sin(latDeg * D2R) / Math.sin(inc));
  const raan =
    inc === 0 ? ra : ra - Math.atan2(Math.cos(inc) * Math.sin(u0), Math.cos(u0));
  return (ms) => {
    const u = u0 + (n * (ms - atMs)) / 1000;
    const xp = r * Math.cos(u);
    const yp = r * Math.sin(u);
    const x = xp * Math.cos(raan) - yp * Math.cos(inc) * Math.sin(raan);
    const y = xp * Math.sin(raan) + yp * Math.cos(inc) * Math.cos(raan);
    const z = yp * Math.sin(inc);
    const th = gmstRad(ms);
    return ecefToGeodetic({
      x: x * Math.cos(th) + y * Math.sin(th),
      y: -x * Math.sin(th) + y * Math.cos(th),
      z,
    });
  };
}

const MIN = 60_000;
const EQUINOX = Date.parse('2026-03-20T14:46:00Z');

/** The longitude where it is local solar midnight (or noon) at ms. */
function longitudeAtSolarHour(ms, hourAngleDeg) {
  const sun = solarPositionEci(ms);
  const lon = hourAngleDeg + sun.raDeg - gmstRad(ms) / D2R;
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

// --- tests ---------------------------------------------------------------

test('geodetic round trip and an overhead look angle', () => {
  const p = geodeticToEcef(-122.4, 37.8, 420);
  const g = ecefToGeodetic(p);
  assert.ok(Math.abs(g.latitude - 37.8) < 1e-9 && Math.abs(g.longitude + 122.4) < 1e-9);
  assert.ok(Math.abs(g.altitude - 420_000) < 1e-3);
  const look = lookAngles({ latitude: 37.8, longitude: -122.4 }, p);
  assert.ok(look.elevDeg > 89.999);
  assert.ok(Math.abs(look.rangeKm - 420) < 1e-6);
  // A point due north on the horizon side has azimuth ~0.
  const north = lookAngles({ latitude: 0, longitude: 0 }, geodeticToEcef(0, 5, 400));
  assert.ok(north.azDeg < 1 || north.azDeg > 359);
  assert.equal(compassPoint(0), 'N');
  assert.equal(compassPoint(312), 'NW');
  assert.equal(compassPoint(359), 'N');
});

test('Sun position: equinox and solstice declinations', () => {
  const eq = solarPositionEci(EQUINOX);
  assert.ok(Math.abs(eq.decDeg) < 0.05, `dec ${eq.decDeg}`);
  assert.ok(eq.raDeg < 0.1 || eq.raDeg > 359.9, `ra ${eq.raDeg}`);
  const sol = solarPositionEci(Date.parse('2026-06-21T08:24:00Z'));
  assert.ok(Math.abs(sol.decDeg - 23.43) < 0.05, `dec ${sol.decDeg}`);
});

test('the observer Sun: noon high, midnight dark', () => {
  // Greenwich around solar noon and midnight at the March equinox (the equation
  // of time puts solar noon near 12:07 UTC then).
  const noon = observerSolarElevation(51.4779, 0, Date.parse('2026-03-20T12:07:30Z'));
  const night = observerSolarElevation(51.4779, 0, Date.parse('2026-03-20T00:07:30Z'));
  assert.ok(Math.abs(noon - 38.4) < 0.6, `noon ${noon}`);
  assert.ok(Math.abs(night + 38.6) < 0.6, `night ${night}`);
  assert.equal(isObserverDark(51.4779, 0, Date.parse('2026-03-20T00:07:30Z')), true);
  assert.equal(isObserverDark(51.4779, 0, Date.parse('2026-03-20T12:07:30Z')), false);
});

test('cylindrical Earth shadow', () => {
  const s = sunDirectionEcef(EQUINOX);
  const at = (k, perp = 0) => {
    // a unit vector perpendicular to the Sun direction
    const q = Math.hypot(s.x, s.y);
    const p = { x: -s.y / q, y: s.x / q, z: 0 };
    return { x: s.x * k + p.x * perp, y: s.y * k + p.y * perp, z: s.z * k + p.z * perp };
  };
  assert.equal(isSunlit(at(7000), EQUINOX), true); // day side
  assert.equal(isSunlit(at(-7000), EQUINOX), false); // straight behind the Earth
  assert.equal(isSunlit(at(-7000, 7000), EQUINOX), true); // behind, outside the cylinder
  assert.equal(isSunlit(null, EQUINOX), false);
});

test('an overhead ISS-like pass: rise, culmination and set at 10 degrees', () => {
  const t0 = Date.parse('2026-03-20T19:00:00Z'); // about local noon at 100 W
  const positionAt = orbitOver({
    latDeg: 40,
    lonDeg: -100,
    atMs: t0,
    altKm: 420,
    incDeg: 51.6,
  });
  const sub = positionAt(t0);
  const observer = { latitude: sub.latitude, longitude: sub.longitude };
  const pass = findNextPass({ positionAt, observer, fromMs: t0 - 10 * MIN });
  assert.ok(pass, 'a pass is found');
  assert.ok(pass.riseMs < t0 && t0 < pass.setMs);
  assert.ok(Math.abs(pass.maxElevMs - t0) < 3000, `peak at ${pass.maxElevMs - t0} ms`);
  assert.ok(pass.maxElevDeg > 88, `max ${pass.maxElevDeg}`);
  const dur = (pass.setMs - pass.riseMs) / MIN;
  assert.ok(dur > 4 && dur < 8, `duration ${dur} min`);
  // Rise and set are bisected onto the threshold.
  const el = (ms) => lookAnglesAt(positionAt, ms, observer).elevDeg;
  assert.ok(Math.abs(el(pass.riseMs) - 10) < 0.1, `rise elev ${el(pass.riseMs)}`);
  assert.ok(Math.abs(el(pass.setMs) - 10) < 0.1, `set elev ${el(pass.setMs)}`);
  assert.equal(pass.inProgress, false);
  // Rises and sets on opposite sides of the sky.
  const d = Math.abs(pass.riseAzDeg - pass.setAzDeg);
  assert.ok(Math.abs(Math.min(d, 360 - d) - 180) < 15);
  // Midday in North America: not a naked-eye pass.
  assert.equal(pass.observerDark, false);
  assert.equal(pass.visible, false);
});

test('consecutive passes do not overlap; findPasses stays within the horizon', () => {
  const t0 = Date.parse('2026-03-20T19:00:00Z');
  const positionAt = orbitOver({
    latDeg: 40,
    lonDeg: -100,
    atMs: t0,
    altKm: 420,
    incDeg: 51.6,
  });
  const observer = { latitude: 40, longitude: -100 };
  const passes = findPasses({ positionAt, observer, fromMs: t0 - 10 * MIN, count: 4 });
  assert.equal(passes.length, 4);
  for (let i = 1; i < passes.length; i++)
    assert.ok(passes[i].riseMs > passes[i - 1].setMs);
  assert.ok(passes.at(-1).setMs <= t0 - 10 * MIN + 24 * 3600_000);
});

test('a geostationary satellite: never up from the far side, always up beneath it', () => {
  const t0 = EQUINOX;
  const positionAt = orbitOver({
    latDeg: 0,
    lonDeg: 0,
    atMs: t0,
    altKm: 35786,
    incDeg: 0,
  });
  assert.equal(
    findNextPass({ positionAt, observer: { latitude: 0, longitude: 180 }, fromMs: t0 }),
    null,
  );
  const pass = findNextPass({
    positionAt,
    observer: { latitude: 10, longitude: 5 },
    fromMs: t0,
    horizonHours: 2,
  });
  assert.equal(pass.inProgress, true);
  assert.equal(pass.riseMs, t0);
  assert.ok(pass.setMs >= t0 + 2 * 3600_000 - 5000);
});

test('visibility: a MEO satellite overhead at local midnight is sunlit and visible', () => {
  const t0 = Date.parse('2026-03-20T03:00:00Z');
  const lon = longitudeAtSolarHour(t0, 180);
  const positionAt = orbitOver({
    latDeg: 45,
    lonDeg: lon,
    atMs: t0,
    altKm: 20200,
    incDeg: 55,
  });
  const observer = { latitude: 45, longitude: lon };
  const pass = findNextPass({
    positionAt,
    observer,
    fromMs: t0 - 5 * MIN,
    horizonHours: 8,
  });
  assert.ok(pass);
  assert.equal(pass.observerDark, true);
  assert.equal(pass.sunlit, true);
  assert.equal(pass.visible, true);
  assert.match(describePass(pass, t0)[5][1], /^yes/);
});

test('visibility: a LEO satellite overhead at equatorial midnight is in shadow', () => {
  const t0 = Date.parse('2026-03-20T03:00:00Z');
  const lon = longitudeAtSolarHour(t0, 180);
  const positionAt = orbitOver({
    latDeg: 0,
    lonDeg: lon,
    atMs: t0,
    altKm: 420,
    incDeg: 0,
  });
  const observer = { latitude: 0, longitude: lon };
  const first = findNextPass({ positionAt, observer, fromMs: t0 - 10 * MIN });
  assert.ok(first && first.riseMs < t0 && first.setMs > t0);
  assert.equal(first.observerDark, true);
  assert.equal(first.sunlit, false);
  assert.equal(first.visible, false);
  assert.match(describePass(first, t0)[5][1], /shadow/);
  // Asking for a visible pass skips ahead to a twilight one.
  const next = findNextPass({
    positionAt,
    observer,
    fromMs: t0 - 10 * MIN,
    requireVisible: true,
  });
  assert.ok(next, 'a visible pass within 24 h');
  assert.ok(next.riseMs > first.setMs);
  assert.equal(next.visible, true);
});

test('visibility intervals resolve short overlaps', () => {
  // Sunlit until 3,010 ms, dark from 3,000 ms: a 10 ms overlap.
  const cond = (t) => [t < 3010, t >= 3000];
  assert.equal(hasVisibleInterval(0, 10_000, cond), true);
  assert.equal(
    hasVisibleInterval(0, 10_000, (t) => [t < 3000, t >= 3500]),
    false,
  );
});

test('bad input returns null; a failing propagator never throws', () => {
  const observer = { latitude: 0, longitude: 0 };
  assert.equal(findNextPass({ observer, fromMs: 0 }), null);
  assert.equal(
    findNextPass({
      positionAt: () => null,
      observer: { latitude: 91, longitude: 0 },
      fromMs: 0,
    }),
    null,
  );
  assert.equal(
    findNextPass({ positionAt: () => null, observer, fromMs: 0, horizonHours: 0 }),
    null,
  );
  assert.equal(
    findNextPass({ positionAt: () => null, observer, fromMs: 0, horizonHours: 1 }),
    null,
  );
  const boom = () => {
    throw new Error('decayed');
  };
  assert.equal(
    findNextPass({ positionAt: boom, observer, fromMs: 0, horizonHours: 1 }),
    null,
  );
  assert.deepEqual(describePass(null), [
    ['Next pass', 'none above 10° in the next 24 h'],
  ]);
});
