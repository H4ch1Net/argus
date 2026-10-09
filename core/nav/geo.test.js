import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  haversineM,
  bearingDeg,
  destination,
  angleDiff,
  decodePolyline,
  cleanLine,
  cumulative,
  snapToLine,
  pointAlong,
  nearestVertex,
  lineBBox,
} from './geo.js';

test('distances, bearings and destinations agree with each other', () => {
  const d = haversineM(51.5, -0.12, 48.86, 2.35);
  assert.ok(Math.abs(d - 341_000) < 3000, `London to Paris ~341 km, got ${d}`);
  assert.ok(Math.abs(bearingDeg(0, 0, 1, 0) - 0) < 1e-9);
  assert.ok(Math.abs(bearingDeg(0, 0, 0, 1) - 90) < 1e-9);
  const p = destination(37.77, -122.42, 45, 1000);
  assert.ok(Math.abs(haversineM(37.77, -122.42, p.lat, p.lon) - 1000) < 0.5);
  assert.ok(Math.abs(bearingDeg(37.77, -122.42, p.lat, p.lon) - 45) < 0.1);
  assert.equal(angleDiff(350, 10), 20);
  assert.equal(angleDiff(10, 350), -20);
  assert.equal(angleDiff(0, 180), 180);
});

test('decodePolyline reads Valhalla precision-6 and Google precision-5 lines', () => {
  // Google's documented example, precision 5.
  assert.deepEqual(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 5), [
    [-120.2, 38.5],
    [-120.95, 40.7],
    [-126.453, 43.252],
  ]);
  // Truncated input decodes what it can.
  assert.deepEqual(decodePolyline('_p~iF~ps|U_ulL', 5), [[-120.2, 38.5]]);
  assert.deepEqual(decodePolyline(null), []);
});

test('cleanLine drops junk and repeats; cumulative adds up', () => {
  const line = cleanLine([
    [0, 0],
    [0, 0],
    ['x', 1],
    [0, 0.001],
    [200, 0],
    [0.001, 0.001],
  ]);
  assert.deepEqual(line, [
    [0, 0],
    [0, 0.001],
    [0.001, 0.001],
  ]);
  const cum = cumulative(line);
  assert.equal(cum[0], 0);
  assert.ok(Math.abs(cum[2] - 2 * 111.195) < 0.5);
  assert.deepEqual(lineBBox(line), [0, 0, 0.001, 0.001]);
  assert.equal(lineBBox([]), null);
});

test('snapToLine finds the closest point, its along distance and offset', () => {
  // An L: north 1 km, then east 1 km.
  const line = [
    [0, 0],
    [0, 0.009],
    [0.009, 0.009],
  ];
  const cum = cumulative(line);
  const out = {};
  const s = snapToLine(line, cum, 0.0045, 0.0002, {}, out);
  assert.equal(s, out, 'writes into the object it is given');
  assert.equal(s.index, 0);
  assert.ok(Math.abs(s.offM - 22.2) < 0.5);
  assert.ok(Math.abs(s.along - 500.4) < 1);
  assert.ok(Math.abs(s.lon) < 1e-9);
  // Past the corner, on the second leg.
  const t = snapToLine(line, cum, 0.0092, 0.004, {}, {});
  assert.equal(t.index, 1);
  assert.ok(Math.abs(t.along - (cum[1] + 444.8)) < 2);
  // A window that excludes the right segment snaps to the best it has.
  const w = snapToLine(line, cum, 0.0092, 0.004, { from: 0, to: 1 }, {});
  assert.equal(w.index, 0);
  assert.ok(w.offM > 400);
});

test('pointAlong walks the line with the segment bearing, clamped at the ends', () => {
  const line = [
    [0, 0],
    [0, 0.009],
    [0.009, 0.009],
  ];
  const cum = cumulative(line);
  const p = pointAlong(line, cum, 500, {});
  assert.ok(Math.abs(p.lat - 0.0045) < 1e-4);
  assert.ok(Math.abs(p.heading) < 1e-6);
  const q = pointAlong(line, cum, cum[1] + 100, {});
  assert.equal(q.index, 1);
  assert.ok(Math.abs(q.heading - 90) < 0.01);
  assert.deepEqual(
    [pointAlong(line, cum, -5, {}).lat, pointAlong(line, cum, 1e9, {}).lon],
    [0, 0.009],
  );
  assert.equal(nearestVertex(line, 0.009, 0.0089), 2);
  assert.equal(nearestVertex(line, 0, 0, 1), 1);
});
