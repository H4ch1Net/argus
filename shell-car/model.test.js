import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VIEW_MODES,
  angleDelta,
  bearingDeg,
  cardinal,
  carResolutionScale,
  courseFor,
  destination,
  distanceM,
  followAltitude,
  followFrameMs,
  followPose,
  formatDistance,
  formatHeading,
  formatSpeed,
  isParkedJitter,
  layerCode,
  nearestContacts,
  nextViewMode,
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

test('the follow view rises from 1.8 km to 6.5 km with speed', () => {
  assert.equal(followAltitude(0), 1800);
  assert.equal(followAltitude(NaN), 1800);
  assert.equal(followAltitude(33), 6500);
  assert.equal(followAltitude(60), 6500);
  const mid = followAltitude(17.5);
  assert.ok(mid > 3800 && mid < 4400, String(mid));
});

test('followPose looks ahead of the vehicle along its heading', () => {
  const pose = followPose({ lat: 51.5, lon: -0.12, heading: 90, speed: 0 });
  assert.equal(pose.pitch, -45);
  assert.equal(pose.heading, 90);
  // Eye 1.8 km up at 45 degrees: range is 1800 / sin 45.
  near(pose.range, 1800 * Math.SQRT2, 1e-6);
  // The look point is 450 m east of the vehicle.
  near(distanceM(51.5, -0.12, pose.lat, pose.lon), 450, 0.5);
  near(bearingDeg(51.5, -0.12, pose.lat, pose.lon), 90, 0.05);
  // The driver's zoom scales it.
  near(followPose({ lat: 0, lon: 0 }, { scale: 2 }).range, 3600 * Math.SQRT2, 1e-6);
});

test('the flat views look straight down; north up ignores the course', () => {
  const fix = { lat: 51.5, lon: -0.12, heading: 90, speed: 0 };
  const flat = followPose(fix, { mode: '2d' });
  assert.equal(flat.pitch, -90);
  assert.equal(flat.heading, 90);
  near(flat.range, 1800, 1e-6);
  const north = followPose(fix, { mode: 'north' });
  assert.equal(north.pitch, -90);
  assert.equal(north.heading, 0);
  // An unknown mode is the 3D view.
  assert.equal(followPose(fix, { mode: 'nope' }).pitch, -45);
  assert.equal(nextViewMode('3d'), '2d');
  assert.equal(nextViewMode('2d'), 'north');
  assert.equal(nextViewMode('north'), '3d');
  assert.equal(VIEW_MODES[nextViewMode('nope')].label, '3D');
});

test('carResolutionScale holds a car display to its pixel budget', () => {
  // 1920x720 at density 1.25 (CSS 1536x576): about 1.1 MP, not 1.38.
  const s = carResolutionScale(1536, 576, 1.25);
  const px = 1536 * 576 * (1.25 * s) ** 2;
  near(px, 1_100_000, 1000);
  // A wide, dense screen (2560x1080 at density 1.875) is held to the same.
  const t = carResolutionScale(1365, 576, 1.875);
  assert.ok(1365 * 576 * (1.875 * t) ** 2 <= 1_100_000 * 1.01);
  // Never below 0.75 nor above 1.25 rendered pixels per CSS pixel.
  near(carResolutionScale(4000, 2000, 1) * 1, 0.75, 1e-9);
  near(carResolutionScale(400, 200, 2) * 2, 1.25, 1e-9);
});

test('followFrameMs: 20 updates a second moving or turning, 12 creeping', () => {
  near(followFrameMs(25), 50, 1e-9);
  near(followFrameMs(1, 10), 50, 1e-9);
  near(followFrameMs(1, 0.5), 1000 / 12, 1e-9);
  near(followFrameMs(NaN), 1000 / 12, 1e-9);
});

test('isParkedJitter holds the view still for GPS wander, not for driving', () => {
  const prev = { lat: 51.5, lon: -0.12 };
  // 5 m of wander, standing still: jitter.
  const wander = destination(51.5, -0.12, 30, 5);
  assert.equal(isParkedJitter(prev, { ...wander, speed: 0, accuracy: 6 }), true);
  // 40 m away: a real move, even if the fix says speed 0.
  const away = destination(51.5, -0.12, 30, 40);
  assert.equal(isParkedJitter(prev, { ...away, speed: 0, accuracy: 6 }), false);
  // Moving: never jitter.
  assert.equal(isParkedJitter(prev, { ...wander, speed: 3, accuracy: 6 }), false);
  // A poor fix widens the tolerance, up to 25 m.
  const poor = destination(51.5, -0.12, 30, 20);
  assert.equal(isParkedJitter(prev, { ...poor, speed: 0, accuracy: 60 }), true);
  assert.equal(isParkedJitter(null, { ...poor, speed: 0 }), false);
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

test('nearestContacts puts what is ahead first when the course is known', () => {
  const here = { lat: 0, lon: 0 };
  const list = [
    { id: 'behind-near', lat: -0.01, lon: 0 }, // 1.1 km south
    { id: 'ahead-far', lat: 0.05, lon: 0 }, // 5.6 km north
    { id: 'ahead-near', lat: 0.02, lon: 0.005 }, // ~2.3 km north
    { id: 'side', lat: 0, lon: 0.03 }, // 3.3 km east: 90 degrees off a north course
  ];
  const north = nearestContacts(list, here, 3, { heading: 0 });
  assert.deepEqual(
    north.map((c) => c.id),
    ['ahead-near', 'ahead-far', 'behind-near'],
  );
  assert.equal(north[0].ahead, true);
  assert.equal(north[2].ahead, false);
  // Driving south, the same list turns round.
  assert.equal(nearestContacts(list, here, 1, { heading: 180 })[0].id, 'behind-near');
  // No course: nearest first, as before.
  assert.equal(nearestContacts(list, here, 1)[0].id, 'behind-near');
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
