import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rectangleRadiansToBBox, viewportShift } from './viewport.js';

const D2R = Math.PI / 180;
const rad = (o) => ({
  west: o.w * D2R,
  south: o.s * D2R,
  east: o.e * D2R,
  north: o.n * D2R,
});

test('converts radians rect to degree bbox', () => {
  const bb = rectangleRadiansToBBox(rad({ w: -75, s: 40, e: -73, n: 42 }));
  assert.equal(Math.round(bb.lomin), -75);
  assert.equal(Math.round(bb.lamin), 40);
  assert.equal(Math.round(bb.lomax), -73);
  assert.equal(Math.round(bb.lamax), 42);
});

test('clamps out-of-range values', () => {
  const bb = rectangleRadiansToBBox(rad({ w: -400, s: -200, e: 400, n: 200 }));
  assert.equal(bb.lomin, -180);
  assert.equal(bb.lomax, 180);
  assert.equal(bb.lamin, -90);
  assert.equal(bb.lamax, 90);
});

test('antimeridian-crossing rect widens longitude to full range', () => {
  const bb = rectangleRadiansToBBox(rad({ w: 170, s: 0, e: -170, n: 10 }));
  assert.equal(bb.lomin, -180);
  assert.equal(bb.lomax, 180);
});

test('viewportShift: same view 0, GPS jitter tiny, a drive or a zoom large', () => {
  const view = { lamin: 37.7, lamax: 37.8, lomin: -122.5, lomax: -122.3 };
  assert.equal(viewportShift(view, { ...view }), 0);
  // A few metres of jitter under a 10 km view: far below any refetch threshold.
  const jitter = {
    lamin: 37.70003,
    lamax: 37.80003,
    lomin: -122.50002,
    lomax: -122.30002,
  };
  assert.ok(viewportShift(view, jitter) < 0.001);
  // A third of a view east: due a refetch.
  const east = { ...view, lomin: -122.4333, lomax: -122.2333 };
  assert.ok(Math.abs(viewportShift(view, east) - 1 / 3) < 1e-3);
  // Zoomed out to twice the size, same centre: log 2.
  const out = { lamin: 37.65, lamax: 37.85, lomin: -122.6, lomax: -122.2 };
  assert.ok(Math.abs(viewportShift(view, out) - Math.LN2) < 1e-9);
  // Unknown or antimeridian-widened views always count as moved.
  assert.equal(viewportShift(null, view), Infinity);
  assert.equal(
    viewportShift(view, { ...view, wrap: { west: 170, east: -170 } }),
    Infinity,
  );
});
