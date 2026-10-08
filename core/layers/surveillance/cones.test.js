import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBearing,
  parseDirections,
  cameraCones,
  sectorDegrees,
  circleDegrees,
  coneScale,
  bearingLabel,
  describeFacing,
  directionTag,
  CONE_MAX_HEIGHT_M,
} from './cones.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

test('bearings: degrees, negatives and 16-point compass letters', () => {
  assert.equal(parseBearing('90'), 90);
  assert.equal(parseBearing(' 45.5 '), 45.5);
  assert.equal(parseBearing('-45'), 315);
  assert.equal(parseBearing('360'), 0);
  assert.equal(parseBearing('n'), 0);
  assert.equal(parseBearing('NE'), 45);
  assert.equal(parseBearing('SSW'), 202.5);
  assert.equal(parseBearing('NNW'), 337.5);
  assert.equal(parseBearing('forward'), null);
  assert.equal(parseBearing(''), null);
  assert.equal(parseBearing('9999'), null);
});

test('direction values: single, multiple, ranges, and noise', () => {
  assert.deepEqual(parseDirections('90'), [{ headingDeg: 90, fovDeg: null }]);
  assert.deepEqual(parseDirections('90;270'), [
    { headingDeg: 90, fovDeg: null },
    { headingDeg: 270, fovDeg: null },
  ]);
  assert.deepEqual(parseDirections('45-90'), [{ headingDeg: 67.5, fovDeg: 45 }]);
  // A range across north, and one written in compass letters.
  assert.deepEqual(parseDirections('350-10'), [{ headingDeg: 0, fovDeg: 20 }]);
  assert.deepEqual(parseDirections('NE-SE'), [{ headingDeg: 90, fovDeg: 90 }]);
  assert.deepEqual(parseDirections('-30-30'), [{ headingDeg: 0, fovDeg: 60 }]);
  assert.deepEqual(parseDirections('E; nonsense ;W'), [
    { headingDeg: 90, fovDeg: null },
    { headingDeg: 270, fovDeg: null },
  ]);
  assert.deepEqual(parseDirections('90-90'), [], 'zero-width range');
  assert.deepEqual(parseDirections(null), []);
  assert.equal(parseDirections('1;2;3;4;5;6;7;8;9;10').length, 8, 'capped');
});

test('the first direction tag present wins', () => {
  assert.equal(directionTag({ direction: '10', 'camera:direction': '20' }), '20');
  assert.equal(directionTag({ 'surveillance:direction': 'S' }), 'S');
  assert.equal(directionTag({ direction: '  ' }), null);
});

test('cones per camera: ALPR defaults, camera defaults, rings', () => {
  const at = (tags) => ({
    position: { longitude: -122.4, latitude: 37.8 },
    meta: { tags },
  });
  const alpr = cameraCones(at({ 'surveillance:type': 'ALPR', direction: 'N' }));
  assert.equal(alpr.alpr, true);
  assert.equal(alpr.rangeM, 60);
  assert.deepEqual(alpr.cones, [{ headingDeg: 0, fovDeg: 60 }]);
  assert.equal(alpr.ring, false);
  const cam = cameraCones(at({ 'camera:direction': '90;270', 'camera:angle': '15' }));
  assert.equal(cam.rangeM, 80);
  assert.deepEqual(
    cam.cones.map((c) => c.fovDeg),
    [70, 70],
    'camera:angle is tilt, never the width',
  );
  const range = cameraCones(at({ 'camera:direction': '45-135' }));
  assert.deepEqual(range.cones, [{ headingDeg: 90, fovDeg: 90 }]);
  const dome = cameraCones(at({ 'camera:type': 'dome' }));
  assert.equal(dome.ring, true);
  assert.deepEqual(dome.cones, []);
  assert.equal(cameraCones({ position: {}, meta: {} }), null);
});

test('a sector starts at the camera and its arc lies at the range, centred on the heading', () => {
  const lon = 10;
  const lat = 50;
  const ring = sectorDegrees(lon, lat, 90, 60, 100, 6);
  assert.equal(ring.length, 2 * (1 + 7));
  assert.equal(ring[0], lon);
  assert.equal(ring[1], lat);
  const metres = (x, y) => {
    const dx = ((x - lon) * Math.PI * 6378137 * Math.cos((lat * Math.PI) / 180)) / 180;
    const dy = ((y - lat) * Math.PI * 6378137) / 180;
    return {
      d: Math.hypot(dx, dy),
      bearing: ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360,
    };
  };
  for (let i = 2; i < ring.length; i += 2) {
    assert.ok(near(metres(ring[i], ring[i + 1]).d, 100, 1e-6));
  }
  // The middle arc point is due east; the edges at 60 and 120.
  assert.ok(near(metres(ring[8], ring[9]).bearing, 90, 1e-6));
  assert.ok(near(metres(ring[2], ring[3]).bearing, 60, 1e-6));
  assert.ok(near(metres(ring[14], ring[15]).bearing, 120, 1e-6));
  // Default segment count grows with the width.
  assert.ok(
    sectorDegrees(0, 0, 0, 120, 50).length > sectorDegrees(0, 0, 0, 30, 50).length,
  );
});

test('a ring is a closed-able circle at the range', () => {
  const c = circleDegrees(0, 0, 80, 12);
  assert.equal(c.length, 24);
  for (let i = 0; i < c.length; i += 2) {
    const d = Math.hypot(c[i], c[i + 1]) * (Math.PI / 180) * 6378137;
    assert.ok(near(d, 80, 1e-6));
  }
});

test('cones grow in coarse bands when zoomed out and hide past the ceiling', () => {
  assert.equal(coneScale(500), 1);
  assert.equal(coneScale(3000), 1);
  assert.ok(coneScale(5000) > 1);
  assert.ok(coneScale(20_000) >= coneScale(10_000));
  assert.equal(coneScale(CONE_MAX_HEIGHT_M + 1), 0);
  // Bands: nearby heights share one scale, so the batch is not rebuilt.
  assert.equal(coneScale(7000), coneScale(11_000));
});

test('the card line names the facing and the width', () => {
  assert.equal(bearingLabel(90), '090 E');
  assert.equal(bearingLabel(359.6), '000 N');
  const one = { ring: false, cones: [{ headingDeg: 90, fovDeg: 60 }] };
  assert.equal(describeFacing(one), 'Faces 090 E, 60 deg view');
  const two = {
    ring: false,
    cones: [
      { headingDeg: 90, fovDeg: 70 },
      { headingDeg: 270, fovDeg: 70 },
    ],
  };
  assert.equal(describeFacing(two), 'Faces 090 E, 270 W, 70 deg view');
  const mixed = {
    ring: false,
    cones: [
      { headingDeg: 0, fovDeg: 20 },
      { headingDeg: 180, fovDeg: 70 },
    ],
  };
  assert.equal(describeFacing(mixed), 'Faces 000 N (20 deg), 180 S (70 deg)');
  assert.match(describeFacing({ ring: true, cones: [] }), /^Not mapped/);
});
