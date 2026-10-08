import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeShape,
  createDrawSession,
  addVertex,
  removeLastVertex,
  finishReason,
  canFinish,
  greatCircleM,
  initialBearingDeg,
  pathLengthM,
  ringAreaM2,
  ringCentroid,
  unwrapLongitudes,
  wrapLongitude,
  closeRing,
  formatMeasure,
  formatLength,
  formatArea,
  finishShape,
  MAX_VERTICES,
} from './geometry.js';

test('shape names normalize to area, line or pin', () => {
  assert.equal(normalizeShape('route'), 'line');
  assert.equal(normalizeShape('measure'), 'line');
  assert.equal(normalizeShape('marker'), 'pin');
  assert.equal(normalizeShape('polygon'), 'area');
  assert.equal(normalizeShape(undefined), 'area');
});

test('vertex rules: off-globe refused, double taps merged, pins move, ceiling holds', () => {
  const s = createDrawSession('line');
  assert.deepEqual(addVertex(s, { lon: 200, lat: 0 }), {
    added: false,
    reason: 'invalid',
  });
  assert.deepEqual(addVertex(s, { lon: NaN, lat: 0 }), {
    added: false,
    reason: 'invalid',
  });
  assert.deepEqual(addVertex(s, { lon: 0, lat: 0 }), { added: true });
  // ~0.1 m away: the second half of a double tap.
  assert.deepEqual(addVertex(s, { lon: 0.000001, lat: 0 }), {
    added: false,
    reason: 'duplicate',
  });
  assert.equal(s.vertices.length, 1);
  assert.equal(removeLastVertex(s), true);
  assert.equal(removeLastVertex(s), false);

  const pin = createDrawSession('pin');
  addVertex(pin, { lon: 1, lat: 1 });
  addVertex(pin, { lon: 2, lat: 2, height: 30 });
  assert.deepEqual(pin.vertices, [{ lon: 2, lat: 2 }]);

  const big = createDrawSession('area');
  for (let i = 0; i < MAX_VERTICES; i += 1) addVertex(big, { lon: i * 0.001, lat: 0 });
  assert.deepEqual(addVertex(big, { lon: 5, lat: 5 }), { added: false, reason: 'full' });
});

test('finish rules per shape: too few, degenerate, ok', () => {
  const area = createDrawSession('area');
  addVertex(area, { lon: 0, lat: 0 });
  addVertex(area, { lon: 0.01, lat: 0 });
  assert.equal(finishReason(area), 'too-few');
  addVertex(area, { lon: 0.02, lat: 0 }); // collinear
  assert.equal(finishReason(area), 'degenerate');
  addVertex(area, { lon: 0.02, lat: 0.01 });
  assert.equal(canFinish(area), true);
  const line = createDrawSession('line');
  addVertex(line, { lon: 0, lat: 0 });
  assert.equal(finishReason(line), 'too-few');
  addVertex(line, { lon: 0, lat: 0.001 });
  assert.equal(finishReason(line), 'ok');
  assert.equal(finishReason(null), 'invalid');
  assert.equal(
    finishReason({ shape: 'line', vertices: [{ lon: 0, lat: 99 }] }),
    'invalid',
  );
});

test('great-circle length and bearing', () => {
  // One degree of latitude is ~111.2 km on the mean sphere.
  assert.ok(
    Math.abs(greatCircleM({ lon: 0, lat: 0 }, { lon: 0, lat: 1 }) - 111_195) < 10,
  );
  const london = { lon: -0.1278, lat: 51.5074 };
  const paris = { lon: 2.3522, lat: 48.8566 };
  assert.ok(Math.abs(greatCircleM(london, paris) / 1000 - 343.6) < 1);
  assert.ok(Math.abs(initialBearingDeg(london, paris) - 148.1) < 0.5);
  assert.ok(
    Math.abs(initialBearingDeg({ lon: 0, lat: 0 }, { lon: -1, lat: 0 }) - 270) < 1e-9,
  );
  assert.equal(
    pathLengthM([
      { lon: 0, lat: 0 },
      { lon: 0, lat: 1 },
      { lon: 0, lat: 2 },
    ]).toFixed(0),
    (2 * greatCircleM({ lon: 0, lat: 0 }, { lon: 0, lat: 1 })).toFixed(0),
  );
});

test('shoelace area on a local grid, in m2', () => {
  // A 0.01 x 0.01 degree square on the equator: ~1113.2 m on a side.
  const sq = [
    { lon: 0, lat: 0 },
    { lon: 0.01, lat: 0 },
    { lon: 0.01, lat: 0.01 },
    { lon: 0, lat: 0.01 },
  ];
  assert.ok(Math.abs(ringAreaM2(sq) - 1113.2 ** 2) < 50);
  // Winding does not matter.
  assert.equal(ringAreaM2(sq).toFixed(3), ringAreaM2([...sq].reverse()).toFixed(3));
  assert.equal(ringAreaM2(sq.slice(0, 2)), 0);
});

test('the antimeridian does not tear area, centroid or length', () => {
  const seam = [
    { lon: 179.995, lat: 0 },
    { lon: -179.995, lat: 0 },
    { lon: -179.995, lat: 0.01 },
    { lon: 179.995, lat: 0.01 },
  ];
  const plain = seam.map((v) => ({ ...v, lon: v.lon > 0 ? 0 : 0.01 }));
  assert.ok(Math.abs(ringAreaM2(seam) - ringAreaM2(plain)) < 1);
  const c = ringCentroid(seam);
  assert.ok(Math.abs(Math.abs(c.lon) - 180) < 1e-9);
  assert.ok(Math.abs(c.lat - 0.005) < 1e-12);
  assert.deepEqual(
    unwrapLongitudes([
      { lon: 179, lat: 0 },
      { lon: -179, lat: 0 },
    ]).map((v) => v.lon),
    [179, 181],
  );
  assert.equal(wrapLongitude(181), -179);
  assert.equal(wrapLongitude(-181), 179);
  assert.equal(wrapLongitude(0.0005), 0.0005);
  assert.equal(wrapLongitude(180), -180);
  assert.equal(ringCentroid([]), null);
});

test('formatMeasure is terse uppercase text', () => {
  assert.equal(formatLength(850.4), 'LEN 850 M');
  assert.equal(formatLength(12_400), 'LEN 12.4 KM');
  assert.equal(formatLength(431_200), 'LEN 431 KM');
  assert.equal(formatArea(4500.2), 'AREA 4500 M2');
  assert.equal(formatArea(3.2e6), 'AREA 3.20 KM2');
  assert.equal(formatArea(1.25e9), 'AREA 1250 KM2');
  const line = createDrawSession('line');
  addVertex(line, { lon: 0, lat: 0 });
  addVertex(line, { lon: 0, lat: 0.1115 });
  assert.equal(formatMeasure(line), 'LEN 12.4 KM');
  const pin = createDrawSession('pin');
  addVertex(pin, { lon: -73.98571, lat: 40.74844 });
  assert.equal(formatMeasure(pin), 'PIN 40.7484N 73.9857W');
  assert.equal(formatMeasure(createDrawSession('area')), '');
});

test('finishShape closes an area ring and carries centroid, measure and label', () => {
  const area = createDrawSession('area');
  for (const [lon, lat] of [
    [0, 0],
    [0.02, 0],
    [0.02, 0.02],
  ])
    addVertex(area, { lon, lat });
  const done = finishShape(area, { label: '  Site A ', color: 'amber' });
  assert.equal(done.shape, 'area');
  assert.deepEqual(done.coordinates.at(-1), done.coordinates[0]);
  assert.equal(done.coordinates.length, 4);
  assert.equal(done.label, 'Site A');
  assert.equal(done.color, 'amber');
  assert.match(done.measure, /^AREA \d+\.\d\d KM2$/);
  assert.ok(done.areaM2 > 2e6);
  assert.equal(finishShape(createDrawSession('line')), null);
  assert.deepEqual(closeRing([[0, 0]]), [[0, 0]]);
});
