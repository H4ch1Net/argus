import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sunAzimuthDeg, sunElevationDeg, sunPosition } from './sun.js';

const near = (actual, expected, tol, msg) =>
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${msg ?? ''} expected ${expected} +/- ${tol}, got ${actual}`,
  );

/** Highest elevation over a day window, scanning a minute at a time. */
function peak(lat, lon, fromIso, toIso) {
  let best = -Infinity;
  for (let t = Date.parse(fromIso); t <= Date.parse(toIso); t += 60000) {
    best = Math.max(best, sunElevationDeg(lat, lon, new Date(t)));
  }
  return best;
}

test('March equinox: overhead at the equator at local solar noon', () => {
  const date = new Date('2026-03-20T12:00:00Z');
  // At 12:00 UTC the sun is on the meridian where 4*lon = -equation of time.
  const { equationOfTime } = sunPosition(0, 0, date);
  near(equationOfTime, -7.6, 0.3, 'equation of time on 20 March');
  const lonNoon = -equationOfTime / 4;
  assert.ok(sunElevationDeg(0, lonNoon, date) > 89.5);
});

test('midnight is below the horizon', () => {
  assert.ok(sunElevationDeg(0, 0, new Date('2026-03-20T00:00:00Z')) < -85);
  assert.ok(sunElevationDeg(48.86, 2.35, new Date('2026-10-08T00:00:00Z')) < -30);
  assert.ok(sunElevationDeg(-33.87, 151.21, new Date('2026-10-08T14:00:00Z')) < -30);
});

test('solstice noon elevation is 90 - |lat - declination|', () => {
  const june = sunPosition(51.5, -0.13, new Date('2026-06-21T12:00:00Z'));
  near(june.declination, 23.44, 0.02, 'June declination');
  near(peak(51.5, -0.13, '2026-06-21T11:30:00Z', '2026-06-21T12:30:00Z'), 61.94, 0.3);
  const dec = sunPosition(-33.87, 151.21, new Date('2026-12-21T02:00:00Z'));
  near(dec.declination, -23.44, 0.02, 'December declination');
  near(peak(-33.87, 151.21, '2026-12-21T01:00:00Z', '2026-12-21T03:00:00Z'), 79.57, 0.3);
});

test('equation of time near its yearly extremes', () => {
  near(sunPosition(0, 0, new Date('2026-11-03T12:00:00Z')).equationOfTime, 16.4, 0.3);
  near(sunPosition(0, 0, new Date('2026-02-11T12:00:00Z')).equationOfTime, -14.2, 0.3);
});

test('matches an independent solar model (USNO approximation) to 0.2 degrees', () => {
  // Reference values from the USNO low-precision solar coordinates with GMST
  // (geometric, no refraction), computed separately; refraction stays under
  // 0.1 degree above 10 degrees of elevation.
  const cases = [
    [48.8584, 2.2945, '2026-10-08T09:48:12Z', 30.13, 147.87],
    [40.6892, -74.0445, '2027-01-15T18:30:00Z', 25.21, 201.8],
    [-54.8, -68.3, '2027-01-15T18:30:00Z', 50.68, 318.31],
    [35.68, 139.69, '2026-12-21T02:00:00Z', 30.17, 169.62],
    [64.15, -21.94, '2026-06-21T12:00:00Z', 46.7, 149.35],
  ];
  for (const [lat, lon, iso, el, az] of cases) {
    const p = sunPosition(lat, lon, new Date(iso));
    near(p.elevation, el, 0.2, `${lat},${lon} ${iso} elevation`);
    near(p.azimuth, az, 0.2, `${lat},${lon} ${iso} azimuth`);
  }
});

test('azimuth: south at a northern noon, east in an equinox morning', () => {
  near(sunAzimuthDeg(51.5, -0.13, new Date('2026-06-21T12:02:00Z')), 180, 2);
  near(sunAzimuthDeg(0, 0, new Date('2026-03-20T06:30:00Z')), 90, 2);
  // South of the subsolar point the noon sun is due north.
  const noonSyd = sunAzimuthDeg(-33.87, 151.21, new Date('2026-06-21T01:55:00Z'));
  assert.ok(noonSyd < 3 || noonSyd > 357, `got ${noonSyd}`);
});

test('ranges hold everywhere, and the default date is now', () => {
  for (let lat = -90; lat <= 90; lat += 15) {
    for (let lon = -180; lon <= 180; lon += 30) {
      for (const iso of ['2026-01-01T00:00:00Z', '2026-07-04T15:20:00Z']) {
        const p = sunPosition(lat, lon, new Date(iso));
        assert.ok(p.elevation >= -90 && p.elevation <= 90, `el ${p.elevation}`);
        assert.ok(p.azimuth >= 0 && p.azimuth < 360, `az ${p.azimuth}`);
        assert.ok(Math.abs(p.declination) <= 23.45);
      }
    }
  }
  assert.ok(Number.isFinite(sunElevationDeg(10, 20)));
  assert.ok(Number.isFinite(sunAzimuthDeg(10, 20)));
});
