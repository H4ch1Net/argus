import { test } from 'node:test';
import assert from 'node:assert/strict';
import { angularDistance, arcPeakHeight, arcPointAt, arcSamples } from './greatCircle.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

test('endpoints: t=0 is the source, t=1 is the target, both at ground', () => {
  const from = { longitude: 12, latitude: 34 };
  const to = { longitude: -56, latitude: -7 };
  const a = arcPointAt(from, to, 0);
  const b = arcPointAt(from, to, 1);
  assert.ok(near(a.longitude, 12, 1e-4) && near(a.latitude, 34, 1e-4));
  assert.ok(near(b.longitude, -56, 1e-4) && near(b.latitude, -7, 1e-4));
  assert.ok(near(a.altitude, 0) && near(b.altitude, 0));
});

test('meridian midpoint sits halfway in latitude at the peak height', () => {
  const from = { longitude: 0, latitude: 0 };
  const to = { longitude: 0, latitude: 90 };
  const mid = arcPointAt(from, to, 0.5);
  assert.ok(near(mid.latitude, 45, 1e-4));
  assert.ok(near(mid.longitude, 0, 1e-4));
  assert.ok(near(mid.altitude, arcPeakHeight(from, to)));
});

test('shortest path crosses the antimeridian, not back through 0', () => {
  const from = { longitude: -175, latitude: 0 };
  const to = { longitude: 175, latitude: 0 };
  const mid = arcPointAt(from, to, 0.5);
  assert.ok(Math.abs(mid.longitude) > 179.9); // near +/-180, not near 0
  assert.ok(near(mid.latitude, 0, 1e-4));
});

test('angularDistance is symmetric and zero for identical points', () => {
  const p = { longitude: 5, latitude: 5 };
  const q = { longitude: 40, latitude: -10 };
  assert.ok(near(angularDistance(p, q), angularDistance(q, p)));
  assert.ok(near(angularDistance(p, p), 0));
});

test('peak height is clamped to the configured range', () => {
  const tiny = arcPeakHeight(
    { longitude: 0, latitude: 0 },
    { longitude: 0.01, latitude: 0 },
  );
  assert.equal(tiny, 150_000); // floor
  const huge = arcPeakHeight(
    { longitude: 0, latitude: 0 },
    { longitude: 179, latitude: 0 },
  );
  assert.equal(huge, 1_400_000); // ceiling
});

test('arcSamples returns samples+1 points with ends on the ground', () => {
  const { points, peak } = arcSamples(
    { longitude: 0, latitude: 0 },
    { longitude: 30, latitude: 30 },
    16,
  );
  assert.equal(points.length, 17);
  assert.ok(near(points[0].altitude, 0) && near(points[16].altitude, 0));
  assert.ok(peak > 0);
});
