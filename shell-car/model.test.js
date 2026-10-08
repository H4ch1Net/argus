import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  angleDelta,
  bearingDeg,
  cardinal,
  courseFor,
  destination,
  distanceM,
  followAltitude,
  followPose,
  formatDistance,
  formatHeading,
  formatSpeed,
  layerCode,
  nearestContacts,
  planLayerClicks,
  speedBetween,
  unitsForLocale,
} from './model.js';

const near = (a, b, eps) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b} (±${eps})`);

test('angleDelta takes the short way round', () => {
  assert.equal(angleDelta(350, 10), 20);
  assert.equal(angleDelta(10, 350), -20);
  assert.equal(angleDelta(0, 180), 180);
  assert.equal(angleDelta(90, 90), 0);
});

test('distance, bearing and destination agree', () => {
  // One degree of latitude is about 111.2 km.
  near(distanceM(0, 0, 1, 0), 111_195, 50);
  near(bearingDeg(0, 0, 1, 0), 0, 1e-9);
  near(bearingDeg(0, 0, 0, 1), 90, 1e-9);
  const p = destination(48.8566, 2.3522, 135, 12_000);
  near(distanceM(48.8566, 2.3522, p.lat, p.lon), 12_000, 0.5);
  near(bearingDeg(48.8566, 2.3522, p.lat, p.lon), 135, 0.01);
  // Wraps across the antimeridian.
  const q = destination(0, 179.99, 90, 5000);
  assert.ok(q.lon < -179 && q.lon >= -180, `lon ${q.lon}`);
});

test('the follow view rises from 3 km to 8 km with speed', () => {
  assert.equal(followAltitude(0), 3000);
  assert.equal(followAltitude(NaN), 3000);
  assert.equal(followAltitude(33), 8000);
  assert.equal(followAltitude(60), 8000);
  const mid = followAltitude(17.5);
  assert.ok(mid > 5000 && mid < 6000, String(mid));
});

test('followPose looks ahead of the vehicle along its heading', () => {
  const pose = followPose({ lat: 51.5, lon: -0.12, heading: 90, speed: 0 });
  assert.equal(pose.pitch, -45);
  assert.equal(pose.heading, 90);
  // Eye 3 km up at 45 degrees: range is 3000 / sin 45.
  near(pose.range, 3000 * Math.SQRT2, 1e-6);
  // The look point is 750 m east of the vehicle.
  near(distanceM(51.5, -0.12, pose.lat, pose.lon), 750, 0.5);
  near(bearingDeg(51.5, -0.12, pose.lat, pose.lon), 90, 0.05);
  // The driver's zoom scales it.
  near(followPose({ lat: 0, lon: 0 }, { scale: 2 }).range, 6000 * Math.SQRT2, 1e-6);
});

test('courseFor trusts the fix heading only while moving', () => {
  const prev = { lat: 0, lon: 0, heading: 45 };
  assert.equal(courseFor(prev, { lat: 0, lon: 0, heading: 200, speed: 10 }), 200);
  // Slow with a jittery heading: keep the previous one.
  assert.equal(courseFor(prev, { lat: 0, lon: 0.00001, heading: 200, speed: 0.4 }), 45);
  // No heading at all, but it moved: the course between the fixes.
  near(courseFor(prev, { lat: 0, lon: 0.001, heading: null, speed: null }), 90, 0.01);
  assert.equal(courseFor(null, { lat: 0, lon: 0, heading: null, speed: 0 }), 0);
});

test('speedBetween derives a speed from two timed fixes', () => {
  const a = { lat: 0, lon: 0, t: 0 };
  const b = { lat: 0.001, lon: 0, t: 10_000 };
  near(speedBetween(a, b), 11.12, 0.01);
  assert.equal(speedBetween(null, b), 0);
  assert.equal(speedBetween(b, b), 0);
});

test('units follow the locale region', () => {
  assert.equal(unitsForLocale('en-US'), 'imperial');
  assert.equal(unitsForLocale('en_GB'), 'imperial');
  assert.equal(unitsForLocale('de-DE'), 'metric');
  assert.equal(unitsForLocale('en'), 'metric');
  assert.equal(unitsForLocale('zh-Hant-TW'), 'metric');
  assert.equal(unitsForLocale(undefined), 'metric');
});

test('readout formats', () => {
  assert.equal(formatSpeed(24.17), '087 KM/H');
  assert.equal(formatSpeed(24.17, 'imperial'), '054 MPH');
  assert.equal(formatSpeed(NaN), '--- KM/H');
  assert.equal(formatDistance(850), '850M');
  assert.equal(formatDistance(12_400), '12KM');
  assert.equal(formatDistance(4_440), '4.4KM');
  assert.equal(formatDistance(12_400, 'imperial'), '7.7MI');
  assert.equal(formatDistance(100, 'imperial'), '328FT');
  assert.equal(formatDistance(undefined), '--');
  assert.equal(formatHeading(245), '245 SW');
  assert.equal(formatHeading(359.7), '000 N');
  assert.equal(formatHeading(null), '--- --');
  assert.equal(cardinal(-90), 'W');
  assert.equal(layerCode('flights'), 'FLT');
  assert.equal(layerCode('bikeshare'), 'BIK');
});

test('nearestContacts sorts by range and drops contacts without a position', () => {
  const here = { lat: 0, lon: 0 };
  const list = [
    { id: 1, lat: 0, lon: 0.3 },
    { id: 2, lat: 0, lon: 0.1 },
    { id: 3 },
    { id: 4, lat: 0.2, lon: 0 },
  ];
  const out = nearestContacts(list, here, 2);
  assert.deepEqual(
    out.map((c) => c.id),
    [2, 4],
  );
  near(out[0].bearingDeg, 90, 1e-6);
  near(out[1].bearingDeg, 0, 1e-6);
  // No position for the vehicle: the given order, no range.
  const plain = nearestContacts(list, null, 5);
  assert.deepEqual(
    plain.map((c) => c.id),
    [1, 2, 4],
  );
  assert.equal(plain[0].distanceM, null);
});

test('planLayerClicks presses only the rows that differ', () => {
  const rows = [
    { key: 'flights', on: true },
    { key: 'quakes', on: false },
    { key: 'radar', on: false, loading: true },
    { key: 'transit', on: true },
    { key: 'trafficcams', on: false },
  ];
  assert.deepEqual(planLayerClicks(rows, ['flights', 'quakes', 'radar']), [
    'quakes',
    'transit',
  ]);
  // A loading row that is no longer wanted is pressed (that switches it off).
  assert.deepEqual(planLayerClicks(rows, ['flights', 'transit']), ['radar']);
  // Unknown keys are ignored.
  assert.deepEqual(planLayerClicks(rows, ['flights', 'transit', 'radar', 'nope']), []);
});
