import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTle } from './tle.js';
import { toSatrec, satPositionAt, orbitTrack } from './propagate.js';

// Canonical ISS TLE (from the satellite.js docs): known-valid, so SGP4 output
// can be sanity-checked. ISS is a ~400 km, 51.6 deg inclination orbit; SGP4
// preserves altitude and inclination even when the epoch is old, so a broad
// range check is robust regardless of when the test runs.
const ISS = `ISS (ZARYA)
1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927
2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537`;

test('SGP4 gives a plausible ISS position (altitude + inclination bound)', () => {
  const satrec = toSatrec(parseTle(ISS)[0]);
  const p = satPositionAt(satrec, new Date());
  assert.ok(p, 'position computed');
  const altKm = p.altitude / 1000;
  assert.ok(altKm > 150 && altKm < 600, `ISS altitude ${altKm.toFixed(0)} km in range`);
  assert.ok(
    Math.abs(p.latitude) <= 53,
    `ISS latitude ${p.latitude.toFixed(1)} within inclination`,
  );
  assert.ok(p.longitude >= -180 && p.longitude <= 180);
});

test('position changes over time (the satellite moves)', () => {
  const satrec = toSatrec(parseTle(ISS)[0]);
  const t = new Date('2024-01-01T00:00:00Z');
  const a = satPositionAt(satrec, t);
  const b = satPositionAt(satrec, new Date(t.getTime() + 60_000));
  assert.notEqual(a.latitude, b.latitude);
});

test('orbitTrack returns a full-period polyline of plausible points', () => {
  const satrec = toSatrec(parseTle(ISS)[0]);
  const track = orbitTrack(satrec, new Date(), 60);
  assert.ok(track.length > 50);
  for (const p of track) {
    const altKm = p.altitude / 1000;
    assert.ok(altKm > 150 && altKm < 600);
  }
});
