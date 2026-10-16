import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CAR_LAYER_KEYS,
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
  aimFor,
  shortPlaceName,
  viewModeOf,
  formatDistance,
  formatHeading,
  formatSpeed,
  isParkedJitter,
  metresPerPixel,
  layerCode,
  nearestContacts,
  nextViewMode,
  planLayerClicks,
  shouldResumeFollow,
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

test('followPose follows the vehicle itself; the driver scales the zoom', () => {
  const pose = followPose({ lat: 51.5, lon: -0.12, heading: 90, speed: 0 });
  assert.equal(pose.pitch, -45);
  assert.equal(pose.heading, 90);
  // Eye 1.8 km up at 45 degrees: range is 1800 / sin 45.
  near(pose.range, 1800 * Math.SQRT2, 1e-6);
  // No look-ahead: the pose is on the vehicle (aimFor centres it on screen).
  assert.equal(pose.lat, 51.5);
  assert.equal(pose.lon, -0.12);
  near(followPose({ lat: 0, lon: 0 }, { scale: 2 }).range, 3600 * Math.SQRT2, 1e-6);
  // A 60 degree view 2 km out spans 2309 m: 1.5 m a pixel on a 1536 px canvas.
  near(
    metresPerPixel(2000, Math.PI / 3, 1536, 576),
    (2 * 2000 * Math.tan(Math.PI / 6)) / 1536,
    1e-9,
  );
  near(
    metresPerPixel(2000, undefined, 1536, 576),
    metresPerPixel(2000, Math.PI / 3, 1536, 576),
    1e-12,
  );
});

test('AUTO is tilted and heading up, 2D flat and heading up, NORTH flat and north up', () => {
  const fix = { lat: 51.5, lon: -0.12, heading: 90, speed: 0 };
  const north = followPose(fix, { mode: 'north' });
  assert.equal(north.pitch, -90);
  assert.equal(north.heading, 0);
  near(north.range, 1800, 1e-6);
  // A degree short of straight down, so the camera keeps its heading.
  const flat = followPose(fix, { mode: '2d' });
  assert.equal(flat.pitch, -89);
  assert.equal(flat.heading, 90);
  for (const mode of ['auto', '3d', 'nope', undefined]) {
    const p = followPose(fix, { mode });
    assert.equal(p.pitch, -45);
    assert.equal(p.heading, 90);
  }
  assert.equal(nextViewMode('auto'), '2d');
  assert.equal(nextViewMode('2d'), 'north');
  assert.equal(nextViewMode('north'), 'auto');
  assert.equal(nextViewMode('3d'), '2d');
  assert.equal(viewModeOf('3d'), 'auto');
  assert.equal(viewModeOf('2d'), '2d');
  assert.equal(VIEW_MODES[nextViewMode('nope')].label, '2D');
});

// The camera model Cesium's lookAt uses (heading, pitch, range from the aim
// point), projecting a ground point to the screen: the check for aimFor.
function project(aim, at, { heading, pitch, range, fov, width, height }) {
  const r = Math.PI / 180;
  const east = distanceM(aim.lat, aim.lon, aim.lat, at.lon) * Math.sign(at.lon - aim.lon);
  const north =
    distanceM(aim.lat, aim.lon, at.lat, aim.lon) * Math.sign(at.lat - aim.lat);
  const h = heading * r;
  const p = pitch * r;
  const fwd = [Math.sin(h) * Math.cos(p), Math.cos(h) * Math.cos(p), Math.sin(p)];
  const right = [Math.cos(h), -Math.sin(h), 0];
  const up = [
    right[1] * fwd[2] - right[2] * fwd[1],
    right[2] * fwd[0] - right[0] * fwd[2],
    right[0] * fwd[1] - right[1] * fwd[0],
  ];
  const v = [east + fwd[0] * range, north + fwd[1] * range, fwd[2] * range];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const z = dot(v, fwd);
  const aspect = width / height;
  const half = Math.tan(fov / 2);
  const tanX = aspect >= 1 ? half : half * aspect;
  const tanY = aspect >= 1 ? half / aspect : half;
  const nx = dot(v, right) / z / tanX;
  const ny = dot(v, up) / z / tanY;
  return { x: ((nx + 1) * width) / 2, y: ((1 - ny) * height) / 2 };
}

test('aimFor puts the vehicle exactly where asked on screen (beside the routing card)', () => {
  const at = { lat: 33.7149, lon: -116.2103 };
  const view = { width: 793, height: 384, fov: Math.PI / 3 };
  // The free area right of a 280 px routing card: its middle.
  const x = 280 + (793 - 280) / 2;
  const y = 384 / 2;
  for (const [heading, pitch, range] of [
    [0, -45, 2546],
    [118, -45, 4000],
    [271, -45, 9192],
    [0, -90, 1800],
    [200, -90, 6500],
  ]) {
    const cam = { ...view, heading, pitch, range };
    const aim = aimFor(at, { ...cam, x, y });
    const s = project(aim, at, cam);
    near(s.x, x, 0.6);
    near(s.y, y, 0.6);
  }
  // The middle of the screen is the vehicle itself.
  const mid = aimFor(at, {
    ...view,
    heading: 30,
    pitch: -45,
    range: 3000,
    x: 396.5,
    y: 192,
  });
  near(distanceM(at.lat, at.lon, mid.lat, mid.lon), 0, 0.01);
  // Above the horizon there is nowhere to aim.
  assert.equal(
    aimFor(at, { ...view, heading: 0, pitch: -5, range: 3000, x: 396, y: 0 }),
    null,
  );
});

test('shortPlaceName keeps whole parts and never ends on a comma', () => {
  assert.equal(
    shortPlaceName('46211 JACKSON STREET, INDIO, CA, UNITED STATES'),
    '46211 JACKSON STREET, INDIO',
  );
  assert.equal(shortPlaceName('FANTASY SPRINGS CASINO'), 'FANTASY SPRINGS CASINO');
  assert.equal(
    shortPlaceName('THE VERY LONG NAME OF A PLACE WITHOUT COMMAS AT ALL'),
    'THE VERY LONG NAME OF A\u2026',
  );
  assert.equal(shortPlaceName('  a   b  '), 'a b');
  assert.equal(shortPlaceName(null), '');
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
  // Network fixes carry no speed: right after driving, 20 m on is the drive
  // going on (no hold), while parked it is still wander.
  const net = { ...poor, speed: null, accuracy: 30 };
  assert.equal(isParkedJitter({ ...prev, speed: 15 }, net), false);
  assert.equal(isParkedJitter({ ...prev, speed: 0 }, net), true);
  assert.equal(isParkedJitter({ ...prev, speed: null }, net), true);
});

test('free look returns to following after 10 s untouched, only while driving', () => {
  const base = { following: false, speed: 12, idleMs: 10_000 };
  assert.equal(shouldResumeFollow(base), true);
  assert.equal(shouldResumeFollow({ ...base, idleMs: 9_999 }), false);
  // Standing or creeping: the driver may be looking round the map.
  assert.equal(shouldResumeFollow({ ...base, speed: 2.5 }), false);
  assert.equal(shouldResumeFollow({ ...base, speed: null }), false);
  assert.equal(shouldResumeFollow({ ...base, speed: NaN }), false);
  // Already following, or previewing routes: nothing to do.
  assert.equal(shouldResumeFollow({ ...base, following: true }), false);
  assert.equal(shouldResumeFollow({ ...base, busy: true }), false);
});

test('the car-safe layers match the car LAYERS list in MapScreen.kt', () => {
  const kt = readFileSync(
    new URL(
      '../android/app/src/main/java/net/h4ch1/argus/car/MapScreen.kt',
      import.meta.url,
    ),
    'utf8',
  );
  const all = kt.slice(kt.indexOf('val ALL = listOf('), kt.indexOf('val PRESETS'));
  const keys = [...all.matchAll(/Layer\("([a-z0-9]+)"/g)].map((m) => m[1]);
  assert.deepEqual(keys, [...CAR_LAYER_KEYS]);
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
