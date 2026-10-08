import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  windGrid,
  windQuery,
  parseWind,
  sampleWind,
  windFromDeg,
  formatWind,
} from './field.js';

const bbox = { lamin: 40, lomin: -10, lamax: 55, lomax: 10 };

test('a grid covers the view with snapped, rounded points', () => {
  const g = windGrid(bbox);
  assert.equal(g.lats.length, 48);
  assert.ok(g.south <= 40 && g.north >= 55 && g.west <= -10 && g.east >= 10);
  const q = windQuery(g);
  assert.equal(q.latitude.split(',').length, 48);
  assert.equal(q.current, 'wind_speed_10m,wind_direction_10m');
  assert.deepEqual(
    windGrid(bbox),
    windGrid({ ...bbox, lamin: 40.01 }),
    'nearby views share a grid',
  );
});

test('the grid stays in range across the antimeridian and near the poles', () => {
  const g = windGrid({
    lamin: 70,
    lomin: -180,
    lamax: 89,
    lomax: 180,
    wrap: { west: 170, east: -170 },
  });
  assert.ok(g.lons.every((x) => x >= -180 && x <= 180));
  assert.ok(g.lats.every((y) => y <= 80));
});

test('parse turns speed and direction into u/v and samples between points', () => {
  const g = windGrid(bbox, { nx: 2, ny: 2 });
  // Wind from the west (270°) at 10 m/s everywhere: blowing east, u = +10.
  const payload = g.lats.map(() => ({
    current: { wind_speed_10m: 10, wind_direction_10m: 270, time: '2026-10-08T09:00' },
  }));
  const f = parseWind(payload, g);
  assert.ok(Math.abs(f.u[0] - 10) < 1e-4 && Math.abs(f.v[0]) < 1e-4);
  const s = sampleWind(f, 0, 47);
  assert.ok(Math.abs(s.speed - 10) < 1e-4);
  assert.equal(Math.round(windFromDeg(s.u, s.v)), 270);
  assert.match(formatWind(s), /^19KT 270° W$/);
  assert.equal(sampleWind(f, 50, 47), null, 'outside the grid');
  assert.equal(parseWind([{}], g), null, 'wrong length is rejected');
});
