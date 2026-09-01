import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rectangleRadiansToBBox } from './viewport.js';

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
