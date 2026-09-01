import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpolateFix, shortestLonDelta, normalizeLon } from './interpolate.js';

const prev = { t: 1000, longitude: 0, latitude: 0, altitude: 1000 };
const curr = { t: 2000, longitude: 10, latitude: 20, altitude: 3000 };

test('midpoint interpolates linearly', () => {
  const p = interpolateFix(prev, curr, 1500);
  assert.equal(p.longitude, 5);
  assert.equal(p.latitude, 10);
  assert.equal(p.altitude, 2000);
});

test('clamps: before prev holds prev, after curr holds curr (no extrapolation)', () => {
  assert.deepEqual(interpolateFix(prev, curr, 500), {
    longitude: 0,
    latitude: 0,
    altitude: 1000,
  });
  assert.deepEqual(interpolateFix(prev, curr, 5000), {
    longitude: 10,
    latitude: 20,
    altitude: 3000,
  });
});

test('no prev fix returns curr', () => {
  assert.deepEqual(interpolateFix(undefined, curr, 1500), {
    longitude: 10,
    latitude: 20,
    altitude: 3000,
  });
});

test('interpolates the short way across the antimeridian', () => {
  const a = { t: 0, longitude: 170, latitude: 0, altitude: 0 };
  const b = { t: 1000, longitude: -170, latitude: 0, altitude: 0 };
  const mid = interpolateFix(a, b, 500);
  // Short path crosses the 180 meridian (canonicalized to -180), not back through 0.
  assert.equal(Math.abs(Math.round(mid.longitude)), 180);
});

test('shortestLonDelta and normalizeLon', () => {
  assert.equal(shortestLonDelta(170, -170), 20);
  assert.equal(shortestLonDelta(-170, 170), -20);
  assert.equal(normalizeLon(190), -170);
  assert.equal(normalizeLon(-190), 170);
});
