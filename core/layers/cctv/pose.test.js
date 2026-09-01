import { test } from 'node:test';
import assert from 'node:assert/strict';
import { viewDirEnu, rightEnu, frustumCornersEnu, DEFAULT_POSE } from './pose.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test('viewDirEnu: heading 90 (east), no pitch -> points east', () => {
  const d = viewDirEnu(90, 0);
  assert.ok(near(d.e, 1) && near(d.n, 0) && near(d.u, 0));
});

test('viewDirEnu: pitch tilts downward (negative up)', () => {
  const d = viewDirEnu(0, 30);
  assert.ok(d.u < 0, 'looking down');
  assert.ok(near(Math.hypot(d.e, d.n, d.u), 1), 'unit length');
});

test('rightEnu is horizontal and perpendicular to the view azimuth', () => {
  const r = rightEnu(0); // heading north -> right is east
  assert.ok(near(r.e, 1) && near(r.n, 0) && near(r.u, 0));
});

test('frustumCornersEnu: four corners spread around the view center', () => {
  const { center, corners } = frustumCornersEnu(DEFAULT_POSE);
  assert.equal(corners.length, 4);
  // Center is range metres away.
  assert.ok(near(Math.hypot(center.e, center.n, center.u), DEFAULT_POSE.rangeM, 1e-6));
  // Corners are farther from the camera than the center (spread outward).
  const centerDist = Math.hypot(center.e, center.n, center.u);
  for (const c of corners) {
    assert.ok(Math.hypot(c.e, c.n, c.u) > centerDist);
  }
});
